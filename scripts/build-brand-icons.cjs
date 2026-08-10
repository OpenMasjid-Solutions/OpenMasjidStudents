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
 *   favicon.svg        the browser tab. Transparent, and inverts itself under `prefers-color-scheme:
 *                      dark` — the browser's own setting is the only signal a tab bar has.
 *   students-mark.svg  the topbar mark. Transparent and does NOT invert itself, because this app has its
 *                      own light/dark toggle that is independent of the OS preference: a stylesheet rule
 *                      keyed to `data-theme` does the inverting (shell.css). Carrying both would invert
 *                      twice for anyone on a dark OS, which is a dark mark on a dark bar.
 *
 * WHY INVERT AT ALL. The mark is a near-black silhouette with white detail inside it (the wordmark sits on
 * the dark crescent; the badge sits on a white disc). On a dark tab bar or our own dark topbar the
 * crescent would all but vanish. Inverting a monochrome design gives back the same shapes with the
 * contrast the other way up, which is legible — and it is exactly what the previous favicon here did.
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

function rewrite({ size, transparent, darkInvert }) {
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
  if (darkInvert) {
    out = out.replace(
      '<defs>',
      '<style>@media (prefers-color-scheme: dark){ :root { filter: invert(1); } }</style><defs>',
    );
  }
  return out;
}

const targets = [
  ['icon.svg', rewrite({ size: 512, transparent: false, darkInvert: false })],
  ['packages/web/public/favicon.svg', rewrite({ size: 256, transparent: true, darkInvert: true })],
  ['packages/web/src/assets/students-mark.svg', rewrite({ size: 256, transparent: true, darkInvert: false })],
];
for (const [rel, content] of targets) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  console.log(`${rel.padEnd(44)} ${(content.length / 1024).toFixed(0)} KB`);
}
console.log(`master${''.padEnd(38)} ${(fs.statSync(MASTER).size / 1024).toFixed(0)} KB`);
