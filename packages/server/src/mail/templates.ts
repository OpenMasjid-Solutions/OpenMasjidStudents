// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Transactional email copy (CLAUDE.md §4/§15). English-only in v1 (there is no server-side i18n).
 * Voice: plain and warm for parents — no jargon, no sacred text as decoration. Receipts say
 * "payment", NEVER "donation" (§11.3 — tuition is generally not tax-deductible). Each builder returns
 * { subject, text, html }; the HTML is minimal + inline-styled (email clients ignore <style>) and the
 * text part is always a complete fallback.
 */

export interface Email {
  subject: string;
  text: string;
  html: string;
}

/** Escape for safe interpolation into the HTML part (names/labels are app data, but treat as text). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The masjid's logo for the top of an email, as an absolute URL.
 *
 * Set once at boot / on settings change (see mail/notify.ts). It is a MODULE-LEVEL value rather than
 * a parameter threaded through every builder because the logo is chrome, not content — no caller
 * should have to think about it.
 *
 * It has to be a URL, not the inlined bytes the printed statement uses: the platform's mail endpoint
 * accepts no attachments, so there is no `cid:` to reference, and mail clients (Gmail especially)
 * drop `data:` images. Null when no logo is set or the install has no public URL yet, in which case
 * the emails simply have no image — never a broken one.
 */
let emailLogoUrl: string | null = null;
export function setEmailLogoUrl(url: string | null): void {
  emailLogoUrl = url;
}

/** A shared, restrained HTML shell — the logo, a heading, body paragraphs, and an optional
 *  call-to-action button. No web fonts (many clients block them); system font stack only. */
function shell(heading: string, paragraphs: string[], cta?: { label: string; url: string }, footer?: string): string {
  // `alt=""` on purpose: the school name is already the heading, so a client with images off should
  // show nothing here rather than repeat it.
  const logo = emailLogoUrl ? `<p style="margin:0 0 18px;"><img src="${esc(emailLogoUrl)}" alt="" style="max-height:48px;max-width:180px;width:auto;height:auto;border:0;" /></p>` : '';
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2d28;">${p}</p>`).join('');
  const button = cta
    ? `<p style="margin:22px 0;"><a href="${esc(cta.url)}" style="background:#1FA37A;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">${esc(cta.label)}</a></p>`
    : '';
  const foot = footer ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#8a978f;">${esc(footer)}</p>` : '';
  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">',
    logo,
    `<h1 style="font-size:19px;line-height:1.35;color:#0E1814;margin:0 0 16px;">${esc(heading)}</h1>`,
    body,
    button,
    foot,
    '</div>',
  ].join('');
}

/**
 * Parent-portal invite (§12 door 1).
 *
 * `email` is the address this is being sent to, and it is named IN the message on purpose: a parent has
 * no username of their own — their account is created with the username set to this address — and the
 * sign-in form asks for a "username", so the invite is the right place to say which one is theirs.
 */
export function inviteEmail(schoolName: string, guardianName: string, url: string, email?: string): Email {
  const hi = guardianName ? `Assalāmu ʿalaykum ${guardianName},` : 'Assalāmu ʿalaykum,';
  const subject = `Set up your ${schoolName} parent account`;
  const signIn = email ? `You'll sign in with this email address: ${email}` : 'You’ll sign in with this email address.';
  const text = [
    hi,
    '',
    `${schoolName} has invited you to the parent portal, where you can see your family balance and pay tuition by card.`,
    '',
    'Set your password to get started:',
    url,
    '',
    signIn,
    '',
    'This link works once and expires in 7 days. If it has expired, please ask the office for a new invite.',
  ].join('\n');
  const html = shell(
    hi,
    [
      `${esc(schoolName)} has invited you to the <strong>parent portal</strong> — see your family balance and pay tuition by card.`,
      'Set your password to get started:',
    ],
    { label: 'Set up my account', url },
    `${esc(signIn)} This link works once and expires in 7 days. If it has expired, ask the office for a new invite.`,
  );
  return { subject, text, html };
}

/** Payment receipt (§13.2.5 — wording is "payment", never "donation"). */
export function receiptEmail(schoolName: string, amountFormatted: string, portalUrl: string): Email {
  const subject = `Your ${schoolName} payment of ${amountFormatted}`;
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `We've received your tuition payment of ${amountFormatted}. JazākumAllāhuKhayran.`,
    '',
    portalUrl ? `You can see your balance and payment history any time in the parent portal:\n${portalUrl}` : 'You can see your balance and payment history any time in the parent portal.',
    '',
    `— ${schoolName}`,
  ].join('\n');
  const html = shell(
    'Payment received',
    [
      `We've received your tuition <strong>payment of ${esc(amountFormatted)}</strong>. JazākumAllāhuKhayran.`,
      'You can see your balance and payment history any time in the parent portal.',
    ],
    portalUrl ? { label: 'Open the parent portal', url: portalUrl } : undefined,
    `— ${schoolName}`,
  );
  return { subject, text, html };
}

/** Autopay charge failed (§13.3). `final` = the third strike, after which autopay is turned off. */
export function autopayFailureEmail(schoolName: string, portalUrl: string, final: boolean): Email {
  if (final) {
    const subject = `Autopay turned off for your ${schoolName} account`;
    const text = [
      'Assalāmu ʿalaykum,',
      '',
      `We tried to charge your saved card for tuition a few times but it didn't go through, so we've turned autopay off for now.`,
      '',
      portalUrl ? `Please pay your balance and update your card in the parent portal — then you can switch autopay back on:\n${portalUrl}` : 'Please pay your balance and update your card in the parent portal — then you can switch autopay back on.',
      '',
      `— ${schoolName}`,
    ].join('\n');
    const html = shell(
      'Autopay has been turned off',
      [
        `We tried to charge your saved card for tuition a few times but it didn't go through, so we've turned autopay off for now.`,
        'Please pay your balance and update your card in the portal — then you can switch autopay back on.',
      ],
      portalUrl ? { label: 'Pay now & update card', url: portalUrl } : undefined,
      `— ${schoolName}`,
    );
    return { subject, text, html };
  }
  const subject = `We couldn't charge your card for ${schoolName} tuition`;
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `We tried to charge your saved card for tuition but it didn't go through. We'll try again automatically in a few days.`,
    '',
    portalUrl ? `You can also pay now or update your card in the parent portal:\n${portalUrl}` : 'You can also pay now or update your card in the parent portal.',
    '',
    `— ${schoolName}`,
  ].join('\n');
  const html = shell(
    "We couldn't charge your card",
    [
      `We tried to charge your saved card for tuition but it didn't go through. We'll try again automatically in a few days.`,
      'You can also pay now or update your card in the portal.',
    ],
    portalUrl ? { label: 'Pay now or update card', url: portalUrl } : undefined,
    `— ${schoolName}`,
  );
  return { subject, text, html };
}

/** Password reset (§12). */
export function resetEmail(schoolName: string, url: string): Email {
  const subject = `Reset your ${schoolName} password`;
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `We received a request to reset the password for your ${schoolName} account. Set a new password here:`,
    url,
    '',
    "This link works once and expires in 1 hour. If you didn't ask to reset your password, you can ignore this email — nothing will change.",
  ].join('\n');
  const html = shell(
    'Reset your password',
    [
      `We received a request to reset the password for your <strong>${esc(schoolName)}</strong> account.`,
      'Set a new password:',
    ],
    { label: 'Set a new password', url },
    "This link works once and expires in 1 hour. If you didn't ask to reset your password, ignore this email — nothing will change.",
  );
  return { subject, text, html };
}

/** Admin "send test" probe. */
export function testEmail(schoolName: string): Email {
  const subject = `${schoolName}: test email`;
  const text = `This is a test email from ${schoolName}. If you received it, your email settings are working.`;
  const html = shell('Email is working', [`This is a test email from <strong>${esc(schoolName)}</strong>. If you received it, your email settings are working.`]);
  return { subject, text, html };
}
