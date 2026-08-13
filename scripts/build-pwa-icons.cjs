// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The PNG app icons a phone needs when the app is added to the home screen (0.48.0).
 *
 * WHY PNG AND NOT THE SVG WE ALREADY HAVE. Android will accept an SVG in the web manifest, but iOS will
 * not: `apple-touch-icon` is PNG-only, and with no PNG Safari puts a screenshot of the page on the home
 * screen instead of a mark. The parent portal is a phone-first screen (§15) and half those phones are
 * iPhones, so a PNG is not optional.
 *
 * WHY THIS SCRIPT RATHER THAN A RASTERISER. Turning the master SVG into a PNG properly would mean a
 * rendering dependency (resvg, sharp, headless Chromium) — all of them heavy, and CLAUDE.md §7 says to ask
 * before adding one on a machine that may be a Raspberry Pi. It is not needed: the master's dominant
 * element IS a raster, embedded as base64 with a second image as its luminance mask, and `pngjs` (already
 * present, already used by build-brand-icons.cjs) can read, compose and resize those.
 *
 * WHAT IS LEFT OUT, DELIBERATELY. The curved wordmark and the ledger badge are vector paths in the master
 * and are not rendered here — so these icons are the MARK ALONE, without lettering. That is the right icon
 * at this size anyway: a home-screen icon is 60 px on the glass, where a curved wordmark is a grey smudge.
 * The catalog icon and the favicon still come from the full artwork (build-brand-icons.cjs).
 *
 * Run: node scripts/build-pwa-icons.cjs
 * The outputs are committed; nothing here runs at runtime.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'assets/brand/student-manager-icon.svg');
const OUT = path.join(ROOT, 'packages/web/public');

/** The tile the artwork is designed on — the same white the catalog icon keeps. */
const TILE = [255, 255, 255];

/** Read the master's two embedded images: [0] the luminance mask, [1] the artwork. */
function embedded() {
  const src = fs.readFileSync(MASTER, 'utf8');
  const payloads = [...src.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
  if (payloads.length !== 2) throw new Error(`expected 2 embedded images in the master, found ${payloads.length}`);
  return payloads.map((p) => PNG.sync.read(Buffer.from(p, 'base64')));
}

/** The artwork with the mask's luminance as its alpha — i.e. the mark on transparency. */
function withAlpha(art, mask) {
  if (art.width !== mask.width || art.height !== mask.height) {
    throw new Error(`artwork ${art.width}×${art.height} and mask ${mask.width}×${mask.height} disagree`);
  }
  const out = new PNG({ width: art.width, height: art.height });
  for (let i = 0; i < art.width * art.height; i++) {
    const o = i * 4;
    out.data[o] = art.data[o];
    out.data[o + 1] = art.data[o + 1];
    out.data[o + 2] = art.data[o + 2];
    // Luminance of the mask. The master's own filter treats it the same way to build its alpha.
    out.data[o + 3] = Math.round(0.2126 * mask.data[o] + 0.7152 * mask.data[o + 1] + 0.0722 * mask.data[o + 2]);
  }
  return out;
}

/** The box that actually contains ink, so the mark can be centred and sized to the tile rather than
 *  inheriting whatever margin the export happened to leave. */
function inkBounds(img, threshold = 8) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('the artwork has no visible pixels — the mask is probably being read wrong');
  return { x0, y0, x1, y1 };
}

/**
 * Draw `img`'s ink box into a `size`×`size` tile, centred, scaled to leave `padding` of the tile clear on
 * every side, over an opaque background.
 *
 * `padding` is why there are two variants: a `maskable` icon is cropped by the platform to whatever shape
 * it likes (Android trims up to ~20% off each edge), so its content has to sit inside a safe circle. An
 * `any` icon is shown as drawn and can fill more of the tile.
 */
function tile(img, size, padding) {
  const b = inkBounds(img);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  const box = Math.round(size * (1 - padding * 2));
  const scale = Math.min(box / bw, box / bh);
  const dw = Math.max(1, Math.round(bw * scale));
  const dh = Math.max(1, Math.round(bh * scale));
  const ox = Math.round((size - dw) / 2);
  const oy = Math.round((size - dh) / 2);

  const out = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    out.data[o] = TILE[0];
    out.data[o + 1] = TILE[1];
    out.data[o + 2] = TILE[2];
    out.data[o + 3] = 255;
  }
  // Box-filter the source region into each destination pixel, compositing over the tile as we go.
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx0 = b.x0 + (x * bw) / dw;
      const sx1 = b.x0 + ((x + 1) * bw) / dw;
      const sy0 = b.y0 + (y * bh) / dh;
      const sy1 = b.y0 + ((y + 1) * bh) / dh;
      let r = 0, g = 0, bl = 0, a = 0, n = 0;
      for (let j = Math.floor(sy0); j < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); j++) {
        for (let i2 = Math.floor(sx0); i2 < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); i2++) {
          if (j < 0 || j >= img.height || i2 < 0 || i2 >= img.width) continue;
          const so = (j * img.width + i2) * 4;
          const al = img.data[so + 3] / 255;
          r += img.data[so] * al;
          g += img.data[so + 1] * al;
          bl += img.data[so + 2] * al;
          a += al;
          n++;
        }
      }
      if (!n) continue;
      const av = a / n;
      // Premultiplied average over the tile: `r/n` is already weighted by alpha, so it composites directly.
      const px = ((oy + y) * size + (ox + x)) * 4;
      out.data[px] = Math.round(r / n + TILE[0] * (1 - av));
      out.data[px + 1] = Math.round(g / n + TILE[1] * (1 - av));
      out.data[px + 2] = Math.round(bl / n + TILE[2] * (1 - av));
      out.data[px + 3] = 255;
    }
  }
  return out;
}

const [mask, art] = embedded();
const mark = withAlpha(art, mask);

const targets = [
  // Manifest `any`: shown as drawn, so it can nearly fill the tile.
  ['icon-192.png', 192, 0.06],
  ['icon-512.png', 512, 0.06],
  // Manifest `maskable`: Android crops it to its own shape, so the mark sits well inside the safe area.
  ['icon-maskable-512.png', 512, 0.18],
  // iOS home screen. Also drawn as-is, and iOS rounds the corners itself.
  ['apple-touch-icon.png', 180, 0.08],
];
fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, padding] of targets) {
  const buf = PNG.sync.write(tile(mark, size, padding), { deflateLevel: 9 });
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`${name.padEnd(26)} ${size}px  ${(buf.length / 1024).toFixed(1)} KB`);
}
