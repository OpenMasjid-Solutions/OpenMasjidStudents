// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The web app manifest, and the icon list it turns on (0.48.0).
 *
 * Its own module rather than inline in `index.ts` for one reason: whether a phone will OFFER TO INSTALL the
 * app depends on the icons in here, and that is worth a test rather than a browser and a hunch. Chrome will
 * not fire `beforeinstallprompt` — no install button in the portal — unless the manifest declares an icon of
 * at least 192×192 (alongside a name, a `display`, a `start_url` and a service worker).
 *
 * WHICH IS WHY THE LOGO IS MEASURED. The masjid's own logo is the icon whenever one is set, but it is
 * whatever they happened to upload: a 64-pixel favicon-sized PNG would leave the app uninstallable, and the
 * failure is invisible — no error anywhere, just a missing button. So the real pixel dimensions are read out
 * of the image header, and when the logo is too small the bundled icons ride along behind it. The logo is
 * still what a launcher shows at small sizes; the bundled 512 is there so the app can be installed at all.
 *
 * `sizes` is never guessed. Declaring "512x512" for an image that is not would make a launcher stop looking
 * for something better, which is worse than saying nothing.
 */

/** Chrome's installability floor for an icon. */
export const MIN_INSTALLABLE_ICON = 192;

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable';
}

/** The app's own icons, used when the masjid has set no logo — or alongside one too small to install with. */
const BUNDLED: ManifestIcon[] = [
  // The full artwork, wordmark and all: this is the app's logo, and an SVG is crisp at every launcher size.
  // Chrome reads SVG manifest icons; iOS reads none of them (it uses apple-touch-icon), hence the PNGs too.
  { src: './icon-wordmark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  // Cropped to the platform's shape, so it is the mark alone with the safe area allowed for.
  { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/**
 * Read an image's pixel dimensions from its header bytes. `null` when the format is not one of ours or the
 * header is truncated — callers treat that as "unknown", never as an error.
 *
 * Header parsing rather than a decoding library: these are the three types `LOGO_TYPES` accepts, the offsets
 * are fixed by their specs, and it keeps a runtime image dependency out of a Raspberry Pi (§7).
 */
export function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') {
      // IHDR is the first chunk and always at the same place: 8-byte signature, 4-byte length, 4-byte type.
      if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      // Walk the marker segments to a Start-Of-Frame, which is where the dimensions live. Length-prefixed,
      // so this skips over EXIF and any embedded thumbnail rather than being fooled by it.
      let i = 2; // past SOI
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i++; // resync: padding between segments is legal
          continue;
        }
        const marker = bytes[i + 1];
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 — every frame type carries the same layout.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2; // standalone markers carry no length
          continue;
        }
        i += 2 + bytes.readUInt16BE(i + 2);
      }
      return null;
    }
    if (mime === 'image/webp') {
      if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
      const kind = bytes.toString('ascii', 12, 16);
      // Three container flavours, three layouts. All little-endian.
      if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1, height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1 };
      return null;
    }
  } catch {
    // A malformed header reads past the end; unknown is the right answer, not a thrown request.
  }
  return null;
}

export interface ManifestInput {
  /** The madrasah's name, or empty to fall back to the app's. */
  schoolName: string;
  /** The uploaded logo, already validated by magic bytes — `null` when none is set. */
  logo: { mime: string; bytes: Buffer } | null;
}

/**
 * Build the manifest body.
 *
 * Relative `src`/`start_url`/`scope`, resolved against the manifest's own URL, so one build works unchanged
 * at the root and under the tunnel's path prefix.
 */
export function buildManifest(input: ManifestInput): Record<string, unknown> {
  const name = input.schoolName.trim() || 'OpenMasjid Students';
  const icons: ManifestIcon[] = [];

  if (input.logo) {
    const size = imageSize(input.logo.bytes, input.logo.mime);
    icons.push({
      src: './api/logo',
      // Its real dimensions when we could read them; "any" when we could not, which is honest and which
      // Chrome accepts as satisfying the size requirement.
      sizes: size ? `${size.width}x${size.height}` : 'any',
      type: input.logo.mime,
      // Never `maskable`: that is cropped to the platform's shape, and a wordmark — which is what most
      // masajid upload — comes back sliced. With no maskable candidate the launcher uses its own
      // treatment, which shrinks the icon inside a tile instead of cutting it.
      purpose: 'any',
    });
    // Too small (or unmeasurable) to guarantee installability, so the bundled set rides along. The logo is
    // still listed first and is still what a launcher picks for a small icon.
    const bigEnough = size ? size.width >= MIN_INSTALLABLE_ICON && size.height >= MIN_INSTALLABLE_ICON : false;
    if (!bigEnough) icons.push(...BUNDLED);
  } else {
    icons.push(...BUNDLED);
  }

  return {
    name,
    // What fits under an icon. Phones truncate at roughly a dozen characters, so a long madrasah name is
    // better cut here than silently ellipsised by the launcher.
    short_name: name.length > 14 ? `${name.slice(0, 13).trimEnd()}…` : name,
    description: 'Tuition and fees for the madrasah',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    // The shell's own background, so the splash screen does not flash white before a dark app.
    background_color: '#020912',
    theme_color: '#020912',
    icons,
  };
}
