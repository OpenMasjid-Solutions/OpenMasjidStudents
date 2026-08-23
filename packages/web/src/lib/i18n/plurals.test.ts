// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * COUNTED STRINGS READ CORRECTLY AT ONE (0.51.0).
 *
 * "1 households (1 students)" shipped to the onboarding panel — a screen an admin reads in the moment
 * before writing to families who cannot be un-messaged. It got there the ordinary way: one interpolated
 * string holding several counts. i18next pluralizes on `count` and there is exactly ONE of those per key,
 * so a sentence with two or three numbers in it cannot be pluralized as a single key at all — it has to
 * be composed from fragments that each own their own count. This asserts the composition, at one and at
 * many, because one household with one child and one reachable parent is the COMMON case at a madrasah
 * rather than an edge.
 *
 * WHY THERE IS NO SWEEPING "every {{count}} key must have _one/_other" CHECK HERE. It was written, and it
 * was unsound in two ways worth recording so nobody writes it again:
 *
 *  1. **`billing.ch_other` is a payment channel named "other", not a plural form.** Any check that strips
 *     an `_other` suffix reads it as the plural half of a `billing.ch` pair that does not exist. The
 *     suffix is genuinely ambiguous with real key names, so suffix-matching cannot decide this.
 *  2. **41 existing keys interpolate `{{count}}` deliberately without plural forms** — most of them using
 *     the older "{{count}} student(s)" convention, and some genuinely count-neutral ("Link {{count}}",
 *     "{{count}} to check"). Holding the whole catalog to the newer style would either fail the build on
 *     work nobody asked for, or need a 41-item allowlist, which is noise that stops being read.
 *
 * So the guard is scoped to the panel that had the defect. Converting the "(s)" strings is real work with
 * a real benefit and belongs in its own change, not smuggled in behind a test.
 */
import { describe, it, expect } from 'vitest';
import i18n from './index';

const t = i18n.getFixedT('en');

describe('the onboarding send panel says "1 household", not "1 households"', () => {
  it('reads correctly at one and at many', () => {
    expect(t('onboarding.willSend', { count: 1 })).toBe('1 household');
    expect(t('onboarding.willSend', { count: 4 })).toBe('4 households');
    expect(t('onboarding.nStudents', { count: 1 })).toBe('1 student');
    expect(t('onboarding.nStudents', { count: 3 })).toBe('3 students');
  });

  it('composes the sent line with each count pluralized on its own', () => {
    expect(
      t('onboarding.sent', {
        count: 1,
        emails: t('onboarding.nEmails', { count: 1 }),
        messages: t('onboarding.nMessages', { count: 1 }),
      }),
    ).toBe('Sent to 1 household — 1 email, 1 WhatsApp message queued.');

    expect(
      t('onboarding.sent', {
        count: 2,
        emails: t('onboarding.nEmails', { count: 3 }),
        messages: t('onboarding.nMessages', { count: 2 }),
      }),
    ).toBe('Sent to 2 households — 3 emails, 2 WhatsApp messages queued.');
  });

  /** The catch-all: at one of everything, nothing in the sentence may read as a plural. This is the
   *  assertion that would have failed on the string that shipped. */
  it('has no stray plural anywhere in the one-of-everything reading', () => {
    const line = `${t('onboarding.willSend', { count: 1 })} (${t('onboarding.nStudents', { count: 1 })}) ${t('onboarding.sent', {
      count: 1,
      emails: t('onboarding.nEmails', { count: 1 }),
      messages: t('onboarding.nMessages', { count: 1 }),
    })}`;
    expect(line).not.toMatch(/\b1 \w+s\b/);
  });

  /** The remaining-households line already pluralized; kept here so all four counts on the panel are
   *  covered by one file rather than three of them being covered by luck. */
  it('pluralizes the leftover count too', () => {
    expect(t('onboarding.remaining', { count: 1 })).toContain('1 household ');
    expect(t('onboarding.remaining', { count: 7 })).toContain('7 households ');
  });
});
