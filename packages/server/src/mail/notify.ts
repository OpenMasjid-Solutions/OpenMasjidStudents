// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * High-level transactional senders (CLAUDE.md §4/§13). One place that composes the school name + the
 * right template + the transport, so routers stay thin. Every function is BEST-EFFORT and no-ops when
 * SMTP is unconfigured (returns false / 0) — callers degrade gracefully. Nothing here throws or logs
 * PII. The parent-portal link uses OPENMASJID_PUBLIC_URL when set (empty → no button, still valid).
 *
 * SINCE 0.50.0 THIS IS THE FAN-OUT FOR BOTH PARENT CHANNELS, not only email — the three parent-facing
 * messages also go to WhatsApp from here (whatsapp/index.ts owns every gate on that side and never
 * throws). The file is still called `mail` because that is what nine call sites import, and moving it
 * would be churn rather than clarity; what matters is that there is exactly ONE place a receipt is
 * sent from. That was already the point: receipts are triggered in five different places, so a check
 * per caller is a check somebody forgets — and a SECOND channel per caller is a channel somebody
 * forgets entirely.
 *
 * The two channels gate INDEPENDENTLY. The parent-email switches and the mail pause say nothing about
 * WhatsApp, and the WhatsApp toggles and its own pause say nothing about email; an office that turned
 * receipts off by email did not thereby ask for them by WhatsApp, or the reverse. Nothing
 * auth-critical (invites, resets, verification) goes to WhatsApp at all — see whatsapp/index.ts.
 */
import { getSchoolName, getSchoolLogo, getParentEmails, getParentMailPaused, getPastDue, getSchoolContact } from '../settings';
import { guardianEmailsForFamily } from './recipients';
import {
  inviteEmail,
  receiptEmail,
  autopayFailureEmail,
  pastDueEmail,
  invoiceReadyEmail,
  autopayUpcomingEmail,
  cardExpiringEmail,
  refundEmail,
  resetEmail,
  testEmail,
  alertEmail,
  setEmailLogoUrl,
  setEmailContactLine,
} from './templates';
import { portalBase } from '../auth/invites';
import { sendPlatformEmail } from '../fabric/platform';
import { notifyFamily } from '../whatsapp';
import { pausedFor } from '../settings/testStudent';
import { fabricConfigured } from '../config';

function portalHome(): string {
  const b = portalBase();
  return b ? `${b}/family` : '';
}

/** Why a send didn't happen, so a caller can tell the admin something actionable instead of failing
 *  silently — which is how invites and resets used to disappear. */
export type MailSkip = 'no_transport' | 'no_public_url' | 'no_recipient' | 'parents_paused';

export interface MailOutcome {
  sent: boolean;
  /** Present only when `sent` is false. */
  skipped?: MailSkip;
}

/**
 * Is there any way to send mail right now?
 *
 * This app has no mail transport of its own: OpenMasjidOS owns the provider and the From address, so
 * a masjid sets email up once, there. A standalone install therefore sends nothing — and that is a
 * supported mode, not a broken one: invites and resets degrade to copy/print links, which the office
 * hands over directly (§6).
 *
 * Note this is still only a capability signal, not proof of delivery — the platform can accept the
 * call and answer `{sent:false}` if the masjid has no provider configured. `deliver()` reports that
 * honestly, and the Settings "Reaching parents" panel plus the test-send button are how an admin finds
 * out for certain.
 */
export function mailAvailable(): boolean {
  return fabricConfigured();
}

/**
 * Point the templates at the current logo, right before building one.
 *
 * Resolved per send rather than cached at boot for two reasons: an admin can upload or change the
 * logo at any moment, and the public base URL only appears once OpenMasjidOS turns Remote access on
 * — so a value captured at startup would frequently be a stale null. Both lookups are trivial (one
 * settings row, one in-memory string).
 */
function refreshEmailLogo(): void {
  const base = portalBase();
  setEmailLogoUrl(base && getSchoolLogo() ? `${base.replace(/\/+$/, '')}/api/logo` : null);
  // The masjid's own contact details, for the foot of every parent-facing message (0.47.0). Read on
  // the same schedule and for the same reason: an admin can change them at any moment.
  const c = getSchoolContact();
  setEmailContactLine([c.address, c.phone, c.email, c.website].map((v) => v.trim()).filter(Boolean).join(' · '));
}

/** One email, through the platform. Returns false when it did not actually send. */
async function deliver(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  return sendPlatformEmail(to, subject, text, html);
}

/**
 * Email a parent-portal invite to one guardian.
 *
 * An invite still requires an ABSOLUTE, off-network base URL: a relative link is dead in a mail
 * client, and a LAN link is dead for a parent at home. So when there is no public URL we deliberately
 * DON'T send, and say why (`no_public_url`) so the caller can offer the copy/print link and the admin
 * knows the tunnel isn't exposed yet — rather than the send vanishing.
 */
export async function sendInvite(email: string, url: string, guardianName: string): Promise<MailOutcome> {
  // The master stop comes FIRST, ahead of every other reason (0.48.0). An invite is exempt from the
  // per-type parent switches on purpose, but not from this one: it is the single most embarrassing thing
  // to send to 200 families by accident, and the caller still gets the link to copy or print.
  if (getParentMailPaused()) return { sent: false, skipped: 'parents_paused' };
  // Transport next: it is configured INSIDE this app, so it is the reason an admin can act on
  // immediately. A missing public URL is an OpenMasjidOS Remote-access setting.
  if (!mailAvailable()) return { sent: false, skipped: 'no_transport' };
  if (!portalBase()) return { sent: false, skipped: 'no_public_url' };
  refreshEmailLogo();
  // The address is passed into the template as well as being the recipient: it is what they will sign
  // in WITH, and a parent has no other username.
  const m = inviteEmail(getSchoolName(), guardianName, url, email);
  return { sent: await deliver(email, m.subject, m.text, m.html) };
}

/**
 * Email a password-reset link. Same absolute-link requirement as invites, same explicit reasons.
 *
 * `audience` is REQUIRED so every call site has to say who it is writing to (0.48.0). The public reset
 * door serves staff and parents through one procedure, and the parent-mail stop must hold a parent's
 * reset while never touching an admin's — a boolean the compiler forces you to pass is the only version
 * of that which cannot rot.
 */
export async function sendReset(email: string, url: string, audience: 'staff' | 'parent'): Promise<MailOutcome> {
  if (audience === 'parent' && getParentMailPaused()) return { sent: false, skipped: 'parents_paused' };
  if (!mailAvailable()) return { sent: false, skipped: 'no_transport' };
  if (!portalBase()) return { sent: false, skipped: 'no_public_url' };
  refreshEmailLogo();
  const m = resetEmail(getSchoolName(), url);
  return { sent: await deliver(email, m.subject, m.text, m.html) };
}

/**
 * Email a payment receipt to a family's guardians (§13.2.5 — "payment", never "donation"). Returns how
 * many were sent. A receipt is useful WITHOUT a public URL (it just drops the portal button).
 *
 * The office's "email parents a receipt" switch is checked HERE rather than at each call site, and
 * that is the point: receipts are sent from five places (portal, autopay, the kiosk and donation site
 * over the Fabric, and the office's own cash entry). A check per caller is a check somebody forgets.
 */
export async function sendReceipt(familyId: string, amountFormatted: string): Promise<number> {
  // WhatsApp first and unawaited: its gates are its own (0.50.0), so it must not sit behind the email
  // switches — an office that turned email receipts off has said nothing about the other channel.
  void notifyFamily('receipt', familyId, 'receipt', { amount: amountFormatted });
  // `pausedFor` rather than the raw switch: the test student's household is the one that gets through,
  // on BOTH channels (settings/testStudent.ts).
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getParentEmails().receipt) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = receiptEmail(getSchoolName(), amountFormatted, portalHome());
  // The platform endpoint takes one recipient per call.
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/**
 * The admin's "send test" probe — through here, not straight to the transport.
 *
 * The point of the test is to show an admin what a parent will actually receive, so it has to be built
 * the same way every real email is: same shell, same logo refresh. Sent from the router instead, it
 * quietly came out as the only email with no letterhead, and the logo looked broken when it wasn't.
 *
 * Returns false when the platform accepted the call but did not send (§ mail is a capability signal,
 * not proof of delivery) — the caller turns that into an actionable message.
 */
export async function sendTestEmail(to: string): Promise<boolean> {
  refreshEmailLogo();
  const m = testEmail(getSchoolName());
  return deliver(to, m.subject, m.text, m.html);
}

/** Email an autopay-failure notice to a family's guardians (§13.3). `final` = the third strike (autopay
 *  now off). Returns how many were sent. */
export async function sendAutopayFailure(familyId: string, final: boolean): Promise<number> {
  // Two texts behind one switch: the third strike reads differently from the first two, and an office
  // rewriting one wants to rewrite the other differently (whatsapp/templates.ts).
  void notifyFamily('autopay-failed', familyId, final ? 'autopay-stopped' : 'autopay-failed');
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getParentEmails().autopayFailure) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = autopayFailureEmail(getSchoolName(), portalHome(), final);
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/**
 * Email a past-due reminder to a family's guardians (0.48.0). Returns how many were sent.
 *
 * The gate here is `getPastDue().parentEmails`, NOT one of the `ParentEmailPrefs` — it belongs with the
 * grace period and the cadence, which are the other half of the same decision, and it defaults OFF
 * because this is a message the app never used to send (§ settings/getPastDue).
 *
 * Returning COUNTS rather than a boolean is what lets the caller tell "we reminded them" from "there is
 * nobody to remind": a household with no address on file must not start a quiet cooldown (billing/pastDue.ts).
 *
 * Counted PER CHANNEL since 0.50.0, and awaited rather than fired off, unlike the other two senders here.
 * The caller needs to know whether this household was actually reached before it starts a week-long
 * cooldown on them — and a WhatsApp that was queued is a household that was reached, even when there is
 * no email address on file. Getting that wrong in either direction is a real fault: a cooldown on a
 * family nobody wrote to means they wait another week for nothing, and no cooldown on one we did write
 * to means we chase them again tomorrow.
 */
export async function sendPastDue(
  familyId: string,
  amountFormatted: string,
  sinceFormatted: string,
  behind: { name: string; amount: string }[] = [],
): Promise<{ emails: number; whatsapp: number }> {
  // `behind` reaches BOTH channels, at each one's depth: the email carries the per-child amounts, the
  // WhatsApp just the names, because that channel is the short note that says to go and look (§9).
  const wa = await notifyFamily('past-due', familyId, 'past-due', {
    amount: amountFormatted,
    due: sinceFormatted,
    behind: behind.map((b) => b.name),
  });
  const out = { emails: 0, whatsapp: wa.queued };
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getPastDue().parentEmails) return out;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return out;
  refreshEmailLogo();
  const m = pastDueEmail(getSchoolName(), amountFormatted, sinceFormatted, portalHome(), behind);
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) out.emails++;
  return out;
}

/**
 * This period's bill is ready (0.50.0). Returns how many were emailed.
 *
 * The biggest gap the app had: a parent heard nothing between one receipt and the past-due reminder
 * that followed a bill they were never told about. `children` is named here and nowhere else, because
 * "what is this for?" is the question this message answers and a household with three children on
 * different plans cannot answer it from a total.
 */
export async function sendInvoiceReady(familyId: string, amountFormatted: string, dueFormatted: string, children: string[]): Promise<number> {
  void notifyFamily('invoice-ready', familyId, 'invoice-ready', { amount: amountFormatted, due: dueFormatted });
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getParentEmails().invoiceReady) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = invoiceReadyEmail(getSchoolName(), amountFormatted, dueFormatted, listNames(children), portalHome());
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/** "We'll charge your saved card on Tuesday" (0.50.0) — the note that stops a card charge being a
 *  surprise, and gives a family time to move money or switch autopay off for the month. */
export async function sendAutopayUpcoming(familyId: string, amountFormatted: string, whenFormatted: string, cardLabel: string): Promise<number> {
  void notifyFamily('autopay-upcoming', familyId, 'autopay-upcoming', { amount: amountFormatted, due: whenFormatted, card: cardLabel });
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getParentEmails().autopayUpcoming) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = autopayUpcomingEmail(getSchoolName(), amountFormatted, whenFormatted, cardLabel, portalHome());
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/** A saved card is about to expire (0.50.0) — which is how autopay stops working without anybody
 *  noticing until a family is three months behind. */
export async function sendCardExpiring(familyId: string, cardLabel: string, whenFormatted: string): Promise<number> {
  void notifyFamily('card-expiring', familyId, 'card-expiring', { card: cardLabel, due: whenFormatted });
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getParentEmails().cardExpiring) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = cardExpiringEmail(getSchoolName(), cardLabel, whenFormatted, portalHome());
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/** Money has gone back to the family (0.50.0). */
export async function sendRefund(familyId: string, amountFormatted: string): Promise<number> {
  void notifyFamily('payment-refunded', familyId, 'payment-refunded', { amount: amountFormatted });
  if (pausedFor(getParentMailPaused(), familyId) || !mailAvailable() || !getParentEmails().refund) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = refundEmail(getSchoolName(), amountFormatted, portalHome());
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/**
 * The "does this actually reach us?" probe, sent to the TEST HOUSEHOLD (0.50.0-dev.5).
 *
 * Deliberately a test message rather than a fake receipt: a family who gets a realistic-looking
 * receipt for a payment nobody made will ring the office, which is the opposite of helpful.
 *
 * It goes through `guardianEmailsForFamily`, which honours the test-household exception — so this
 * proves the whole pause-exception path an office is trying to verify, not just the transport.
 */
export async function sendTestToHousehold(familyId: string): Promise<number> {
  if (!mailAvailable()) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = testEmail(getSchoolName());
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
}

/** "Yusuf", "Yusuf and Maryam", "Yusuf, Maryam and Bilal" — a sentence, not a list dump. Mirrors the
 *  WhatsApp side so a household reads the same phrasing on both channels. */
function listNames(names: string[]): string {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Email ONE staff alert to ONE address (0.44.0). The recipient list and the decision to send live in
 * alerts/index.ts; this is only the composing + transport half, so alerts look like every other email
 * the madrasa sends (same shell, same letterhead).
 *
 * Note there is no `getParentEmails` gate here — this is not a parent email. Its off switch is the
 * recipient list itself: an address that should hear nothing is removed.
 */
export async function sendAlert(to: string, title: string, body: string): Promise<boolean> {
  if (!mailAvailable()) return false;
  refreshEmailLogo();
  const m = alertEmail(getSchoolName(), title, body, portalBase());
  return deliver(to, m.subject, m.text, m.html);
}
