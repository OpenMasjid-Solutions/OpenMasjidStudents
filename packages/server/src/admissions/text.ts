// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE WORDS ON THE PUBLIC ADMISSIONS FORM — and the madrasah's own version of them (0.52.0).
 *
 * CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §2. The registry lives here, beside the page that renders
 * it, and only the boxes an office actually changed are stored (`settings` → `admissions_text`).
 *
 * WHY IT IS CONFIGURABLE AT ALL. This is the one page in the app read by a family who has never met
 * the school, often embedded in the masjid's own website, and how a madrasah invites people in is its
 * own voice — whether it says "madrasah" or "school", whether it promises a call back or an email,
 * what it needs to warn people about before they type. A default cannot guess any of that.
 *
 * WHAT IS NOT CONFIGURABLE. The FIELDS (decision 9: a fixed set, because a configurable public form is
 * a configurable attack surface), the caps, the limiter, and the acknowledgement always being the
 * same whatever happened to the submission. An office may change what the page SAYS and never what it
 * DOES — the sharpest version of the same line `people/sheetText.ts` draws around the figures on a
 * printed sheet.
 *
 * ONE PIECE OF SYNTAX, and no markup at all: `[school]` is filled in with the madrasah's name.
 * Deliberately no `*stars*` bold here, unlike the printed sheet — this text is rendered into a page
 * served to the whole internet, and "escape it, then put some of our own tags back" is a decision
 * worth not making twice. Everything the office types is inert (§14). An unrecognized `[thing]`
 * prints as written rather than vanishing, the same rule the sheet and the invoice labels follow.
 */
import { esc } from '../billing/statements';
import { getAdmissionsText, getSchoolName } from '../settings';

/** Every sentence of the public form an office may re-write, in the order a family meets them. */
export const ADMISSIONS_TEXT_KEYS = [
  /** The paragraph at the top of the form, above the first box. */
  'intro',
  /** Shown INSTEAD of the form when the office has closed intake for the year. */
  'closed',
  /** What the family sees the moment they submit — and it says the same thing whatever actually
   *  happened to the submission, which is §14's no-enumeration rule made into a sentence. */
  'thanks',
  /** The optional acknowledgement email's body. Off unless an office switches it on, because the
   *  address was typed by a stranger. */
  'ackEmail',
  /** The small print under the button: what this madrasah does with what was typed. */
  'privacy',
] as const;
export type AdmissionsTextKey = (typeof ADMISSIONS_TEXT_KEYS)[number];

/**
 * The shipped wording. Plain and warm (§15), and written so that none of it promises anything the app
 * cannot keep: no timescale, no "we will call you on Monday", and nothing that implies the family is
 * or is not already known to the school.
 */
export const ADMISSIONS_TEXT_DEFAULTS: Record<AdmissionsTextKey, string> = {
  intro:
    'Assalamu alaikum. Tell us a little about your child and we will be in touch about a place at [school]. Nothing here is a commitment — it starts a conversation.',
  closed: 'We are not taking new admissions inquiries for [school] at the moment. Please contact the office and they will tell you when we open again.',
  thanks: 'Jazak Allah khayran — we have your message. Someone from [school] will be in touch.',
  ackEmail:
    'Assalamu alaikum,\n\nThank you for your interest in [school]. We have received your inquiry and someone from the office will be in touch.\n\nThis message is a confirmation that the form reached us; there is nothing you need to do now.',
  privacy: 'What you type here goes to the madrasah office and nowhere else.',
};

/** The values `[tags]` may take. One, today, and the list is here so adding a second is one edit. */
export interface AdmissionsTextTags {
  school: string;
}

export function admissionsTextTags(): AdmissionsTextTags {
  return { school: getSchoolName() };
}

/**
 * The office's version of one box, or the shipped one.
 *
 * Returns the RAW text — tags unsubstituted and unescaped. Callers that render into HTML use
 * `admissionsTextHtml`; the email sender escapes nothing because it is not building markup.
 */
export function admissionsText(key: AdmissionsTextKey): string {
  const overrides = getAdmissionsText();
  const own = overrides[key]?.trim();
  return own || ADMISSIONS_TEXT_DEFAULTS[key];
}

/** Fill in `[tags]`. An unknown tag is left exactly as typed rather than blanked, so a typo reads as
 *  a typo instead of silently deleting a word. */
export function fillTags(text: string, tags: AdmissionsTextTags = admissionsTextTags()): string {
  return text.replace(/\[(\w+)\]/g, (whole, name: string) => (name in tags ? String(tags[name as keyof AdmissionsTextTags]) : whole));
}

/** The office's words as plain text, with tags filled in — for an email body. */
export function admissionsTextPlain(key: AdmissionsTextKey): string {
  return fillTags(admissionsText(key));
}

/**
 * The office's words as HTML: ESCAPED FIRST, then tags filled in with their own escaped values.
 *
 * The order matters and is the whole care in this function. Escaping after substitution would escape
 * the school's name twice; substituting after escaping without escaping the VALUE would let a school
 * name containing `<` reach the page as markup. So both halves are escaped, separately, once.
 *
 * Newlines become paragraph breaks — an office typing two lines means two lines.
 */
export function admissionsTextHtml(key: AdmissionsTextKey): string {
  const tags = admissionsTextTags();
  const escaped: AdmissionsTextTags = { school: esc(tags.school) };
  const body = fillTags(esc(admissionsText(key)), escaped);
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
