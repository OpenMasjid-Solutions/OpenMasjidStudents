// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * This app's own brand mark — the crescent, dome and ledger from the Students icon (0.48.0).
 *
 * A SEPARATE FILE from `Glyphs.tsx` on purpose: that one is ported verbatim from OpenMasjidOS and has to
 * stay structurally identical so theme fixes can be re-synced (§15). Its `MasjidMark` is the platform's
 * logo and still belongs on the sign-in screens, which are OpenMasjid's front door. This is the app's.
 *
 * AN IMAGE, NOT A CSS MASK. `MasjidMark` paints its artwork as a mask filled with `currentColor`, which
 * works because it is a flat silhouette. This mark is not: the wordmark is white ON the dark crescent and
 * the ledger badge sits on a white disc, so flattening it to one colour would fuse the whole thing into an
 * unreadable blob. It is rendered as the artwork it is.
 *
 * THE INVERT IS OURS TO DO, in shell.css keyed on `data-theme` — see `students-mark.svg`, which
 * deliberately does not carry the `prefers-color-scheme` rule the favicon has. The mark is drawn dark for a
 * light background; the app's default theme is dark, and its theme toggle is independent of the OS.
 */
import markUrl from '../assets/students-mark.svg';

export function StudentsMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={markUrl}
      className={className ? `students-mark ${className}` : 'students-mark'}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      /* The topbar is a flex row; without this the intrinsic 2000px box briefly wins on first paint. */
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
