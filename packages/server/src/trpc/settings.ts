// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** App settings (admin-only): school name, currency, the report-card merit toggle, email (SMTP), and
 *  the Stripe account (from the OS vault) that tuition charges go through. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { isNotNull } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import { families, paymentMethods, autopayEnrollments } from '../db/schema';
import { SETTING_KEYS, getSchoolName, getCurrency, getSelfRegistrationEnabled, getExternalPaymentsEnabled, setSetting, getSmtp, setSmtp, getChosenStripeAccount, setChosenStripeAccount } from '../settings';
import { audit } from '../audit';
import { verifySmtp, sendMail, smtpConfigured } from '../mail/smtp';
import { mailAvailable } from '../mail/notify';
import { portalBase } from '../auth/invites';
import { cachedPublicUrl } from '../fabric/platform';
import { fabricConfigured, config } from '../config';
import { testEmail } from '../mail/templates';
import { stripeReady, stripeAccountId, loadStripeKeys } from '../payments/stripe';
import { fetchStripeAccounts } from '../fabric/platform';

export const settingsRouter = router({
  get: adminProcedure.query(() => ({
    schoolName: getSchoolName(),
    currency: getCurrency(),
    selfRegistration: getSelfRegistrationEnabled(),
    externalPayments: getExternalPaymentsEnabled(),
  })),

  set: adminProcedure
    .input(z.object({ schoolName: z.string().trim().max(160).optional(), currency: z.enum(['usd', 'cad', 'gbp', 'eur']).optional(), selfRegistration: z.boolean().optional(), externalPayments: z.boolean().optional() }))
    .mutation(({ ctx, input }) => {
      if (input.schoolName !== undefined) setSetting(SETTING_KEYS.schoolName, input.schoolName);
      if (input.currency !== undefined) setSetting(SETTING_KEYS.currency, input.currency);
      if (input.selfRegistration !== undefined) setSetting(SETTING_KEYS.selfRegistration, input.selfRegistration ? '1' : '0');
      if (input.externalPayments !== undefined) setSetting(SETTING_KEYS.externalPayments, input.externalPayments ? '1' : '0');
      audit(auditActor(ctx), 'settings.update', { entity: 'settings', detail: { keys: Object.keys(input) } });
      return { ok: true as const };
    }),

  /**
   * Can this install actually reach a parent? Every "invite/reset didn't arrive" report comes down to
   * one of these three, and until now all three failed SILENTLY:
   *   - no absolute public URL  → invite/reset links are un-emailable (Remote access is off)
   *   - no mail transport       → nothing can be sent at all
   *   - no notification webhook → staff alerts go nowhere
   * Read-only diagnostics; admin OR finance, because finance is who sends invites.
   */
  linkStatus: adminOrFinanceProcedure.query(() => {
    const base = portalBase();
    const live = cachedPublicUrl();
    return {
      fabric: fabricConfigured(),
      publicUrl: base,
      /** Where the URL came from — `platform` is authoritative, `env` is the install-time mirror. */
      publicUrlSource: live ? ('platform' as const) : config.omosPublicUrl ? ('env' as const) : ('none' as const),
      smtp: smtpConfigured(),
      /** We declare `email: true`, so the platform can send for us whenever the Fabric is wired up. */
      platformMail: fabricConfigured(),
      mailAvailable: mailAvailable(),
      selfRegistrationOn: getSelfRegistrationEnabled(),
      /** The toggle being on is not enough — the verify link is emailed. */
      selfRegistrationAvailable: getSelfRegistrationEnabled() && mailAvailable() && !!base,
    };
  }),

  // ── Email (SMTP) — the password is WRITE-ONLY: never returned to the client, never audited (§10/§14).
  smtpGet: adminProcedure.query(() => {
    const c = getSmtp();
    return {
      configured: !!c,
      host: c?.host ?? '',
      port: c?.port ?? 587,
      secure: c?.secure ?? false,
      user: c?.user ?? '',
      from: c?.from ?? '',
      hasPassword: !!c?.pass, // so the UI can show "•••• (unchanged)" instead of asking every time
    };
  }),

  smtpSet: adminProcedure
    .input(
      z.object({
        host: z.string().trim().max(255),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        user: z.string().trim().max(255),
        from: z.string().trim().min(1).max(320),
        // Omitted/empty → keep the stored password (write-only field; the admin only re-types to change it).
        password: z.string().max(255).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const existing = getSmtp();
      const pass = input.password && input.password.length > 0 ? input.password : (existing?.pass ?? '');
      setSmtp({ host: input.host, port: input.port, secure: input.secure, user: input.user, pass, from: input.from });
      // Audit keys only — NEVER the password (mirror settings.update).
      audit(auditActor(ctx), 'settings.smtp.update', { entity: 'settings', detail: { host: input.host, port: input.port, secure: input.secure, passwordChanged: !!input.password } });
      return { ok: true as const };
    }),

  /** Verify the connection, then send a probe to `to`. Friendly error on failure. */
  smtpTest: adminProcedure.input(z.object({ to: z.string().trim().email().max(320) })).mutation(async ({ input }) => {
    const v = await verifySmtp();
    if (!v.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: v.error ? `Couldn't connect: ${v.error}` : "Couldn't connect to the mail server." });
    const m = testEmail(getSchoolName());
    const sent = await sendMail({ to: input.to, subject: m.subject, text: m.text, html: m.html });
    if (!sent) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Connected, but the test email could not be sent.' });
    return { ok: true as const };
  }),

  // ── Payments: which OS-vault Stripe account tuition charges go through (§10). The account LIST comes
  // from OpenMasjidOS (id + label only — keys never touch this router); the admin picks one and it
  // applies immediately (no restart). Card keys stay in server memory (payments/stripe.ts).
  stripeAccountsGet: adminProcedure.query(async () => {
    const accounts = await fetchStripeAccounts();
    return { accounts, chosenId: getChosenStripeAccount(), ready: stripeReady(), activeId: stripeAccountId() };
  }),
  stripeAccountSet: adminProcedure.input(z.object({ accountId: z.string().trim().max(120) })).mutation(async ({ ctx, input }) => {
    const prevActive = stripeAccountId(); // the account currently loaded (null if none)
    setChosenStripeAccount(input.accountId);
    const ok = await loadStripeKeys(); // apply the choice now — reload keys for the new account
    // A successful switch to a DIFFERENT account invalidates every family's saved Stripe state: their
    // Customer + saved cards live on the OLD account and can't be charged on the new one. Clear them so
    // pay-now mints a fresh Customer and parents re-add cards; autopay is turned off. The ledger and
    // payment history are account-agnostic and untouched.
    let reset = false;
    if (ok && prevActive && prevActive !== stripeAccountId()) {
      const ts = new Date();
      db.update(autopayEnrollments).set({ enabled: false, defaultPmId: null, updatedAt: ts }).run(); // null the FK before deleting PMs
      db.delete(paymentMethods).run();
      db.update(families).set({ stripeCustomerId: null, updatedAt: ts }).where(isNotNull(families.stripeCustomerId)).run();
      reset = true;
    }
    audit(auditActor(ctx), 'settings.stripe.account', { entity: 'settings', detail: { accountId: input.accountId, reset } });
    return { ok, ready: stripeReady(), reset };
  }),
});
