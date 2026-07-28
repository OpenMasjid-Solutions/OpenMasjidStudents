// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The floating bottom dock — primary nav + open/minimized windows (the family shell,
 * matching OpenMasjidOS/Kiosk/Display). Adapted from OpenMasjidOS packages/ui/Dock:
 * our nav is a small fixed set of sections (state-driven, no router / no app-pinning),
 * given as `items` so each role's shell (admin / finance) supplies its own set.
 * Open windows restore from the dock. Uses the ported .dock/.dock-item styles (§15).
 */
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, GraduationCap, Wallet, CalendarRange, Layers, UserCog, Settings as SettingsIcon, AppWindow } from 'lucide-react';
import { cn } from '../lib/cn';
import { useWindows } from './Windows';

/** Admin sections (Dock is generic; this union just types the admin shell's state). */
export type Section = 'dashboard' | 'students' | 'year' | 'structure' | 'billing' | 'staff' | 'settings';
/** Finance sections — finance runs billing, and READS the year view and the student roster (§5). */
export type FinanceSection = 'billing' | 'year' | 'students';

export interface DockItem {
  id: string;
  icon: ReactNode;
  /** i18n key for the label. */
  labelKey: string;
}

export const ADMIN_ITEMS: DockItem[] = [
  { id: 'dashboard', icon: <LayoutGrid size={20} />, labelKey: 'nav.dashboard' },
  { id: 'students', icon: <GraduationCap size={20} />, labelKey: 'nav.students' },
  { id: 'year', icon: <CalendarRange size={20} />, labelKey: 'nav.year' },
  { id: 'structure', icon: <Layers size={20} />, labelKey: 'nav.structure' },
  { id: 'billing', icon: <Wallet size={20} />, labelKey: 'nav.billing' },
  { id: 'staff', icon: <UserCog size={20} />, labelKey: 'nav.staff' },
  { id: 'settings', icon: <SettingsIcon size={20} />, labelKey: 'nav.settings' },
];

export const FINANCE_ITEMS: DockItem[] = [
  { id: 'billing', icon: <Wallet size={20} />, labelKey: 'nav.billing' },
  { id: 'students', icon: <GraduationCap size={20} />, labelKey: 'nav.students' },
  { id: 'year', icon: <CalendarRange size={20} />, labelKey: 'nav.year' },
];

export function Dock({ items, active, onNavigate }: { items: DockItem[]; active: string; onNavigate: (id: string) => void }) {
  const { t } = useTranslation();
  const { windows, restore } = useWindows();

  return (
    <nav className="dock glass-dock" aria-label={t('nav.primary')}>
      {items.map((it) => (
        <button key={it.id} type="button" className={cn('dock-item', active === it.id && 'is-active')} aria-label={t(it.labelKey)} onClick={() => onNavigate(it.id)}>
          {it.icon}
          <span className="dock-pop"><span className="dock-tip glass-raised">{t(it.labelKey)}</span></span>
        </button>
      ))}

      {windows.length > 0 && <span className="dock-divider" aria-hidden="true" />}

      {windows.map((w) => (
        <button key={w.id} type="button" className="dock-item dock-item--window" aria-label={w.title} onClick={() => restore(w.id)}>
          <AppWindow size={20} />
          {w.minimized && <span className="dock-dot" aria-hidden="true" />}
          <span className="dock-pop"><span className="dock-tip glass-raised">{w.title}</span></span>
        </button>
      ))}
    </nav>
  );
}
