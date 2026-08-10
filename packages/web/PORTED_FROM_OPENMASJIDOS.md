<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Design system ported from OpenMasjidOS

Per `CLAUDE.md` §15 (UI parity is a hard requirement), the OpenMasjid family's shared
**"liquid glass"** design system is copied **verbatim** from OpenMasjidOS `packages/ui`
into this package. It is the same-org AGPL, so copying within OpenMasjid-Solutions repos
is allowed and encouraged. **Keep these files structurally identical to upstream** so
theme fixes can be re-synced; any deliberate deviation must carry a one-line comment
explaining why.

- **Upstream:** `OpenMasjid-Solutions/OpenMasjidOS` `packages/ui`
- **Pinned at commit:** `c4d309f45bff4de500cfe10a5ff6edc12c39de01` (v0.40.0)
- **Ported on:** 2026-07-15

## Files copied verbatim (each carries a 3rd-line origin comment)

| This package | Upstream path |
|---|---|
| `src/index.css` | `src/index.css` |
| `src/styles/tokens.css` | `src/styles/tokens.css` |
| `src/styles/glass.css` | `src/styles/glass.css` |
| `src/styles/app.css` | `src/styles/app.css` |
| `src/lib/motion.ts` | `src/lib/motion.ts` |
| `src/lib/cursorFx.ts` | `src/lib/cursorFx.ts` |
| `src/lib/ambient.ts` | `src/lib/ambient.ts` |
| `src/lib/cn.ts` | `src/lib/cn.ts` |
| `src/lib/prefs.ts` | `src/lib/prefs.ts` |
| `src/components/Glyphs.tsx` | `src/components/Glyphs.tsx` |
| `src/components/SceneBackground.tsx` | `src/components/SceneBackground.tsx` |
| `src/components/ErrorBoundary.tsx` | `src/components/ErrorBoundary.tsx` |
| `src/components/Clock.tsx` | `src/components/Clock.tsx` |
| `src/components/Windows.tsx` (window manager context) | `src/components/Windows.tsx` |
| `src/components/WindowManager.tsx` (mac-style window frames) | `src/components/WindowManager.tsx` |
| `src/assets/logo-mark.png` | `src/assets/logo-mark.png` |

**No longer ported: `public/favicon.svg`.** It held the OpenMasjidOS mark until 0.48.0 and is now this
app's own icon, generated from `assets/brand/student-manager-icon.svg` by
`scripts/build-brand-icons.cjs`. **Do not re-sync it from upstream** — that would put the platform's
logo back in the browser tab. `src/components/Glyphs.tsx` and `src/assets/logo-mark.png` above are
still the platform's and still ported; `MasjidMark` remains on the sign-in screens, which are
OpenMasjid's front door. The app's own mark is `src/components/StudentsMark.tsx`.

## Adapted from upstream (structure mirrored, logic simplified)

- **`src/components/AppShell.tsx`**, **`Dock.tsx`**, **`ProfileMenu.tsx`** — modelled on the
  OpenMasjidOS equivalents (same `.dock`/`.topbar`/`.menu` classes, same window+dock shell),
  but simplified for an app rather than the platform: nav is a small state-driven section set
  (no react-router, no installed-app pinning/drag), ProfileMenu has no platform `system.info`
  (version from `health`). They intentionally diverge, so they carry a normal SPDX header (not
  the verbatim origin comment).

## Adapted from OpenMasjidDonations (the tunnel + appearance family pattern)

These are copied/adapted from the sibling **`OpenMasjid-Solutions/OpenMasjidDonations`** app (same-org
AGPL), which established the shared pattern for serving one build at the root (LAN) and under an
OpenMasjidOS Cloudflare-tunnel path, plus inheriting the dashboard's appearance:

- **`src/lib/base.ts`** — runtime base path (`window.__OMOS_BASE__` → `BASE`/`withBase`/`stripBase`),
  adapted from Donations `web/src/base.ts`. Pairs with Vite `base: './'` + the server-injected
  `<base href>`.
- **`src/lib/appearance.ts`** — the CONSUMER side of the OS Fabric appearance layer (the `#omos=`
  fragment + the same-origin `/api/public/appearance` relay poll), adapted from the appearance-sync
  in Donations `web/src/prefs.ts`. Kept SEPARATE from the verbatim-ported `src/lib/prefs.ts` so that
  file stays re-syncable with OpenMasjidOS upstream.

## Deliberate additions / deviations (NOT from upstream)

- **`public/fonts/Amiri-Regular.ttf`** (+ `LICENSE-Amiri-OFL.txt`) — the OFL **Amiri**
  Naskh face, copied from `OpenMasjidDisplay/server/assets/fonts` (commit `72d0410`).
  The family **web** UIs bundle no Arabic font (OS ships only Inter + Space Grotesk),
  but this app needs Arabic-capable rendering for RTL and for report cards/transcripts
  (`CLAUDE.md` §7/§15). Wired via `src/styles/fonts-arabic.css` (a NEW file, not ported)
  so the ported CSS stays pristine.
- **`src/lib/i18n/index.ts`** loads `en` + `ar` + `ur` (upstream ships `en` only). i18n
  content is app-specific and not part of the re-syncable "theme".
- **`ambient.mp4`** (OS's 5 MB looping backdrop) was **not** copied — the ambient toggle
  has no default UI here and the scene falls back to the aurora gradient. Copy it later if
  an ambient backdrop is wanted.

## Re-syncing upstream theme fixes

When OpenMasjidOS updates its theme, diff the upstream file against ours (ignoring the
3rd-line origin comment) and reapply. Because we did not fork the structure, this stays a
clean patch.
