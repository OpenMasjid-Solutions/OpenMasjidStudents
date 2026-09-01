// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ONBOARDING MESSAGE — the one thing a madrasah says to a family when it starts using this app
 * (0.51.0).
 *
 * WHAT IT IS FOR. Every other parent message here is about an event: a bill exists, money landed, a card
 * failed. None of them explains what any of it IS. A family that has never heard of a parent portal gets
 * a receipt from a number they do not recognize, and the office spends September on the phone. This is
 * the message that goes first: here is what we have set up, here is what you will get from us, and here
 * is where to go for the rest.
 *
 * IT DELIBERATELY CARRIES NO DETAIL, and points at the family sheet instead. That is the design, not
 * brevity for its own sake:
 *
 *   • A Student ID must never go out on WhatsApp (§14) — it is the whole credential on the payment path,
 *     and this is not a channel we control end to end. The sheet carries it, and the sheet is handed over
 *     in person, which is exactly the property that makes it the right place.
 *   • Fees, balances and what each child is charged are per household and change; a message is a copy
 *     that outlives its own accuracy. The sheet is reprinted from live data every time.
 *   • Both channels have to say the same thing, and one of them is read on a lock screen. Anything longer
 *     than a few lines is not read on either.
 *
 * So the message explains, and then says to ask the office for the family sheet. The office is the
 * fallback for everything this cannot safely say.
 *
 * THE OFFICE OWNS THE WORDS. Same rule as the printed sheet (people/sheetText.ts): how a madrasah
 * introduces itself to its families is its own voice, and no default can guess whether they say
 * "madrasah" or "school", or whether they write to parents in Urdu. So the copy here is DEFAULTS, and
 * every box is replaceable in Settings.
 *
 * WHY THE WHATSAPP NOTE IS ITS OWN BOX. On WhatsApp the message has one extra job: telling a family which
 * number the madrasah will be writing from. A message from an unknown number asking about tuition is
 * indistinguishable from a scam, and the first thing a cautious parent does is block it. That sentence is
 * meaningless in an email, so it is appended only on WhatsApp — the same shape as the sheet's
 * `payOfficeReceipt`, which exists only when a receipt will really be sent. Keeping it separate also
 * means an office rewriting the body does not have to remember to keep it.
 *
 * TAGS ARE A FIXED LIST, and that is the enforcement rather than a rule in a document (§9): there is no
 * tag for a Student ID, a balance or a card, so an office cannot put one in this message even by
 * accident, on either channel.
 */
import { getOnboardingText, getSchoolName } from '../settings';

/** The boxes an office may re-write, in the order they appear in Settings and on the page. */
export const ONBOARDING_KEYS = ['subject', 'body', 'whatsappNote'] as const;
export type OnboardingKey = (typeof ONBOARDING_KEYS)[number];

/**
 * What a message can be filled in with. No Student ID, no balance, no card — see the header.
 *
 * `[portal]` resolves to nothing at all on an install with no public address yet, rather than to a dead
 * link or a naked "null": a madrasah on the LAN only still wants to send this, and the sentence has to
 * survive the tag being empty. Same rule as the WhatsApp templates' own `[portal]`.
 */
export const ONBOARDING_TAGS = ['school', 'family', 'children', 'portal'] as const;
export type OnboardingTag = (typeof ONBOARDING_TAGS)[number];

/** Per box. The body is the only long one; a message a parent will actually read is far shorter than
 *  this, and the cap is here to stop a paragraph becoming a page rather than to shape the prose. */
export const ONBOARDING_MAX = 1200;

/**
 * The shipped wording — complete and sendable, so an office that never opens Settings still says
 * something a family can act on.
 *
 * Plain and warm (§15), and it names the sheet twice over: once as the thing to ask for, once as what is
 * on it. Typographic apostrophes on purpose — this goes into an email body and a WhatsApp message, both
 * of which render them properly.
 */
export const ONBOARDING_DEFAULTS: Record<OnboardingKey, string> = {
  subject: 'About your [school] tuition account',
  body:
    'Assalāmu ʿalaykum,\n\n' +
    '[school] now handles tuition through an app, and this message is to explain what that means for you.\n\n' +
    'You will hear from us when a bill is ready, when we receive a payment, and if anything is overdue. ' +
    'You can also pay online, see what each of your children owes, and set up automatic payments if you want to.\n\n' +
    'Please ask the office for your family sheet. It lists your children, what the fees are, every way you ' +
    'can pay, and the ID each child needs to pay online — and it is the best place to check that what we ' +
    'hold for you is right.[portal]\n\n' +
    'If anything looks wrong, or you would rather not be messaged, just tell the office.',
  whatsappNote: 'Messages from us will come from this number — you may want to save it.',
};

/** The values a box may refer to. Assembled once per household by the caller. */
export interface OnboardingVars {
  family: string;
  /** Active children in that household, by name. */
  children: string[];
  /** An absolute portal URL, or '' when this install has no public address yet. */
  portal?: string;
}

/** "Yusuf", "Yusuf and Maryam", "Yusuf, Maryam and Bilal" — a sentence, not a list dump. Matches the
 *  phrasing on both of the other channels so a household reads one voice. */
function listNames(names: string[]): string {
  if (!names.length) return 'your children';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The wording in force for one box: the madrasah's, or ours. A blank override is not wording — it means
 *  "put the default back", which is what an office does by clearing the field. */
export function onboardingText(key: OnboardingKey, overrides: Record<string, string> = getOnboardingText()): string {
  const v = overrides[key];
  return v && v.trim() ? v.trim() : ONBOARDING_DEFAULTS[key];
}

/**
 * Fill in one box for one household.
 *
 * `[portal]` carries its own leading blank line, so an office can drop it mid-paragraph without leaving a
 * double space, and a message on an install with no public address does not end in stray whitespace.
 * Returned as PLAIN TEXT — the email side puts it through its own escaping on the way into HTML, and
 * WhatsApp takes it as it is.
 */
export function renderOnboarding(key: OnboardingKey, vars: OnboardingVars, overrides?: Record<string, string>): string {
  const portal = vars.portal ? `\n\nYou can sign in here: ${vars.portal}` : '';
  return onboardingText(key, overrides ?? getOnboardingText())
    .replaceAll('[school]', getSchoolName())
    .replaceAll('[family]', vars.family)
    .replaceAll('[children]', listNames(vars.children))
    .replaceAll('[portal]', portal)
    .trim();
}

/**
 * The WhatsApp form: the body, then the which-number note.
 *
 * Appended here rather than left to the caller so the note cannot be forgotten on one send path and not
 * another — the same argument that put the parent-email switches inside `mail/notify.ts` (§9).
 */
export function onboardingWhatsApp(vars: OnboardingVars, overrides?: Record<string, string>): string {
  const body = renderOnboarding('body', vars, overrides);
  const note = renderOnboarding('whatsappNote', vars, overrides);
  return note ? `${body}\n\n${note}` : body;
}
