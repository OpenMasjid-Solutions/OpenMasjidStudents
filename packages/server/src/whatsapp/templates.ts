// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What a WhatsApp message from the madrasa says — and how much of that the office decides (0.50.0).
 *
 * THE SHIPPED DEFAULTS FOLLOW ONE RULE: **WhatsApp carries the fact and the figure; email carries the
 * breakdown, the receipt and the links.** A WhatsApp message is read on a lock screen between other
 * conversations, cannot be printed, has no letterhead, and cannot be trusted to arrive at all. So it
 * says the one thing a parent needs to know and points at the email for the rest.
 *
 * THE OFFICE CAN REWRITE ANY OF IT (0.50.0-dev.4). The rule above is a good default, not a law about
 * somebody else's madrasah: one school wants the balance in every message, another wants three words
 * and a name, and a school writing in Urdu wants their own sentences entirely. So every message is a
 * TEMPLATE with tags, edited in Settings, previewed against a real household before it is saved. What
 * stays ours is the shape of the data — which tag means what, and what may never appear at all.
 *
 * WHAT NEVER APPEARS, whatever anybody types:
 *  • a **Student ID** — it is a payment credential (§14), and this is not a channel we control;
 *  • card details, of any kind;
 *  • another household's anything.
 * There is no tag for any of those, which is the enforcement: an office can only interpolate what the
 * catalogue below offers.
 *
 * A child's FIRST NAME is allowed in a message to that child's own parent, and is most of the value —
 * "we've received your payment for Yusuf" is worth sending; "a payment was received" is not.
 *
 * Voice: plain and warm (§15). No jargon, nothing a parent has to decode.
 */
import { getSchoolName, getWhatsAppTexts } from '../settings';

// ── The catalogue ────────────────────────────────────────────────────────────
/**
 * Every message whose wording an office can change.
 *
 * Note `autopay-failed` and `autopay-stopped` are two texts behind ONE event switch. They are
 * genuinely different messages — "we'll try again in a couple of days" and "we've stopped trying" —
 * and an office that rewrites one almost always wants to rewrite the other differently. Merging them
 * behind a tag would have made both worse.
 *
 * Keys are stored in the settings row, so renaming one silently reverts that message to the shipped
 * sentence. Add, don't rename.
 */
export const WA_TEXT_KEYS = ['invoice-ready', 'receipt', 'past-due', 'autopay-upcoming', 'autopay-failed', 'autopay-stopped', 'card-expiring', 'payment-refunded'] as const;
export type WaTextKey = (typeof WA_TEXT_KEYS)[number];

/**
 * The tags each message may use.
 *
 * Per message rather than one global list, because a tag that cannot be filled in is worse than one
 * that does not exist: `[due]` in a receipt would render as nothing and leave a sentence with a hole
 * in it. The settings screen shows only the tags that apply to the box being edited.
 */
export const WA_TEXT_TAGS: Record<WaTextKey, readonly string[]> = {
  'invoice-ready': ['school', 'family', 'children', 'amount', 'due', 'balance', 'portal', 'email'],
  receipt: ['school', 'family', 'children', 'amount', 'balance', 'portal', 'email'],
  // `behind` is its own tag rather than a reuse of `children`, which means every active child in the
  // household. On a past-due reminder those two lists are different — and quietly substituting one for
  // the other would name a child who is perfectly up to date as being late.
  'past-due': ['school', 'family', 'children', 'behind', 'amount', 'due', 'balance', 'portal', 'email'],
  'autopay-upcoming': ['school', 'family', 'amount', 'due', 'card', 'balance', 'portal', 'email'],
  'autopay-failed': ['school', 'family', 'children', 'card', 'balance', 'portal', 'email'],
  'autopay-stopped': ['school', 'family', 'children', 'card', 'balance', 'portal', 'email'],
  'card-expiring': ['school', 'family', 'card', 'portal', 'email'],
  'payment-refunded': ['school', 'family', 'amount', 'balance', 'portal', 'email'],
};

/** What every tag means, so the settings screen explains itself and this list cannot drift from
 *  `renderText` below — it is the same set of names. */
export const WA_TAG_HELP: Record<string, string> = {
  school: 'the madrasah’s name',
  family: 'the household’s name, e.g. “Ismail family”',
  children: 'the children in that household, by name',
  behind: 'only the children whose bills are past due, by name',
  amount: 'the amount this message is about',
  balance: 'what the household owes right now',
  due: 'the date it is due',
  card: 'the saved card, e.g. “Visa ···· 4242”',
  portal: 'a link to the parent portal (nothing, if there is no public address yet)',
  email: '“We’ve emailed you the full details.” — only for a parent who has an address on file',
};

/**
 * The shipped sentences.
 *
 * Each one is a complete, sendable message on its own: an office that never opens this screen still
 * sends something a parent can act on, and a school that only wants to change one word can start from
 * real prose rather than a blank box.
 */
export const WA_TEXT_DEFAULTS: Record<WaTextKey, string> = {
  'invoice-ready': 'Assalamu alaykum. Your [school] tuition for [children] is ready — [amount], due [due].[portal][email]',
  receipt: 'Assalamu alaykum. [school] has received your payment of [amount]. JazakumAllahu khayran.[email]',
  'past-due':
    'Assalamu alaykum. This is a reminder from [school] that [amount] for [behind] has been due since [due]. If you’ve already paid, please ignore this message.[portal][email]',
  'autopay-upcoming': 'Assalamu alaykum. [school] will charge your [card] [amount] on [due]. Nothing to do — this is just so it isn’t a surprise.[email]',
  'autopay-failed':
    'Assalamu alaykum. We couldn’t charge your saved card for this month’s tuition. We’ll try again in a couple of days. This is [school].[portal][email]',
  'autopay-stopped':
    'Assalamu alaykum. We tried three times to charge your saved card and it didn’t go through, so automatic payments are now switched off. This is [school].[portal][email]',
  'card-expiring': 'Assalamu alaykum. Your [card] saved with [school] expires soon, so automatic payments will stop working. You can add a new one any time.[portal][email]',
  'payment-refunded': 'Assalamu alaykum. [school] has refunded [amount] to you. Please allow a few days for it to appear.[email]',
};

/** Everything a message can be filled in with. Assembled once per household by the caller. */
export interface WaVars {
  family: string;
  /** Active children in that household, by name. */
  children: string[];
  /** Only the children this message is CHASING — a subset of `children`, and never a substitute for
   *  it. Set on a past-due reminder; absent everywhere else, where it falls back to `children`. */
  behind?: string[];
  /** The amount this message is about — a receipt's payment, a reminder's overdue figure. */
  amount?: string;
  due?: string;
  /** The household's derived balance right now. */
  balance?: string;
  /** The saved card this message is about — "Visa ···· 4242". Brand and last four only; a PAN and a
   *  holder name are never stored, let alone sent (§14). */
  card?: string;
  /** An absolute portal URL, or '' when this install has no public address yet. */
  portal?: string;
}

/**
 * Fill in one message for one recipient.
 *
 * `hasEmail` is per RECIPIENT, not per household, and that is the point of doing this here: a
 * household routinely has one parent with an address on file and one without, and telling the one
 * without to "check your email" is a promise about an inbox that does not exist.
 *
 * The `[portal]` and `[email]` tags carry their own leading blank line, so an office can drop them
 * mid-sentence without leaving a double space, and a message that resolves neither does not end in
 * stray whitespace.
 */
export function renderText(key: WaTextKey, vars: WaVars, opts: { hasEmail: boolean }): string {
  const template = getWhatsAppTexts()[key]?.trim() || WA_TEXT_DEFAULTS[key];
  const portal = vars.portal ? `\n\nYou can pay here: ${vars.portal}` : '';
  const email = opts.hasEmail ? '\n\nWe’ve emailed you the full details.' : '';
  return template
    .replaceAll('[school]', getSchoolName())
    .replaceAll('[family]', vars.family)
    .replaceAll('[children]', vars.children.length ? listNames(vars.children) : 'your children')
    // Falls back to the household's own children rather than to empty: a reminder that read "$430 for
    // has been due" would be worse than one that named everybody. Only `past-due` offers this tag.
    .replaceAll('[behind]', (vars.behind?.length ? listNames(vars.behind) : null) ?? (vars.children.length ? listNames(vars.children) : 'your children'))
    .replaceAll('[amount]', vars.amount ?? '')
    .replaceAll('[due]', vars.due ?? '')
    .replaceAll('[balance]', vars.balance ?? '')
    .replaceAll('[card]', vars.card ?? 'saved card')
    .replaceAll('[portal]', portal)
    .replaceAll('[email]', email)
    .trim();
}

/** The office's "does this reach you?" probe, sent to the test student's HOUSEHOLD — a parent's phone,
 *  so it greets like every other parent message. Not editable: its whole job is to be recognisable as
 *  a test, and a rewritten one that reads like a real message defeats the point. */
export function waTest(): string {
  return `Assalamu alaykum. This is a test message from ${getSchoolName()}’s tuition app. No reply is needed.`;
}

/**
 * A staff alert on WhatsApp — and on a staff group, which uses the same shape.
 *
 * NO GREETING, NO LETTERHEAD, JUST THE ALERT. A parent message is the madrasah speaking to a family
 * and is written like it; this is an operational notice to somebody who has to act on it, arriving on
 * the masjid's own number in a thread they already recognise. "Assalamu alaykum" ahead of "a card was
 * declined" is a line to scroll past before reaching the point — and the point is the whole message.
 * The school name went for the same reason: it is the sender, so saying it again is noise.
 *
 * Carries the SAME text as the alert email — the one that may name a household and an amount — and
 * not the de-identified `publicText` (§14). The line §14 draws is around THIRD-PARTY SINKS: a masjid
 * webhook is usually a Slack channel, and the platform's alert delivery is not ours to reason about.
 * This is a number an admin typed into Settings, on a gateway the masjid runs itself, going to the
 * treasurer's own phone — the same audience and the same actionability requirement as their inbox. An
 * alert that cannot say which family is not worth sending. (A GROUP is the one place that text may be
 * the de-identified one instead — see whatsapp/index.ts `notifyGroups`.)
 *
 * Not editable: it is our own operational wording, not the madrasah's voice to a parent.
 */
export function waStaffAlert(title: string, text: string): string {
  return `${title}\n\n${text}`;
}

// ── The missing-email outreach (its own text, its own screen) ────────────────

/** The tags the office may use in the outreach wording. Kept separate from `WA_TEXT_TAGS` because
 *  this message is not one of the parent events — it is a one-off an office presses. */
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

/** Fill in the office's wording (or the shipped one) for one household. */
export function renderEmailRequest(template: string, vars: { family: string; children: string[] }): string {
  const kids = vars.children.length ? listNames(vars.children) : 'your children';
  return (template.trim() || WA_EMAIL_REQUEST_DEFAULT).replaceAll('[school]', getSchoolName()).replaceAll('[family]', vars.family).replaceAll('[children]', kids);
}

/** "Yusuf", "Yusuf and Maryam", "Yusuf, Maryam and Bilal" — a sentence, not a CSV dump. */
function listNames(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
