// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Transactional email templates (CLAUDE.md §4/§13). Pure string builders — no DB, so a direct import
 * is fine. The load-bearing rule: a receipt says "payment", NEVER "donation" (§13.2.5/§11.3).
 */
import { describe, it, expect } from 'vitest';
import { inviteEmail, receiptEmail, autopayFailureEmail, testEmail } from '../src/mail/templates';

describe('receipt email', () => {
  it('says "payment", never "donation", and carries the amount (§13.2.5)', () => {
    const m = receiptEmail('An-Noor School', '$350.00', 'https://x.test/students/family');
    for (const part of [m.subject, m.text, m.html]) {
      expect(part.toLowerCase()).not.toContain('donation');
    }
    expect(m.text.toLowerCase()).toContain('payment');
    expect(m.text).toContain('$350.00');
    expect(m.subject).toContain('$350.00');
    expect(m.html).toContain('https://x.test/students/family'); // portal button link
  });
  it('omits the portal button when there is no public URL', () => {
    const m = receiptEmail('An-Noor School', '$50.00', '');
    expect(m.html).not.toContain('href="https');
  });
});

describe('invite email', () => {
  it('carries the invite link in both parts', () => {
    const url = 'https://x.test/students/family/invite?token=abc123';
    const m = inviteEmail('An-Noor School', 'Yusuf', url);
    expect(m.text).toContain(url);
    expect(m.html).toContain(url);
    expect(m.subject).toContain('An-Noor School');
  });

  /** A parent has no username of their own — it IS this address — and the sign-in form asks for a
   *  "username", so the invite has to say which one is theirs (0.43.0). */
  it('names the address they will sign in with', () => {
    const m = inviteEmail('An-Noor School', 'Yusuf', 'https://x.test/i?token=t', 'abu@example.com');
    expect(m.text).toContain('abu@example.com');
    expect(m.html).toContain('abu@example.com');
  });
});

describe('autopay-failure email', () => {
  it('final (autopay off) reads differently from a retry notice', () => {
    const retry = autopayFailureEmail('An-Noor School', 'https://x.test/students/family', false);
    const final = autopayFailureEmail('An-Noor School', 'https://x.test/students/family', true);
    expect(retry.subject).not.toBe(final.subject);
    expect(final.text.toLowerCase()).toContain('turned'); // "turned off"
    expect(retry.text.toLowerCase()).toContain('try again'); // reassures a retry is coming
    for (const m of [retry, final]) expect(m.text.toLowerCase()).not.toContain('donation');
  });
});

describe('test email', () => {
  it('names the school', () => {
    expect(testEmail('An-Noor School').text).toContain('An-Noor School');
  });
});
