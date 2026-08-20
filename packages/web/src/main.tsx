// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
// Ported family design system (order matters), then our app-specific layers.
import './index.css';
import './styles/tokens.css';
import './styles/glass.css';
import './styles/app.css';
import './styles/shell.css';
import './styles/admin.css';
import './styles/family.css';
import './lib/i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { prefsStore } from './lib/prefs';
import { hydrateAppearance } from './lib/appearance';
import { installCursorFx } from './lib/cursorFx';
import { trpc, trpcClient, queryClient } from './lib/trpc';
import { registerServiceWorker } from './lib/registerSW';
import { App } from './App';

// Apply saved theme/accent/wallpaper before first paint, then adopt any OpenMasjidOS appearance
// hand-off (the #omos fragment on a dashboard "Open") so the app opens on-theme.
prefsStore.hydrate();
// The app is English-only, but a browser that used the old language picker may still have `ar`/`ur`
// in localStorage — which `applyLanguage` would honor by setting dir="rtl" on a now-English UI.
// Force it back. (prefs.ts is a verbatim port from OpenMasjidOS and is deliberately not edited.)
prefsStore.patch({ language: 'en' });
hydrateAppearance();
// Pointer-reactive light on glass surfaces (off under reduced-motion / touch).
installCursorFx();
// The service worker, in production only. It caches NOTHING of the app — its whole job is to make the app
// installable so the portal can offer a one-tap "add to home screen" (lib/registerSW.ts, public/sw.js).
registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>,
);
