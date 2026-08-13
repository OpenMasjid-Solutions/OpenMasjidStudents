// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Register the service worker (0.48.0).
 *
 * WHY: Chrome only fires `beforeinstallprompt` — and so only offers the portal's one-tap install button —
 * for a site with a service worker that can answer a navigation offline. No worker, no button, on any
 * Android browser. `public/sw.js` is the smallest worker that qualifies and caches nothing but a static
 * offline page; read its header before changing anything here.
 *
 * SCOPE AND THE TUNNEL PREFIX. A worker's scope is the directory it is served from, so the URL has to carry
 * the base path: at the root it is `/sw.js` with scope `/`, and behind the OpenMasjidOS tunnel it is
 * `/students/sw.js` with scope `/students/` — which is what the manifest's `scope: './'` resolves to as
 * well. Registering the root path under a prefix would be refused by the browser, silently leaving no
 * worker and no install button.
 *
 * NOT IN DEV. Vite serves the app from memory there, and a worker sitting in front of that is a well-known
 * way to spend an afternoon debugging a page that will not update. `import.meta.env.PROD` keeps it to
 * builds, which is also the only place `public/sw.js` is served from.
 */
import { withBase } from './base';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // After load, so registering never competes with the first paint or the first data fetch on a phone.
  window.addEventListener('load', () => {
    // `withBase('/')` is "/" at the root and "/students/" behind the tunnel — already the directory the
    // worker sits in, and already trailing-slashed, which is what a scope has to be.
    void navigator.serviceWorker.register(withBase('/sw.js'), { scope: withBase('/') }).catch(() => {
      // A refused registration is not worth an error to the user: everything works without it, and the
      // only thing lost is the install button (the instructions still show). Swallowed deliberately.
    });
  });
}
