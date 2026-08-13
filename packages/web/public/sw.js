// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The service worker — and it is deliberately the smallest one that does its job (0.48.0).
 *
 * WHY IT EXISTS AT ALL. Chrome will only offer to install a web app — the `beforeinstallprompt` event, and
 * so the one-tap "Add to home screen" button in the portal — when the site has a service worker that can
 * answer a navigation while offline. Without one there is no event and no button, on any Android browser.
 * That is the entire reason this file is here.
 *
 * WHAT IT MUST NOT DO, which matters more. This app shipped a bug in 0.48.0-dev.24 titled "never cache the
 * SPA shell, so an update takes effect": a cached `index.html` meant masajid kept running an old bundle
 * after updating, and the fix was to make the shell uncacheable. A service worker is the strongest possible
 * version of that same mistake — it can serve a stale app for as long as it likes, from outside the page's
 * control. So:
 *
 *   - `index.html` is NEVER cached, and neither is any JS, CSS, font or API response. Nothing this worker
 *     does can make the app stale. An update takes effect exactly as it does today.
 *   - The ONLY cached thing is `offline.html`, a static page that says "you are offline". It has no version
 *     of the app in it, so it cannot go out of date.
 *   - Only NAVIGATIONS are intercepted, and only to substitute that page when the network has actually
 *     failed. Every other request is left completely alone — no `respondWith`, so the browser does exactly
 *     what it would with no worker installed.
 *   - `skipWaiting` + `clients.claim`, so a new worker replaces the old one immediately rather than waiting
 *     for every tab to close. A worker that lingers is the other half of how these go wrong.
 *
 * TO REMOVE IT LATER, if it ever proves to be a mistake: ship this file containing only a
 * `self.registration.unregister()` in `activate`. Browsers re-check the worker script on navigation, so
 * that is a real kill switch rather than a hope.
 */

/** Bumping this discards the old cache on activate. It names one static page, so it changes rarely. */
const CACHE = 'omos-students-offline-v1';
const OFFLINE_URL = 'offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` so installing a new worker fetches a fresh copy rather than one the HTTP cache is holding.
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Anything from an older version of this worker goes. There is only ever one entry, but leaving
      // orphaned caches on a family's phone is untidy at best.
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // Navigations only. Everything else — the bundle, the fonts, every tRPC call — is untouched, which is
  // what keeps this worker incapable of serving a stale app.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      try {
        // Straight to the network, every time. No cache-first, no stale-while-revalidate: the shell must
        // always be the current one.
        return await fetch(event.request);
      } catch {
        // Genuinely offline. Serve the static page; if even that is missing, let the browser show its own
        // error rather than throwing inside the worker.
        const cache = await caches.open(CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return offline ?? Response.error();
      }
    })(),
  );
});
