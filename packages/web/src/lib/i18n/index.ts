// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * i18next setup. **English only** — the Arabic and Urdu locales and the language picker were
 * removed by decision; this app ships one language.
 *
 * Every user-facing string still goes through here rather than being hardcoded in components
 * (CLAUDE.md §16): it keeps copy in one reviewable file, and it means adding a locale later is
 * dropping in a JSON file rather than re-auditing every component.
 *
 * (Adapted from OpenMasjidOS packages/ui/src/lib/i18n, which also ships `en` only.)
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
