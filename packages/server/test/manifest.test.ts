// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The web app manifest (0.48.0) — what decides whether a phone offers to INSTALL the app.
 *
 * This is tested rather than eyeballed because the failure mode is silent. Chrome will not fire
 * `beforeinstallprompt` — so the portal's install button never appears — unless the manifest declares an
 * icon of at least 192×192. A masjid that uploads a 64-pixel logo would turn the icon into theirs and quietly
 * turn installability off, with no error anywhere to explain it.
 *
 * So: the logo is MEASURED from its header bytes, the bundled icons ride along whenever it is too small, and
 * `sizes` is never invented — a launcher told an icon is 512px stops looking for a better one.
 */
import { describe, it, expect } from 'vitest';
import { buildManifest, imageSize, MIN_INSTALLABLE_ICON } from '../src/http/manifest';

/** A minimal but real PNG header: signature, then an IHDR carrying the dimensions. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR length
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A JPEG with an APP0 segment before the SOF0, so the walk has something to skip. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffd8, 0); // SOI
  app0.writeUInt16BE(0xffe0, 2); // APP0
  app0.writeUInt16BE(16, 4); // its length — the SOF must be found AFTER this, not inside it
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(11, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([app0, sof]);
}

const logo = (bytes: Buffer, mime = 'image/png') => ({ mime, bytes });
const srcs = (m: Record<string, unknown>) => (m.icons as { src: string }[]).map((i) => i.src);

describe('imageSize', () => {
  it('reads a PNG', () => {
    expect(imageSize(png(512, 512), 'image/png')).toEqual({ width: 512, height: 512 });
    expect(imageSize(png(64, 32), 'image/png')).toEqual({ width: 64, height: 32 });
  });

  it('reads a JPEG past its APP0 segment', () => {
    // Walking the segments rather than assuming a fixed offset is what makes this survive EXIF and an
    // embedded thumbnail, which is what a phone camera or a design tool actually produces.
    expect(imageSize(jpeg(300, 200), 'image/jpeg')).toEqual({ width: 300, height: 200 });
  });

  it('says nothing rather than guessing on rubbish', () => {
    expect(imageSize(Buffer.from('not an image'), 'image/png')).toBeNull();
    expect(imageSize(Buffer.alloc(0), 'image/jpeg')).toBeNull();
    expect(imageSize(png(512, 512), 'image/gif')).toBeNull();
    // Truncated mid-header: must be null, not a throw inside a request.
    expect(imageSize(png(512, 512).subarray(0, 18), 'image/png')).toBeNull();
  });
});

describe('the manifest', () => {
  it('names the madrasah, not the software', () => {
    const m = buildManifest({ schoolName: 'An-Noor Weekend School', logo: null });
    expect(m.name).toBe('An-Noor Weekend School');
    // A long name is cut here rather than being ellipsised by the launcher at some unknown width.
    expect((m.short_name as string).length).toBeLessThanOrEqual(14);
  });

  it('falls back to the app name when the madrasah has not set one', () => {
    expect(buildManifest({ schoolName: '   ', logo: null }).name).toBe('OpenMasjid Students');
  });

  it('is installable and relative on a fresh install', () => {
    const m = buildManifest({ schoolName: '', logo: null });
    expect(m.display).toBe('standalone');
    // Relative, so one build works at the root and behind the tunnel's path prefix.
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    expect(srcs(m).every((s) => s.startsWith('./'))).toBe(true);
    // The app's own logo WITH the wordmark is the icon when the masjid has set none.
    expect(srcs(m)).toContain('./icon-wordmark.svg');
  });

  it('uses the masjid logo, at its real size, and offers no maskable version of it', () => {
    const m = buildManifest({ schoolName: 'Madani', logo: logo(png(512, 512)) });
    expect(srcs(m)).toEqual(['./api/logo']);
    const icon = (m.icons as { sizes: string; purpose: string }[])[0];
    expect(icon.sizes).toBe('512x512');
    // A maskable icon is cropped to the platform's shape; a wordmark logo would come back sliced.
    expect(icon.purpose).toBe('any');
  });

  it('keeps the app installable when the logo is too small to qualify', () => {
    // The silent failure this whole module exists for: a favicon-sized logo would leave Chrome with no
    // icon big enough, and the install button would simply never appear.
    const m = buildManifest({ schoolName: 'Madani', logo: logo(png(64, 64)) });
    expect(srcs(m)[0]).toBe('./api/logo'); // still theirs, still first
    expect(srcs(m)).toContain('./icon-512.png'); // …and something big enough to install with
    const big = (m.icons as { sizes: string }[]).filter((i) => /^(\d+)x\1$/.test(i.sizes)).map((i) => Number(i.sizes.split('x')[0]));
    expect(Math.max(...big)).toBeGreaterThanOrEqual(MIN_INSTALLABLE_ICON);
  });

  it('treats a logo of unknown size as too small, rather than hoping', () => {
    const m = buildManifest({ schoolName: 'Madani', logo: logo(Buffer.from('junk')) });
    expect((m.icons as { sizes: string }[])[0].sizes).toBe('any');
    expect(srcs(m)).toContain('./icon-512.png');
  });

  it('declares the logo’s own content type', () => {
    const m = buildManifest({ schoolName: 'Madani', logo: logo(jpeg(400, 400), 'image/jpeg') });
    expect((m.icons as { type: string }[])[0].type).toBe('image/jpeg');
  });
});
