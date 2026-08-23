// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The words on the printed family sheet — every sentence of it, and the madrasah's own version of them
 * (0.48.0).
 *
 * WHY THIS EXISTS. The sheet's prose was written into the renderer, which made it OUR wording rather than
 * the madrasah's. That is the wrong place for it: how a school asks a family to pay is the school's own
 * voice, and the details differ per install in ways no default can guess — whether the office says
 * "madrasah" or "school", whether a receipt is emailed or handed over, what their donations page is
 * called. So the copy lives here as DEFAULTS, and the office may replace any line of it in Settings.
 *
 * WHAT IS CONFIGURABLE AND WHAT IS NOT. Only prose. The figures, the children's names, the balances, the
 * Student ID boxes and the tables are computed and stay computed — a settings box that could change what
 * a family is told they owe would be a way to print a lie. The route items (`pay*`) are still shown or
 * hidden by what the install actually has (`payRoutes()` in onboardingSheet.ts): an office may re-word the
 * kiosk line, but it cannot make a kiosk line appear on an install with external payments switched off.
 *
 * TWO SMALL PIECES OF SYNTAX, chosen so an office can use them without being taught markup:
 *
 *  • `*stars*` make text bold. Applied AFTER escaping, so the only markup that can ever reach the page is
 *    the `<b>` we insert — the office's text itself is inert (§14), exactly like a guardian's name.
 *  • `[tags]` are filled in per household: `[names]`, `[is]`, `[child]`, `[school]`, `[website]`, `[date]`.
 *    Every tag works in every box (one tag set is built per sheet and passed to all of them), so nobody
 *    has to remember which line knows about which value. An unrecognized `[thing]` prints as written
 *    rather than vanishing — the same rule as the invoice-label tags (billing/period.ts).
 *
 * `[website]` has one extra rule worth knowing: when the madrasah has no donations address configured, an
 * empty `([website])` would print as a pair of naked brackets, so the parentheses are removed with it.
 */
import { esc } from '../billing/statements';
import { getSheetTextOverrides } from '../settings';

/** Every sentence of the sheet an office may re-write, in the order they appear on the page. */
export const SHEET_TEXT_KEYS = [
  'intro',
  'feesNone',
  'portalSignup',
  'portalInvite',
  'payCard',
  'payWebsite',
  'payKiosk',
  // Not a bullet — the italic tail appended to the three above. Ordered here beside them all the same, so
  // the Settings list reads in the order an office meets the words on the page.
  'payFee',
  'payOffice',
  'payOfficeReceipt',
  'check',
  'footer',
] as const;
export type SheetTextKey = (typeof SHEET_TEXT_KEYS)[number];

/**
 * The shipped wording. Long enough to read like a person wrote it, and deliberately plain (§15: warm for
 * parents, no jargon). Typographic apostrophes on purpose — this is print copy, and `esc()` leaves `’`
 * alone where it would turn `'` into an entity.
 */
export const SHEET_TEXT_DEFAULTS: Record<SheetTextKey, string> = {
  intro:
    '*[names] [is] now on our system.* This sheet is your copy of what we hold for your [child], what the fees are, and every way you can pay. Please read it through and tell the office if anything is wrong or out of date.',
  feesNone: 'No fees assigned yet — the office will confirm these with you.',
  portalSignup:
    '*Scan this to set up your account* You will need one of your children’s Student IDs (above) and an email address the office already has for you — that is how we know the account belongs to your family. One account covers all of your children.',
  portalInvite:
    '*Ask the office for a portal invite* Accounts here are set up by invitation. Give the office an email address and they will send you a link to choose your own password. One account covers all of your children.',
  // "or bank account": the portal's payment step offers whatever the masjid's Stripe account has switched
  // on, and paying a term's tuition from a bank account is what many families prefer. Editable like every
  // box here, so an office that only takes cards can trim the phrase.
  payCard:
    '*In the parent portal, by card or bank account.* Sign in and pay the whole balance or just part of it — for one child or all of them at once. You can save a card or bank account for next time, and turn on *autopay* so tuition is paid automatically when it comes due; you can switch it off whenever you like.',
  payWebsite:
    '*On the madrasah’s website* ([website]). Go to the tuition section, type any one of your children’s *Student IDs*, check the name it shows you, and pay. You can pay for all of your children from that one screen, and you don’t need an account for it.',
  payKiosk:
    '*At the kiosk in the masjid.* Choose tuition, enter a Student ID, confirm the name, and tap your card — *Apple Pay and Google Pay* work too.',
  /**
   * THE PROCESSING FEE, when the madrasah has chosen to pass Stripe's cut on (0.51.0).
   *
   * A CAVEAT APPENDED TO THE THREE ONLINE ROUTES, not a bullet of its own. It was its own item at first —
   * a whole paragraph with a worked example and a "cash avoids it" line — which gave one incidental fact
   * the same weight on the page as "here is how you pay", and made a five-item list read as though the
   * fee were a payment method. As a short italic tail on the portal, website and kiosk lines it lands
   * where a parent is actually reading about that route, and the office line simply never carries it,
   * which says "not this one" without a sentence spent on it.
   *
   * Appended (rather than folded into each of the three) for exactly the reason `payOfficeReceipt` is: an
   * office rewriting the caveat should not have to rewrite it in three places and keep them in step, and
   * the three lines still have to make sense on an install that absorbs the fee. `routes.fee` in
   * onboardingSheet.ts decides whether it appears at all — an office may re-word it and cannot make it
   * appear on an install that does not charge it.
   *
   * `[fee]` is available and unused by default: an office that wants the actual figure on the sheet can
   * add the tag, and it is COMPUTED (payments/fees.ts) like every other number here, so the prose stays
   * the madrasah's while the arithmetic stays ours. A settings box that could restate the rate in words
   * would be a way to print a fee the app does not charge.
   */
  payFee: 'A payment processing fee may apply.',
  // No "ask for confirmation before you leave" any more. It asked a parent to police the office, and on an
  // install that emails receipts it asked for something the app already does — see `payOfficeReceipt`,
  // which is appended only when a receipt will genuinely be sent.
  payOffice:
    '*Cash, check, Zelle or bank transfer (ACH).* These go *through the office*. Please hand them to the office and make sure someone records it against the right child.',
  payOfficeReceipt: 'Once it is recorded you will get a receipt by email.',
  check:
    '*Please check this sheet.* If a name is spelled differently, a date of birth or a phone number is wrong, a child is missing, a fee is not what you agreed, or a payment you have made is not showing — tell the office. It is much easier to fix now than at the end of the year.',
  footer: '[school] · Correct as of [date] · Keep this for your records.',
};

/** The tags a box may contain. One set is built per sheet and passed to every box (see the header). */
export const SHEET_TEXT_TAGS = ['names', 'is', 'child', 'school', 'website', 'date', 'fee'] as const;
export type SheetTextTag = (typeof SHEET_TEXT_TAGS)[number];
export type SheetTags = Record<SheetTextTag, string>;

/** Per box. Comfortably more than the longest default (about 340 characters) and far short of anything
 *  that would push the sheet off its two-side budget. */
export const SHEET_TEXT_MAX = 900;

/** The wording in force for one box: the madrasah's, or ours. A blank override is not wording — it
 *  means "put the default back", which is what an office does by clearing the field. */
export function sheetText(key: SheetTextKey, overrides: Partial<Record<string, string>> = getSheetTextOverrides()): string {
  const v = overrides[key];
  return v && v.trim() ? v.trim() : SHEET_TEXT_DEFAULTS[key];
}

/**
 * Turn one box of wording into the HTML that goes on the sheet.
 *
 * ORDER IS THE SECURITY PROPERTY, so it is worth stating: escape the template first, then convert the
 * star pairs, then substitute the tag values (each escaped in turn). That way the office's own text can
 * never introduce an element, a `*` inside a school name cannot accidentally open a bold run, and the
 * only tags left over are ones nobody defined — which print as written.
 */
export function renderSheetText(raw: string, tags: Partial<SheetTags> = {}): string {
  let out = esc(raw).replace(/\*([^*]+)\*/g, '<b>$1</b>');
  for (const tag of SHEET_TEXT_TAGS) {
    const value = (tags[tag] ?? '').trim();
    // An empty value takes its parentheses with it — "()" on a printed sheet reads as a bug, and the
    // whole point of the parenthetical is the address inside it.
    if (!value) out = out.replace(new RegExp(`[ \\t]*\\(\\s*\\[${tag}\\]\\s*\\)`, 'g'), '');
    out = out.split(`[${tag}]`).join(esc(value));
  }
  return out;
}

/** Both steps together — the form every call site on the sheet uses. */
export function sheetHtml(key: SheetTextKey, tags: Partial<SheetTags>, overrides?: Partial<Record<string, string>>): string {
  return renderSheetText(sheetText(key, overrides ?? getSheetTextOverrides()), tags);
}
