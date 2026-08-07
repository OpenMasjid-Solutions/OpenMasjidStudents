// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The one way this app opens a printable document (0.48.0).
 *
 * On a desktop it is exactly what it was: a link that opens the page in a new tab, where the browser's own
 * Print gives a clean sheet.
 *
 * ON A PHONE IT SHARES A PDF INSTEAD, and the reason is specific: **iOS Safari stamps its own header and
 * footer — the date, the page title, the URL — onto anything it prints, and there is no way to turn that
 * off.** A masjid's statement should not reach a parent with Safari's furniture across the top. So on a
 * device that can share files we fetch the document, build a PDF from it ourselves (lib/sheetPdf.ts) and
 * hand it to the OS share sheet — mail, WhatsApp, Files, or a printer, all from one tap, and no stamp.
 *
 * EVERY FAILURE FALLS BACK TO OPENING THE PAGE. No share support, a fetch that fails, a document holding
 * text the built-in PDF fonts cannot encode (see `safeText` — Arabic script is the real case) — all of them
 * end with the link doing what it always did. The office is never left with a button that did nothing.
 *
 * The PDF is built in the browser, so the document never leaves the masjid's own device to become one.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { withBase } from '../lib/base';

/** Can this device hand a FILE to the OS share sheet? Desktop Chrome/Firefox report `share` but not files. */
function canSharePdf(): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  try {
    return navigator.canShare({ files: [new File([new Blob(['x'], { type: 'application/pdf' })], 'x.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

export function PrintableLink({
  path,
  filename,
  title,
  className = 'btn btn--ghost btn--sm',
  children,
  linkTitle,
}: {
  /** App-relative document path, e.g. `/invoices/inv_1`. */
  path: string;
  /** What the shared file is called. `.pdf` is appended. */
  filename: string;
  /** The document's own title — what a share sheet and a mail attachment show. */
  title: string;
  className?: string;
  children: ReactNode;
  linkTitle?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const href = withBase(path);

  async function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!canSharePdf()) return; // desktop: let the link open the page, as always
    e.preventDefault();
    setBusy(true);
    try {
      // Same-origin and authed: these documents are behind the session cookie (§14).
      const res = await fetch(href, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const { sheetToPdf } = await import('../lib/sheetPdf');
      const bytes = await sheetToPdf(await res.text(), title);
      const file = new File([new Uint8Array(bytes)], `${filename}.pdf`, { type: 'application/pdf' });
      await navigator.share({ files: [file], title });
    } catch (err) {
      // A cancelled share is the parent changing their mind, not a failure — leave them where they were.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Anything else: do what the link would have done. Opening in a new tab from a click handler is
      // allowed here because this is still inside the user's own gesture.
      window.open(href, '_blank', 'noopener,noreferrer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={linkTitle}
      aria-busy={busy || undefined}
      onClick={(e) => void onClick(e)}
    >
      {busy ? t('common.loading') : children}
    </a>
  );
}
