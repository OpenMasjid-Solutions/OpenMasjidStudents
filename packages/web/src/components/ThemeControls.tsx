// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Theme (dark/light/system) switch. Positionless — wrapped by ShellControls on auth screens,
 *  used inline in the admin topbar. (Was ThemeLangControls; the language picker was removed when
 *  the app went English-only.) */
import { useTranslation } from 'react-i18next';
import { usePrefs, prefsStore } from '../lib/prefs';
import { stopFollowing } from '../lib/appearance';

const THEMES = ['dark', 'light', 'system'] as const;

export function ThemeControls() {
  const { t } = useTranslation();
  const prefs = usePrefs();

  function cycleTheme() {
    stopFollowing(); // a manual theme choice → stop inheriting the OS theme (§15)
    const i = THEMES.indexOf(prefs.theme);
    prefsStore.patch({ theme: THEMES[(i + 1) % THEMES.length] });
  }

  return (
    <button type="button" className="btn btn--ghost btn--sm fx-glint" onClick={cycleTheme} title={t('controls.theme')}>
      {t(`theme.${prefs.theme}`)}
    </button>
  );
}
