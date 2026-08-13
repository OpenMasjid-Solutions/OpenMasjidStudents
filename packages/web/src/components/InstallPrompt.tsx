// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "Add this to your phone" — a pop-up, on every signed-in surface (0.48.0).
 *
 * WHAT THE BROWSERS ALLOW, which is what shapes this:
 *
 *   - **Android (Chrome, Edge, Samsung Internet)** fire `beforeinstallprompt`. Cancel it, keep the event,
 *     and calling `prompt()` from a real tap opens the browser's own install sheet — a genuine one-tap
 *     install. That is the button. It only fires because this app now registers a service worker
 *     (`public/sw.js`), which is Chrome's condition for offering to install at all.
 *   - **iOS Safari has no install API AT ALL** — no event, nothing callable. Add to Home Screen lives
 *     behind the Share sheet and only the user can reach it, so an iPhone gets the two taps in order.
 *     Anything button-shaped there would be a lie.
 *
 * THREE WAYS OUT, and every one of them is remembered:
 *   - installed (or the native sheet accepted) → never asked again, because there is nothing to ask
 *   - **Remind me later** → quiet for a week. Also what the backdrop, Escape and the × do, so no accidental
 *     exit is treated as a refusal.
 *   - **Don't show again** → never, on this device.
 * A prompt that reappears every visit is worse than no prompt, and this one covers the screen.
 *
 * NOT SHOWN when it would be noise: already installed (display-mode, or iOS's own flag), on a desktop, or
 * inside the snooze. It waits a moment after mount as well — appearing while the page is still painting
 * reads as an advert rather than an offer.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Share, Plus, X, Download, Smartphone } from 'lucide-react';

/** The event Chrome fires; not in TypeScript's DOM lib, so the two members we use are declared here. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const NEVER_KEY = 'omos-students:install-never';
const SNOOZE_KEY = 'omos-students:install-snooze';
/** How long "Remind me later" stays quiet. Long enough not to nag, short enough to catch a second term. */
const SNOOZE_DAYS = 7;
/** Let the screen paint and settle first. */
const APPEAR_AFTER_MS = 1200;

/** localStorage in a private window can throw on read as well as write, so both are wrapped. */
function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing to remember it with; it will offer again next visit */
  }
}

/** Already running as an installed app? `standalone` is iOS's own non-standard flag. */
function isInstalled(): boolean {
  if (typeof window === 'undefined') return true;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches;
}

/** A phone or tablet — the only place a home-screen icon means anything. A coarse pointer with no hover is
 *  the reliable signal; a user-agent string is not. */
function isMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports itself as a Mac, hence the touch-points half.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Everything that has to be true before a parent or a volunteer is interrupted. */
function shouldOffer(): boolean {
  if (isInstalled() || !isMobile()) return false;
  if (readStore(NEVER_KEY) === '1') return false;
  const until = Number(readStore(SNOOZE_KEY) ?? 0);
  return !(Number.isFinite(until) && until > Date.now());
}

export function InstallPrompt() {
  const { t } = useTranslation();
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!shouldOffer()) return;
    const timer = window.setTimeout(() => setOpen(true), APPEAR_AFTER_MS);

    const onPrompt = (e: Event) => {
      // Cancel the browser's own mini-infobar so the offer appears where we put it, then keep the event —
      // it is the only handle on the install sheet and cannot be re-created.
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    // Installed from our button or the browser's own menu while the page was open: the offer is now noise.
    const onInstalled = () => setOpen(false);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // A pop-up over the whole screen: hold focus and let Escape out, or it is a trap on a keyboard and
  // invisible to a screen reader.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') later();
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll under the sheet on a phone.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `later` is stable enough; re-binding per render would churn the listener
  }, [open]);

  /** Escape, the backdrop, the × and the button all land here: no accidental exit counts as a refusal. */
  function later() {
    writeStore(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000));
    setOpen(false);
  }

  function never() {
    writeStore(NEVER_KEY, '1');
    setOpen(false);
  }

  async function install() {
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // The event is single-use whichever way it went. Declining the native sheet is a real "no", so it is
    // snoozed rather than asked again on the next screen.
    setEvent(null);
    if (outcome === 'accepted') setOpen(false);
    else later();
  }

  if (!open) return null;

  return (
    <div className="install-scrim" role="presentation" onClick={later}>
      <motion.section
        className="install-sheet glass-raised"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-title"
        // The backdrop closes; a tap inside must not travel up to it.
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      >
        <button ref={closeRef} type="button" className="install-close" onClick={later} aria-label={t('common.dismiss')}>
          <X size={16} />
        </button>
        <span className="install-icon" aria-hidden="true"><Smartphone size={22} /></span>
        <strong id="install-title">{t('install.title')}</strong>
        <p>{t('install.why')}</p>

        {event ? (
          <button type="button" className="btn btn--primary install-cta" onClick={() => void install()}>
            <Download size={16} /> {t('install.action')}
          </button>
        ) : isIos() ? (
          /* Safari's Share sheet, in tap order. Icons rather than the words, because the thing on the phone
             is an icon and a parent is looking for a shape. */
          <ol className="install-steps">
            <li><Share size={14} /> {t('install.ios1')}</li>
            <li><Plus size={14} /> {t('install.ios2')}</li>
          </ol>
        ) : (
          <ol className="install-steps">
            <li>{t('install.android1')}</li>
            <li>{t('install.android2')}</li>
          </ol>
        )}

        <div className="install-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={later}>{t('install.later')}</button>
          <button type="button" className="link-btn install-never" onClick={never}>{t('install.never')}</button>
        </div>
      </motion.section>
    </div>
  );
}
