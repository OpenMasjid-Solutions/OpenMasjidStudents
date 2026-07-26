// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Top-right account button + menu: dark/light toggle, sign out, version.
 * Adapted from OpenMasjidOS packages/ui/src/components/ProfileMenu.tsx (no router /
 * no platform system.info — theme via prefs, version from health). See §15.
 * The language picker was removed when the app went English-only.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, LogOut, User } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { prefsStore } from '../lib/prefs';
import { stopFollowing } from '../lib/appearance';

export function ProfileMenu({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const health = trpc.health.useQuery(undefined, { retry: false });
  const logout = trpc.auth.logout.useMutation({ onSettled: onSignedOut });

  const isDark = (document.documentElement.getAttribute('data-theme') ?? 'dark') !== 'light';

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="profile-btn" aria-label={t('profile.menu')} onClick={() => setOpen((o) => !o)}>
        <User size={20} />
      </button>
      {open && (
        <div className="menu glass-raised" role="menu">
          <button className="menu-item" onClick={() => { stopFollowing(); prefsStore.patch({ theme: isDark ? 'light' : 'dark' }); }}>
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
            {isDark ? t('profile.lightMode') : t('profile.darkMode')}
          </button>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => logout.mutate()}>
            <LogOut size={16} /> {t('profile.signOut')}
          </button>
          {health.data?.version && <div className="menu-version">{t('app.name')} v{health.data.version}</div>}
        </div>
      )}
    </div>
  );
}
