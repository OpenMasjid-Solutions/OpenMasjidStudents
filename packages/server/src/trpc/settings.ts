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
import { SETTING_KEYS, getSchoolName, getCurrency, getSelfRegistrationEnabled, getExternalPaymentsEnabled, setSetting, getChosenStripeAccount, setChosenStripeAccount, getSchoolLogo, setSchoolLogo } from '../settings';
import { audit } from '../audit';
import { mailAvailable, sendTestEmail } from '../mail/notify';
import { portalBase } from '../auth/invites';
import { cachedPublicUrl } from '../fabric/platform';
import { fabricConfigured, config } from '../config';
import { stripeReady, stripeAccountId, loadStripeKeys } from '../payments/stripe';
import { fetchStripeAccounts } from '../fabric/platform';

export const settingsRouter = router({
  get: adminProcedure.query(() => ({
    schoolName: getSchoolName(),
    currency: getCurrency(),
    selfRegistration: getSelfRegistrationEnabled(),
    externalPayments: getExternalPaymentsEnabled(),
    logo: getSchoolLogo(),
  })),

  /**
   * Upload (or clear, with `null`) the school logo — it goes on printed statements and every
   * outgoing email, so a family sees the madrasa's own mark rather than generic text.
   *
   * The browser sends a `data:` URI it built from the chosen file. The server re-validates by MAGIC
   * BYTES rather than trusting the declared type, because this value is later served back over HTTP
   * with that content type (§14). Anything else is refused with a sentence the admin can act on.
   */
  logoSet: adminProcedure.input(z.object({ dataUri: z.string().max(1_400_000).nullable() })).mutation(({ ctx, input }) => {
    try {
      setSchoolLogo(input.dataUri);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'That file isn’t a PNG, JPEG or WebP image under 512 KB. Try exporting it again.' });
    }
    audit(auditActor(ctx), input.dataUri ? 'settings.logoSet' : 'settings.logoClear', { entity: 'settings' });
    return { ok: true as const };
  }),

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
      /** Kept for shape stability; always false now that the app has no SMTP of its own. */
      smtp: false as const,
      /** We declare `email: true`, so the platform can send for us whenever the Fabric is wired up. */
      platformMail: fabricConfigured(),
      mailAvailable: mailAvailable(),
      selfRegistrationOn: getSelfRegistrationEnabled(),
      /** The toggle being on is not enough — the verify link is emailed. */
      selfRegistrationAvailable: getSelfRegistrationEnabled() && mailAvailable() && !!base,
    };
  }),

  /**
   * Send a test email through OpenMasjidOS.
   *
   * There are no SMTP settings in this app any more — the OS owns the mail provider and the From
   * address, so a masjid configures email once, there. What is still worth having is a way to prove it
   * reaches somebody, which is what this is.
   *
   * The platform answers HTTP 200 with `{sent:false, reason}` when it has no provider configured, so a
   * failure here is reported as a real failure rather than a cheerful success.
   *
   * It goes through `sendTestEmail` in mail/notify.ts rather than composing here, so the test carries
   * the school's logo exactly like a real invite or receipt — the whole point is seeing what a parent
   * will see.
   */
  mailTest: adminProcedure.input(z.object({ to: z.string().trim().email().max(320) })).mutation(async ({ ctx, input }) => {
    if (!fabricConfigured()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This app isn’t connected to OpenMasjidOS yet, so it can’t send email.' });
    }
    const sent = await sendTestEmail(input.to);
    audit(auditActor(ctx), 'settings.mailTest', { entity: 'settings', detail: { sent } });
    if (!sent) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'OpenMasjidOS couldn’t send it. Check that email is set up in OpenMasjidOS → Settings, then try again.',
      });
    }
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
