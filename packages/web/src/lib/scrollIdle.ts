// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Marks the document while it is being scrolled, so ambient animation can stand aside.
 *
 * The reason this earns its keep is not the animation — the aurora drift is a transform on a promoted
 * layer and costs almost nothing by itself. It is that the drift sits BEHIND every frosted surface in
 * the app, and `backdrop-filter` has to recompute whenever what is behind it changes. So a decoration
 * looping forever quietly holds the whole page's glass in a permanent repaint loop, and the frame it
 * competes for hardest is the one where the user is moving a long list.
 *
 * Freezing it for the duration of a scroll is free in both directions: `animation-play-state: paused`
 * (shell.css) stops the drift where it stands and resumes from there, so nothing jumps, and a
 * 32-second loop is not something anyone is tracking while scrolling.
 *
 * One delegated listener, and the attribute is written twice per scroll GESTURE rather than per event —
 * setting it on every scroll event would trade one repaint for a style recalc, which is not a trade.
 * Capture phase because a scroll event does not bubble: this is the only way one window-level listener
 * hears a window body, a table's horizontal scroller and the page itself (`cursorFx.ts` listens the
 * same way, for the same reason).
 */

/**
 * How long after the last scroll event the drift resumes.
 *
 * Long enough to cover the gap between a trackpad's momentum frames and a wheel's discrete notches —
 * below about 120ms the attribute flickers off mid-gesture, which is worse than not pausing at all
 * because each flicker is its own recalc. Short enough that letting go of a list feels like the page
 * comes back to life rather than catching up.
 */
const IDLE_MS = 180;

/**
 * The attribute this writes, and the one shell.css selects on.
 *
 * Exported because it is a fact held in two files that must agree, and disagreeing is silent: renaming
 * it here would leave the CSS selecting an attribute nothing writes, and the drift would simply never
 * pause again with no error anywhere to say so. `styles/paintCost.test.ts` asserts the stylesheet still
 * selects this exact name, which is the only thing that can catch it.
 */
export const SCROLLING_ATTR = 'data-scrolling';

let installed = false;

export function installScrollIdle(): void {
  if (typeof window === 'undefined') return;
  if (installed) return; // idempotent — never stack duplicate listeners
  installed = true;

  const root = document.documentElement;
  let scrolling = false;
  let timer: number | undefined;

  function settle() {
    timer = undefined;
    scrolling = false;
    root.removeAttribute(SCROLLING_ATTR);
  }

  window.addEventListener(
    'scroll',
    () => {
      if (!scrolling) {
        scrolling = true;
        root.setAttribute(SCROLLING_ATTR, '');
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = window.setTimeout(settle, IDLE_MS);
    },
    { passive: true, capture: true },
  );
}
