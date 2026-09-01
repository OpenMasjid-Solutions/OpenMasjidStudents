// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The authenticated desktop shell — brand + clock + profile up top, the active section
 * as the page, floating windows, and the bottom dock. Mirrors OpenMasjidOS AppShell so
 * a masjid admin can't tell they left the platform (§15). Windows + dock require a
 * WindowsProvider ancestor.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { Clock } from './Clock';
import { ProfileMenu } from './ProfileMenu';
import { WindowManager } from './WindowManager';
import { SceneBackground } from './SceneBackground';
import { StudentsMark } from './StudentsMark';
import { Dock, type DockItem } from './Dock';
import { useWindows } from './Windows';

/**
 * Loaded on demand, and that is not a micro-optimization: WhatsNew inlines the whole CHANGELOG.md
 * (~80 KB of text across 43 releases). In the main bundle that would be downloaded by every login on
 * every device — including a parent on a phone, who has no release notes button at all — to be read
 * roughly once per update. As its own chunk it costs nothing until someone opens the menu item.
 */
const WhatsNew = lazy(() => import('./WhatsNew').then((m) => ({ default: m.WhatsNew })));

export function AppShell({
  items,
  active,
  onNavigate,
  onSignedOut,
  children,
}: {
  items: DockItem[];
  active: string;
  onNavigate: (id: string) => void;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { open } = useWindows();
  // The release notes are a window like any other record, so they behave like the rest of the desk:
  // movable, dedupable, and they don't take the screen away from what you were doing.
  const openWhatsNew = () =>
    open({
      title: t('whatsNew.title'),
      wide: true,
      dedupeKey: 'whats-new',
      icon: <Sparkles size={15} />,
      node: (
        <Suspense fallback={<p className="empty">{t('common.loading')}</p>}>
          <WhatsNew />
        </Suspense>
      ),
    });

  return (
    <div className="app-shell">
      <SceneBackground />
      <div className="topbar">
        <span className="admin-brand">
          {/* The app's own mark, not the platform's — this is the Students dashboard (0.48.0). */}
          <span className="mark"><StudentsMark size={24} /></span>
          {t('app.name')}
        </span>
        <div style={{ marginInlineStart: 'auto', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <Clock />
          <ProfileMenu onSignedOut={onSignedOut} onWhatsNew={openWhatsNew} />
        </div>
      </div>
      <main className="app-main">{children}</main>
      <WindowManager />
      <Dock items={items} active={active} onNavigate={onNavigate} />
    </div>
  );
}
