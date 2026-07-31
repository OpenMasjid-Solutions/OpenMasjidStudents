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
import { trpc } from '../../lib/trpc';
import { FamilyHome } from './Home';
import { FamilyPayMethods } from './PayMethods';

type Tab = 'home' | 'autopay';

export function FamilyApp() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const onSignedOut = () => void utils.auth.session.invalidate();
  const [tab, setTab] = useState<Tab>('home');
  // Cached by TanStack Query — Home asks for this too, so the tab bar costs no extra request.
  const payConfig = trpc.portal.payConfig.useQuery();
  const cardsOn = !!payConfig.data?.ready;
  // With cards unavailable there is no second tab, and the page is exactly what it was before.
  const active: Tab = cardsOn ? tab : 'home';

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
        {cardsOn && (
          <nav className="fam-tabs" role="tablist" aria-label={t('family.title')}>
            {(['home', 'autopay'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={active === k}
                className={`fam-tab ${active === k ? 'is-active' : ''}`}
                onClick={() => setTab(k)}
              >
                {t(k === 'home' ? 'family.myFamily' : 'family.autopayCards')}
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
