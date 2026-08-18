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

/**
 * How to reach the masjid, appended to the foot of every email (0.47.0).
 *
 * MODULE-LEVEL for the same reason as the logo above: it is chrome, not content, and threading it
 * through eight builders (five of which are called from more than one place) would mean every future
 * caller has to remember it. Set alongside the logo in mail/notify.ts.
 *
 * It matters because every one of these messages ends by asking the parent to do something — pay,
 * update a card, check a balance — and none of them said who to ask when it goes wrong. A reply-to
 * address on the platform's mail is not the same as the office's own number.
 */
let emailContactLine = '';
export function setEmailContactLine(line: string | null): void {
  emailContactLine = (line ?? '').trim();
}

/** The footer for a message, with the contact appended when there is one. */
function withContact(footer: string | undefined, include: boolean): string | undefined {
  if (!include || !emailContactLine) return footer;
  return footer ? `${footer} · ${emailContactLine}` : emailContactLine;
}

/**
 * The contact as its own trailing line for a PLAIN-TEXT body.
 *
 * The text part is a complete fallback, not a courtesy — plenty of parents read mail in a client that
 * shows it — so it carries the same details rather than only the HTML doing so.
 */
function textContact(): string[] {
  return emailContactLine ? ['', emailContactLine] : [];
}

/** A shared, restrained HTML shell — the logo, a heading, body paragraphs, and an optional
 *  call-to-action button. No web fonts (many clients block them); system font stack only. */
function shell(
  heading: string,
  paragraphs: string[],
  cta?: { label: string; url: string },
  rawFooter?: string,
  /** Staff alerts and the admin's own test set this false — the office does not need its own number. */
  opts: { contact?: boolean } = {},
): string {
  const footer = withContact(rawFooter, opts.contact !== false);
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
    ...textContact(),
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
    ...textContact(),
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

/**
 * A balance whose due date has passed (0.48.0).
 *
 * A REMINDER, not a demand, and the wording is the whole point of the template (§15: plain and warm for
 * parents). A family is usually behind because a bill was missed, not because they are refusing to pay,
 * and a madrasah has to be able to send this without it reading as a collections letter. So: what is
 * owed, since when, where to pay, and an explicit line inviting them to talk to the office — which is
 * also the honest route for a family who genuinely cannot pay right now.
 *
 * WHICH CHILD, AND FOR HOW MUCH (0.50.0-dev.15). This said only "$430 of your tuition balance", on the
 * reasoning that one adult pays for the household so the amount is the household's. That is true about
 * who PAYS and wrong about what a parent can act on: a household with three children cannot tell from
 * a total whether it is one child's two missed months or three children owing a little each — and the
 * office's own digest has named the children since dev.14, so the two copies of the same fact
 * disagreed. A single-child household still reads as one sentence; the breakdown only appears when
 * there is something to break down.
 *
 * Still no Student ID — that is a payment credential, and an email is not the place for it (§14).
 * First names only, because this goes to their own parent (people/names.ts).
 */
export function pastDueEmail(
  schoolName: string,
  amountFormatted: string,
  sinceFormatted: string,
  portalUrl: string,
  behind: { name: string; amount: string }[] = [],
): Email {
  const subject = `A reminder about your ${schoolName} balance`;
  const since = sinceFormatted ? ` It has been outstanding since ${sinceFormatted}.` : '';
  // One child: name them in the sentence, because a list of one is not a list. Several: the sentence
  // keeps the total and the lines carry the split.
  const one = behind.length === 1 ? `${behind[0].name}’s ` : '';
  const opening = `This is a friendly reminder that ${amountFormatted} of ${one ? `${one}tuition` : 'your tuition balance'} is now past its due date.${since}`;
  const breakdown = behind.length > 1 ? behind.map((b) => `• ${b.name} — ${b.amount}`) : [];
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    opening,
    ...(breakdown.length ? ['', ...breakdown] : []),
    '',
    portalUrl ? `You can see the details and pay in the parent portal:\n${portalUrl}` : 'You can see the details and pay in the parent portal.',
    '',
    'If you have already paid, thank you — please ignore this. And if now is a difficult time, please speak to the office; we would rather hear from you than not.',
    '',
    `— ${schoolName}`,
    ...textContact(),
  ].join('\n');
  const html = shell(
    'A reminder about your balance',
    [
      `This is a friendly reminder that <strong>${esc(amountFormatted)}</strong> of ${one ? `${esc(one)}tuition` : 'your tuition balance'} is now past its due date.${esc(since)}`,
      ...(breakdown.length ? [breakdown.map((b) => esc(b)).join('<br>')] : []),
      'If you have already paid, thank you — please ignore this. And if now is a difficult time, please speak to the office; we would rather hear from you than not.',
    ],
    portalUrl ? { label: 'See the details & pay', url: portalUrl } : undefined,
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
      ...textContact(),
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
    ...textContact(),
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

/**
 * This period's bill has been generated (0.50.0).
 *
 * The biggest gap the app had: between one receipt and the past-due reminder that followed, a parent
 * was told nothing at all — including that a bill existed. So the first they heard of a month's
 * tuition was a message saying they were late with it.
 *
 * Names the CHILDREN, unlike the past-due reminder: this is the one message where "what is this for?"
 * is the question, and a household with three children on different plans cannot answer it from a
 * total. Still no Student ID (§14) — it is a payment credential, not a label.
 */
export function invoiceReadyEmail(schoolName: string, amountFormatted: string, dueFormatted: string, childrenLine: string, portalUrl: string): Email {
  const subject = `Your ${schoolName} tuition — ${amountFormatted}`;
  const due = dueFormatted ? ` It is due on ${dueFormatted}.` : '';
  const forWhom = childrenLine ? ` for ${childrenLine}` : '';
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `Your tuition${forWhom} is ready: ${amountFormatted}.${due}`,
    '',
    portalUrl ? `You can see the full bill and pay it in the parent portal:\n${portalUrl}` : 'You can see the full bill and pay it in the parent portal.',
    '',
    'If anything on it looks wrong, please tell the office — it is easier to fix now than later.',
    '',
    `— ${schoolName}`,
    ...textContact(),
  ].join('\n');
  const html = shell(
    'Your tuition is ready',
    [
      `Your tuition${esc(forWhom)} is ready: <strong>${esc(amountFormatted)}</strong>.${esc(due)}`,
      'You can see the full bill and pay it in the parent portal.',
      'If anything on it looks wrong, please tell the office — it is easier to fix now than later.',
    ],
    portalUrl ? { label: 'See the bill', url: portalUrl } : undefined,
    `— ${schoolName}`,
  );
  return { subject, text, html };
}

/**
 * "We'll charge your saved card on Tuesday" (0.50.0).
 *
 * A courtesy note a few days ahead, and it is the one that prevents disputes: a card charge nobody
 * expected is what makes a parent ring the bank rather than the office. It also gives them time to
 * move money, or to switch autopay off if this month is a bad one — which is a better outcome for the
 * madrasah than a decline and a retry ladder.
 *
 * Says the card by brand and last four, never anything more (§14).
 */
export function autopayUpcomingEmail(schoolName: string, amountFormatted: string, whenFormatted: string, cardLabel: string, portalUrl: string): Email {
  const subject = `${schoolName} will charge ${amountFormatted} on ${whenFormatted}`;
  const card = cardLabel ? ` your ${cardLabel}` : ' your saved card';
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `This is just so it isn't a surprise: we'll charge${card} ${amountFormatted} on ${whenFormatted}.`,
    '',
    'There is nothing you need to do.',
    '',
    portalUrl ? `If you'd rather pay another way this month, or change the card, you can do that in the parent portal:\n${portalUrl}` : 'If you’d rather pay another way this month, or change the card, you can do that in the parent portal.',
    '',
    `— ${schoolName}`,
    ...textContact(),
  ].join('\n');
  const html = shell(
    'An automatic payment is coming up',
    [
      `This is just so it isn't a surprise: we'll charge${esc(card)} <strong>${esc(amountFormatted)}</strong> on ${esc(whenFormatted)}.`,
      'There is nothing you need to do.',
      'If you’d rather pay another way this month, or change the card, you can do that in the portal.',
    ],
    portalUrl ? { label: 'Open the parent portal', url: portalUrl } : undefined,
    `— ${schoolName}`,
  );
  return { subject, text, html };
}

/**
 * A saved card is about to expire (0.50.0).
 *
 * This is how autopay stops working without anybody noticing: the card expires, the next charge
 * declines, the retry ladder runs, autopay switches itself off, and the family finds out they are
 * three months behind. One message a year per card removes the whole sequence.
 */
export function cardExpiringEmail(schoolName: string, cardLabel: string, whenFormatted: string, portalUrl: string): Email {
  const subject = `Your saved card for ${schoolName} expires soon`;
  const card = cardLabel || 'your saved card';
  const when = whenFormatted ? ` (${whenFormatted})` : '';
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `The card you have saved with us — ${card}${when} — expires soon, and automatic payments will stop working once it does.`,
    '',
    portalUrl ? `You can add a new card in the parent portal whenever suits you:\n${portalUrl}` : 'You can add a new card in the parent portal whenever suits you.',
    '',
    `— ${schoolName}`,
    ...textContact(),
  ].join('\n');
  const html = shell(
    'Your saved card expires soon',
    [
      `The card you have saved with us — <strong>${esc(card)}</strong>${esc(when)} — expires soon, and automatic payments will stop working once it does.`,
      'You can add a new card in the portal whenever suits you.',
    ],
    portalUrl ? { label: 'Add a new card', url: portalUrl } : undefined,
    `— ${schoolName}`,
  );
  return { subject, text, html };
}

/**
 * Money has gone back to the family (0.50.0).
 *
 * Rare, and exactly the kind of thing that should exist in writing on both sides: an office knows it
 * refunded, a parent should not have to take their word for it. It deliberately sets the expectation
 * about timing — a card refund takes days to appear, and "where is my money?" three days later is the
 * support call this paragraph prevents.
 */
export function refundEmail(schoolName: string, amountFormatted: string, portalUrl: string): Email {
  const subject = `${schoolName} has refunded ${amountFormatted}`;
  const text = [
    'Assalāmu ʿalaykum,',
    '',
    `We've refunded ${amountFormatted} to you.`,
    '',
    'If it went back to a card, please allow a few days for it to appear on your statement — that part is the bank’s, not ours.',
    '',
    portalUrl ? `Your balance and payment history are in the parent portal:\n${portalUrl}` : 'Your balance and payment history are in the parent portal.',
    '',
    `— ${schoolName}`,
    ...textContact(),
  ].join('\n');
  const html = shell(
    'A refund is on its way',
    [
      `We've refunded <strong>${esc(amountFormatted)}</strong> to you.`,
      'If it went back to a card, please allow a few days for it to appear on your statement — that part is the bank’s, not ours.',
      'Your balance and payment history are in the parent portal.',
    ],
    portalUrl ? { label: 'Open the parent portal', url: portalUrl } : undefined,
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
    ...textContact(),
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

/**
 * A staff alert (0.44.0) — autopay switched off, an ID locked, a payment recovered.
 *
 * Written for a volunteer, not an operator: the subject says what happened, the body says what to do
 * about it. The CTA appears only when the install has a public URL, and it points at the app rather
 * than at any particular screen — finance can follow it from anywhere, and an admin will be on the
 * masjid network anyway (§12.4).
 */
export function alertEmail(schoolName: string, title: string, body: string, appUrl: string): Email {
  const subject = `${schoolName}: ${title}`;
  const text = [body, '', appUrl ? `Open the app:\n${appUrl}` : '', `— ${schoolName}`].filter(Boolean).join('\n');
  // No contact footer: this goes to the office, and telling the office its own phone number is noise.
  const html = shell(
    title,
    [esc(body)],
    appUrl ? { label: 'Open the app', url: appUrl } : undefined,
    `You're receiving this because your email address is on the alert list for ${schoolName}. An admin can change that in Settings → Email alerts.`,
    { contact: false },
  );
  return { subject, text, html };
}

/** Admin "send test" probe. */
export function testEmail(schoolName: string): Email {
  const subject = `${schoolName}: test email`;
  const text = `This is a test email from ${schoolName}. If you received it, your email settings are working.`;
  const html = shell('Email is working', [`This is a test email from <strong>${esc(schoolName)}</strong>. If you received it, your email settings are working.`], undefined, undefined, { contact: false });
  return { subject, text, html };
}
