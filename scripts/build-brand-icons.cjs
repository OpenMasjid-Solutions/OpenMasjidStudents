// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Derive the app's icon files from the master artwork (0.48.0).
 *
 * The master (`assets/brand/student-manager-icon.svg`) is an export from a design tool: 733 KB, almost
 * all of it two 1348×1348 PNGs embedded as base64 — one the artwork, one a luminance mask that gives it
 * transparency — plus the book badge and the curved wordmark as real vector paths.
 *
 * 733 KB is fine for a master and wrong for everything we actually serve: the favicon is fetched on every
 * page load, and the topbar mark renders at 24 px. So this script rewrites the SAME SVG with the embedded
 * raster downscaled, leaving the vector paths untouched — the design is identical, the file is a fraction
 * of the size, and the crisp parts stay crisp.
 *
 * Two outputs, because the two jobs genuinely differ:
 *
 *   icon.svg           the catalog icon (manifest `icon:`). KEEPS the artwork's white background — it is
 *                      an app-icon tile, and that is what the design assumes.
 *   favicon.svg        the browser tab: a STENCIL (see below), filled dark and inverted under
 *                      `prefers-color-scheme: dark`. A favicon has to carry its own colour — a tab bar
 *                      gives it nothing to inherit, and the browser's own setting is the only signal.
 *   students-mark.svg  the topbar mark: the same stencil, used as a CSS mask filled with `currentColor`
 *                      (StudentsMark.tsx). A mask takes only the alpha, so the mark picks up the theme's
 *                      ink at any size — no colour of its own, no invert, nothing keyed to `data-theme`.
 *
 * WHY A STENCIL RATHER THAN AN INVERT. The mark is a near-black silhouette with WHITE DETAIL INSIDE IT:
 * the wordmark sits on the dark crescent, the ledger badge on a white disc. Inverting the whole thing
 * keeps the crescent visible on a dark bar but turns that white detail black — which is the thing that
 * looked wrong. The white is a counter, not a colour: it means "let the background through". So the
 * stencil makes it a hole, and the mark reads correctly on any background.
 *
 * Run: node scripts/build-brand-icons.cjs
 * `pngjs` is a transitive dependency; this is a one-off asset build, never runtime code, and the outputs
 * are committed — so nothing about the app's own dependencies changes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'assets/brand/student-manager-icon.svg');

/** Box-filter downscale, alpha-weighted so edge pixels do not darken against the transparency. */
function downscale(src, size) {
  const dst = new PNG({ width: size, height: size });
  const sx = src.width / size;
  const sy = src.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = Math.floor(y * sy); j < Math.max(Math.floor(y * sy) + 1, Math.floor((y + 1) * sy)); j++) {
        for (let i = Math.floor(x * sx); i < Math.max(Math.floor(x * sx) + 1, Math.floor((x + 1) * sx)); i++) {
          const o = (j * src.width + i) * 4;
          const al = src.data[o + 3] / 255;
          r += src.data[o] * al;
          g += src.data[o + 1] * al;
          b += src.data[o + 2] * al;
          a += src.data[o + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const aa = a / n;
      const k = aa > 0 ? 255 / aa : 0;
      dst.data[o] = Math.min(255, Math.round((r / n) * k));
      dst.data[o + 1] = Math.min(255, Math.round((g / n) * k));
      dst.data[o + 2] = Math.min(255, Math.round((b / n) * k));
      dst.data[o + 3] = Math.round(aa);
    }
  }
  return dst;
}

/** Greyscale, for the mask image — a mask has no colour to preserve, and 8-bit grey is a third the size. */
function toGrey(src) {
  const out = new PNG({ width: src.width, height: src.height, colorType: 0 });
  for (let i = 0; i < src.width * src.height; i++) {
    const o = i * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = src.data[o];
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * Turn the artwork into a ONE-COLOUR STENCIL: everything the design draws dark becomes solid, and
 * everything it draws WHITE becomes a hole (0.48.0).
 *
 * WHY. The white parts are not decoration, they are counters — the wordmark sits on the dark crescent and
 * the ledger badge on a white disc. Painted onto a dark topbar they read as black lettering and a black
 * blob, and inverting the whole mark only swaps which half looks wrong. Making them transparent is what
 * the design actually means by white: let the background through.
 *
 * HOW. The body is wrapped in a `<mask>` with the two fills swapped — dark → white (show), white → black
 * (hide) — and the raster silhouette forced to white through the export's own RGB-to-white filter, the
 * one it already uses to build its alpha. Everything the mask does not cover is black, so the transparent
 * area around the crescent stays transparent. Then one filled rect is drawn through it.
 *
 * Draw ORDER is preserved exactly, which is the whole reason this works: the disc punches a hole, and the
 * badge is drawn back inside that hole, precisely as the original layers them.
 */
function stencil(svg) {
  // The filter the export uses for "keep the alpha, force RGB white" — found by its matrix rather than by
  // a generated id, so a re-export with different ids still works.
  const white = svg.match(/<filter[^>]*id="([0-9a-f]+)"><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/);
  if (!white) throw new Error('could not find the RGB-to-white filter in the master');

  const cut = svg.indexOf('</defs>') + '</defs>'.length;
  const head = svg.slice(0, cut);
  let body = svg.slice(cut).replace(/<\/svg>\s*$/, '');

  // The raster silhouette: three nested groups around one self-closing <image>. Asserted rather than
  // assumed — a silent miss here would ship a mark with no crescent in it.
  const raster = /<g clip-path="url\(#[0-9a-f]+\)"><g mask="url\(#[0-9a-f]+\)"><g transform="[^"]+"><image[^>]*?\/><\/g><\/g><\/g>/;
  if (!raster.test(body)) throw new Error('could not find the raster silhouette group in the master');
  body = body.replace(raster, (m) => `<g filter="url(#${white[1]})">${m}</g>`);

  // Swap the two fills in ONE pass, via a placeholder, so white does not become black and then white.
  body = body
    .replace(/#343132/g, '__SHOW__')
    .replace(/#ffffff/g, '#000000')
    .replace(/__SHOW__/g, '#ffffff');

  return `${head}<mask id="students-stencil">${body}</mask>` +
    `<rect x="0" y="0" width="100%" height="100%" fill="#343132" mask="url(#students-stencil)"/></svg>`;
}

function rewrite({ size, transparent, darkInvert, asStencil }) {
  const src = fs.readFileSync(MASTER, 'utf8');
  const payloads = [...src.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
  if (payloads.length !== 2) throw new Error(`expected 2 embedded images in the master, found ${payloads.length}`);

  let out = src;
  payloads.forEach((p, i) => {
    const png = PNG.sync.read(Buffer.from(p, 'base64'));
    // Index 0 is the luminance mask, index 1 the artwork — the order they appear in the master.
    const small = downscale(png, size);
    const encoded = PNG.sync.write(i === 0 ? toGrey(small) : small, { deflateLevel: 9 });
    out = out.replace(`base64,${p}`, `base64,${encoded.toString('base64')}`);
  });

  if (transparent) {
    // The two full-bleed white rects are the artwork's background. Dropping them is what lets the mark
    // sit on our own topbar and on a browser's tab bar rather than as a white square.
    out = out.replace(/<rect x="-150"[^>]*fill="#ffffff"[^>]*\/>/g, '');
  }
  if (asStencil) out = stencil(out);
  if (darkInvert) {
    out = out.replace(
      '<defs>',
      '<style>@media (prefers-color-scheme: dark){ :root { filter: invert(1); } }</style><defs>',
    );
  }
  return out;
}

const fullArtwork = rewrite({ size: 512, transparent: false, darkInvert: false });

const targets = [
  // The catalog icon is the artwork as designed, at 512 px on its white tile. Nothing is stencilled: at
  // that size the wordmark is legible and the white counters are doing their job.
  ['icon.svg', fullArtwork],
  // The same artwork, served to a phone's home screen when the masjid has set no logo of its own
  // (0.48.0). The full design WITH the wordmark, because that is the app's actual logo — the mark-only
  // PNGs from build-pwa-icons.cjs exist for the maskable/iOS slots, where lettering would not survive
  // the crop. Chrome reads an SVG manifest icon; iOS does not, which is why both forms are shipped.
  ['packages/web/public/icon-wordmark.svg', fullArtwork],
  // The tab: a stencil, filled dark and inverted on a dark tab bar. A favicon has to carry its own colour.
  ['packages/web/public/favicon.svg', rewrite({ size: 256, transparent: true, darkInvert: true, asStencil: true })],
  // The topbar mark: the same stencil, used as a CSS mask filled with `currentColor` (StudentsMark.tsx),
  // so it needs no colour and no invert of its own — it simply takes the theme's ink.
  ['packages/web/src/assets/students-mark.svg', rewrite({ size: 256, transparent: true, darkInvert: false, asStencil: true })],
];
for (const [rel, content] of targets) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  console.log(`${rel.padEnd(44)} ${(content.length / 1024).toFixed(0)} KB`);
}
console.log(`master${''.padEnd(38)} ${(fs.statSync(MASTER).size / 1024).toFixed(0)} KB`);
