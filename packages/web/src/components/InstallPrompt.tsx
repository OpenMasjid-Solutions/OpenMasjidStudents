// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "Add this to your phone" — the offer, and where possible the button (0.48.0).
 *
 * WHAT THE BROWSERS ACTUALLY ALLOW, which is what shapes this:
 *
 *   - **Android (Chrome, Edge, Samsung Internet)** fire a `beforeinstallprompt` event. Cancel it, keep the
 *     event, and calling `prompt()` from a real tap opens the browser's own install sheet — a genuine
 *     one-tap install. That is the button below.
 *   - **iOS Safari has no install API AT ALL.** There is no event to listen for and nothing a page can
 *     call; Add to Home Screen lives behind the Share sheet and only the user can reach it. So on an
 *     iPhone the honest thing is to say where it is, in the order the taps happen. Anything that looks
 *     like a button would be a lie.
 *   - Chrome only fires that event when the site meets its install criteria, which include a service
 *     worker that answers a navigation offline. This app deliberately has none — see the note in the
 *     README/CHANGELOG — so today the event does not fire and every platform gets instructions. The
 *     listener stays because it costs nothing and lights the button up by itself the day that changes.
 *
 * NOT SHOWN when it would be noise: already installed (either display-mode or iOS's own flag), on a
 * desktop, or once the parent has dismissed it. Dismissal is remembered in `localStorage` — a nag that
 * comes back is worse than no offer, and this is the screen a family opens to pay.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, Plus, X, Download } from 'lucide-react';

/** The event Chrome fires; not in TypeScript's DOM lib, so the two methods we use are declared here. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'omos-students:install-dismissed';

/** Already running as an installed app? `standalone` is iOS's own non-standard flag. */
function isInstalled(): boolean {
  if (typeof window === 'undefined') return true;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches;
}

/** A phone or tablet — the only place a home-screen icon means anything. */
function isMobile(): boolean {
  if (typeof window === 'undefined') return false;
  // Coarse pointer + no hover is the reliable signal; a user-agent string is not.
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports itself as a Mac, hence the touch-points half.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function InstallPrompt() {
  const { t } = useTranslation();
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // A browser with storage blocked simply gets the offer each visit rather than an error.
    }
    if (dismissed || isInstalled() || !isMobile()) return;
    setHidden(false);

    const onPrompt = (e: Event) => {
      // Cancel the browser's own mini-infobar so the offer appears where we put it, then keep the event —
      // it is the only handle on the install sheet and it cannot be re-created.
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    // Installed while the page was open (from our button or the browser's menu): the offer is now noise.
    const onInstalled = () => setHidden(true);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function dismiss() {
    setHidden(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* nothing to remember it with; it will offer again next visit */
    }
  }

  async function install() {
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // The event is single-use whichever way it went, so it goes either way. A parent who said no is not
    // asked again by us; the browser's own menu is still there if they change their mind.
    setEvent(null);
    if (outcome === 'accepted') setHidden(true);
    else dismiss();
  }

  if (hidden) return null;

  return (
    <section className="install-card glass" aria-labelledby="install-title">
      <button type="button" className="install-close" onClick={dismiss} aria-label={t('common.dismiss')}>
        <X size={15} />
      </button>
      <strong id="install-title">{t('install.title')}</strong>
      <p>{t('install.why')}</p>
      {event ? (
        <button type="button" className="btn btn--primary" onClick={() => void install()}>
          <Download size={15} /> {t('install.action')}
        </button>
      ) : isIos() ? (
        /* Safari's Share sheet, in tap order. Icons rather than the word "Share", because the button on
           the phone is an icon and a parent is looking for a shape. */
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
    </section>
  );
}
