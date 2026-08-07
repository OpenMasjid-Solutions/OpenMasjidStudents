// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * High-level transactional senders (CLAUDE.md §4/§13). One place that composes the school name + the
 * right template + the transport, so routers stay thin. Every function is BEST-EFFORT and no-ops when
 * SMTP is unconfigured (returns false / 0) — callers degrade gracefully. Nothing here throws or logs
 * PII. The parent-portal link uses OPENMASJID_PUBLIC_URL when set (empty → no button, still valid).
 */
import { getSchoolName, getSchoolLogo, getParentEmails, getSchoolContact } from '../settings';
import { guardianEmailsForFamily } from './recipients';
import { inviteEmail, receiptEmail, autopayFailureEmail, resetEmail, testEmail, alertEmail, setEmailLogoUrl, setEmailContactLine } from './templates';
import { portalBase } from '../auth/invites';
import { sendPlatformEmail } from '../fabric/platform';
import { fabricConfigured } from '../config';

function portalHome(): string {
  const b = portalBase();
  return b ? `${b}/family` : '';
}

/** Why a send didn't happen, so a caller can tell the admin something actionable instead of failing
 *  silently — which is how invites and resets used to disappear. */
export type MailSkip = 'no_transport' | 'no_public_url' | 'no_recipient';

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
  // Transport first: it is configured INSIDE this app, so it is the reason an admin can act on
  // immediately. A missing public URL is an OpenMasjidOS Remote-access setting.
  if (!mailAvailable()) return { sent: false, skipped: 'no_transport' };
  if (!portalBase()) return { sent: false, skipped: 'no_public_url' };
  refreshEmailLogo();
  // The address is passed into the template as well as being the recipient: it is what they will sign
  // in WITH, and a parent has no other username.
  const m = inviteEmail(getSchoolName(), guardianName, url, email);
  return { sent: await deliver(email, m.subject, m.text, m.html) };
}

/** Email a password-reset link. Same absolute-link requirement as invites, same explicit reasons. */
export async function sendReset(email: string, url: string): Promise<MailOutcome> {
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
  if (!mailAvailable() || !getParentEmails().receipt) return 0;
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
  if (!mailAvailable() || !getParentEmails().autopayFailure) return 0;
  const emails = guardianEmailsForFamily(familyId);
  if (!emails.length) return 0;
  refreshEmailLogo();
  const m = autopayFailureEmail(getSchoolName(), portalHome(), final);
  let n = 0;
  for (const e of emails) if (await deliver(e, m.subject, m.text, m.html)) n++;
  return n;
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
