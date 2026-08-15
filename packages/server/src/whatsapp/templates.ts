// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What a WhatsApp message from the madrasa actually says (0.50.0).
 *
 * ONE RULE DECIDES HOW MUCH GOES IN EACH CHANNEL, and it is not arbitrary: **WhatsApp carries the
 * fact and the figure; email carries the breakdown, the receipt and the links.** A WhatsApp message
 * is read on a lock screen between other conversations, it cannot be printed, it has no letterhead
 * and it cannot be trusted to arrive at all (the number can be restricted at any time). So it says
 * the one thing a parent needs to know and, when the school has an address for them, points at the
 * email where the rest of it is. When the school has NO address, the WhatsApp has to stand alone —
 * which is exactly why the missing-email outreach below exists.
 *
 * What never appears in any of these, whatever the wording:
 *  • a **Student ID** — it is a payment credential (§14), and this channel is not one we control;
 *  • card details, of any kind;
 *  • another household's anything.
 *
 * A child's FIRST NAME is allowed in a message to that child's own parent, and is most of the value —
 * "we've received your payment for Yusuf" is worth sending; "a payment was received" is not.
 *
 * Voice: plain and warm (§15). No jargon, no "PaymentIntent", nothing a parent has to decode. Every
 * one of these is a shipped DEFAULT in English; the office can rewrite the outreach message in
 * Settings, and the rest go through i18n on the screens that describe them.
 */
import { getSchoolName } from '../settings';

/** The sentence appended when the school also has an email address for this household. Kept as one
 *  string so the "check your email" promise is worded identically everywhere it is made. */
function seeEmail(hasEmail: boolean): string {
  return hasEmail ? '\n\nWe’ve emailed you the full details.' : '';
}

/** A pay-here line, only when there is an absolute public URL to give. A portal link that resolves to
 *  a LAN address is worse than no link at all for a parent reading this at home. */
function payLine(portalUrl: string): string {
  return portalUrl ? `\n\nYou can pay here: ${portalUrl}` : '';
}

/** Money has landed (§11.3 — a receipt is a PAYMENT, never a donation). */
export function waReceipt(amountFormatted: string, opts: { hasEmail: boolean }): string {
  return `Assalamu alaykum. ${getSchoolName()} has received your payment of ${amountFormatted}. JazakumAllahu khayran.${seeEmail(opts.hasEmail)}`;
}

/**
 * A saved card was declined (§13.3). `final` is the third strike, where autopay switches itself off.
 *
 * No amount, deliberately — the email doesn't carry one either. What failed is a whole autopay run
 * across a household's open bills, and a figure quoted here would go stale the moment any of it is
 * paid another way; the portal shows what is actually owed, which is where this points.
 */
export function waAutopayFailed(opts: { final: boolean; portalUrl: string; hasEmail: boolean }): string {
  const head = opts.final
    ? 'We tried three times to charge your saved card for this month’s tuition and it didn’t go through, so automatic payments are now switched off.'
    : 'We couldn’t charge your saved card for this month’s tuition. We’ll try again in a couple of days.';
  return `Assalamu alaykum. ${head} This is ${getSchoolName()}.${payLine(opts.portalUrl)}${seeEmail(opts.hasEmail)}`;
}

/** A balance is past its due date. Deliberately gentle, and it says what to do if they have paid —
 *  a family who settled yesterday should not have to defend themselves. */
export function waPastDue(amountFormatted: string, sinceFormatted: string, opts: { portalUrl: string; hasEmail: boolean }): string {
  return (
    `Assalamu alaykum. This is a reminder from ${getSchoolName()} that ${amountFormatted} has been due since ${sinceFormatted}.` +
    ` If you’ve already paid, please ignore this message.${payLine(opts.portalUrl)}${seeEmail(opts.hasEmail)}`
  );
}

/** The office's "does this reach you?" probe. Says plainly that it is a test, so nobody rings back. */
export function waTest(): string {
  return `Assalamu alaykum. This is a test message from ${getSchoolName()}’s tuition app. No reply is needed.`;
}

/**
 * A staff alert on WhatsApp.
 *
 * Carries the SAME text as the alert email — the one that may name a household and an amount — and
 * not the de-identified `publicText` (§14). The line §14 draws is around THIRD-PARTY SINKS: a masjid
 * webhook is usually a Slack channel, and the platform's alert delivery is not ours to reason about.
 * This is a number an admin typed into Settings, on a gateway the masjid runs itself, going to the
 * treasurer's own phone — the same audience and the same actionability requirement as their inbox. An
 * alert that cannot say which family is not worth sending.
 *
 * A Student ID and card details are still forbidden, as they are in the email.
 */
export function waStaffAlert(title: string, text: string): string {
  return `${getSchoolName()} — ${title}\n\n${text}`;
}

// ── The missing-email outreach (office-editable) ─────────────────────────────

/** The tags the office may use in their own wording. Sent to the settings screen so the UI never
 *  hard-codes this list and it cannot drift from what `renderEmailRequest` actually substitutes. */
export const WA_EMAIL_REQUEST_TAGS = ['school', 'family', 'children'] as const;

/**
 * The shipped wording for "we don't have your email address".
 *
 * It has to do three things in one short message, and the order is deliberate: say WHO it is from,
 * say exactly WHICH children we have no address for, and say WHY it matters — because "give us your
 * email" with no reason reads as a mailing list. The reason is the true one: this channel cannot
 * carry a receipt, an invoice or a statement, so a family with no address on file is missing all of
 * them.
 */
export const WA_EMAIL_REQUEST_DEFAULT =
  'Assalamu alaykum. This is [school]. We don’t have an email address on file for [children], so we can’t send you receipts, invoices or statements — a WhatsApp message can only carry a short note, and anything with detail in it goes by email.\n\n' +
  'Could you reply with the best email address for the family? JazakumAllahu khayran.';

/**
 * Fill in the office's wording (or the shipped one) for one household.
 *
 * `children` is the list of names this household has no address for — "which emails are missing, and
 * for whom", which is the question a parent will ask the moment they read the message. Joined here
 * rather than at the call site so every message reads the same way.
 */
export function renderEmailRequest(template: string, vars: { family: string; children: string[] }): string {
  const kids = vars.children.length ? listNames(vars.children) : 'your children';
  return (template.trim() || WA_EMAIL_REQUEST_DEFAULT)
    .replaceAll('[school]', getSchoolName())
    .replaceAll('[family]', vars.family)
    .replaceAll('[children]', kids);
}

/** "Yusuf", "Yusuf and Maryam", "Yusuf, Maryam and Bilal" — a sentence, not a CSV dump. */
function listNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
