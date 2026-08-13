// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The parent portal shell — phone-first (CLAUDE.md §15), NOT the windowed staff shell. A sticky
 *  top bar (brand + account menu: theme/language/sign-out) over a single scrolling column.
 *
 *  TWO TABS (0.44.0), not one long page. Autopay and saved cards used to be the last thing below the
 *  balance, the children, every open bill and the whole payment history — so on a phone the feature
 *  that saves a family from thinking about tuition at all was several screens of scrolling past
 *  everything else, and most parents never knew it existed. It is its own tab now, with a card at the
 *  top of the home tab offering to set it up. The tab only appears when card payments are actually
 *  configured; with no Stripe account there is nothing behind it. */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SceneBackground } from '../../components/SceneBackground';
import { ProfileMenu } from '../../components/ProfileMenu';
import { MasjidMark } from '../../components/Glyphs';
import { InstallPrompt } from '../../components/InstallPrompt';
import { trpc } from '../../lib/trpc';
import { FamilyHome } from './Home';
import { FamilyPayMethods } from './PayMethods';
import { FamilyYear } from './Year';

/** The year tab is always available — it needs no Stripe account, only a school year (0.48.0). The
 *  autopay tab still appears only when card payments are configured; there is nothing behind it otherwise. */
type Tab = 'home' | 'year' | 'autopay';

export function FamilyApp() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const onSignedOut = () => void utils.auth.session.invalidate();
  const [tab, setTab] = useState<Tab>('home');
  // Cached by TanStack Query — Home asks for this too, so the tab bar costs no extra request.
  const payConfig = trpc.portal.payConfig.useQuery();
  const cardsOn = !!payConfig.data?.ready;
  // With cards unavailable there is no second tab, and the page is exactly what it was before.
  const active: Tab = tab === 'autopay' && !cardsOn ? 'home' : tab;
  /** The year tab has no Stripe dependency, so the bar is worth drawing even without cards. */
  const tabs: Tab[] = cardsOn ? ['home', 'year', 'autopay'] : ['home', 'year'];

  return (
    <div className="family-shell">
      <SceneBackground />
      <header className="family-topbar">
        <span className="brand">
          <span className="mark"><MasjidMark size={22} /></span>
          {t('family.title')}
        </span>
        <span className="spacer" />
        <ProfileMenu onSignedOut={onSignedOut} />
      </header>
      <main className="family-main">
        {tabs.length > 1 && (
          <nav className="fam-tabs" role="tablist" aria-label={t('family.title')}>
            {tabs.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={active === k}
                className={`fam-tab ${active === k ? 'is-active' : ''}`}
                onClick={() => setTab(k)}
              >
                {t(k === 'home' ? 'family.myFamily' : k === 'year' ? 'famYear.tab' : 'family.autopayCards')}
              </button>
            ))}
          </nav>
        )}
        {active === 'home' ? (
          <>
            <div className="fam-hello">
              <h1>{t('family.myFamily')}</h1>
              <p>{t('family.subtitle')}</p>
            </div>
            {/* The home tab's autopay card sends the parent here rather than opening a dialog. */}
            <FamilyHome onManageAutopay={() => setTab('autopay')} />
            {/* "Add this to your phone" — LAST on the page and only on the home tab, because a parent
                arriving to pay should reach the balance first. It hides itself when already installed, on a
                desktop, or once dismissed (components/InstallPrompt). */}
            <InstallPrompt />
          </>
        ) : active === 'year' ? (
          <>
            <div className="fam-hello">
              <h1>{t('famYear.title')}</h1>
              <p>{t('famYear.sub')}</p>
            </div>
            <FamilyYear />
          </>
        ) : (
          <>
            <div className="fam-hello">
              <h1>{t('family.autopayCards')}</h1>
              <p>{t('family.autopayTabSub')}</p>
            </div>
            <FamilyPayMethods />
          </>
        )}
      </main>
    </div>
  );
}
