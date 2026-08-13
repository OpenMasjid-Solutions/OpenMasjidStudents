// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * This app's own brand mark — the crescent, dome and ledger from the Students icon (0.48.0).
 *
 * A SEPARATE FILE from `Glyphs.tsx` on purpose: that one is ported verbatim from OpenMasjidOS and has to
 * stay structurally identical so theme fixes can be re-synced (§15). Its `MasjidMark` is the platform's
 * logo and still belongs on the sign-in screens, which are OpenMasjid's front door. This is the app's.
 *
 * A CSS MASK FILLED WITH `currentColor`, the same treatment `MasjidMark` gets — and the reason this works
 * is that `students-mark.svg` is a STENCIL: everything the artwork draws dark is solid, and everything it
 * draws white is a HOLE (see scripts/build-brand-icons.cjs). The white parts are counters, not decoration
 * — the wordmark sits on the dark crescent, the ledger badge on a white disc — so on a dark topbar they
 * read as black lettering and a black blob. As holes they let the topbar through, which is what the design
 * means by white.
 *
 * A mask uses only the alpha, so the mark takes the theme's own ink at any size and needs no inverting,
 * no second asset, and no rule keyed to `data-theme`.
 */
import markUrl from '../assets/students-mark.svg';

export function StudentsMark({ size = 28, className }: { size?: number; className?: string }) {
  const mask = `url(${markUrl}) center / contain no-repeat`;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        backgroundColor: 'currentColor',
        WebkitMask: mask,
        mask,
      }}
    />
  );
}
