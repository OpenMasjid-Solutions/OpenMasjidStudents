// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The school logo (§14). It is stored as a `data:` URI and then served back over HTTP with a
 * content type, so what goes in has to be validated by MAGIC BYTES rather than by the type the
 * caller declared — otherwise "image/png" is just a string an uploader chose, and the route becomes
 * a way to serve arbitrary content from this origin.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let settings: typeof import('../src/settings');
const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (extra = 32) => `data:image/png;base64,${Buffer.concat([PNG_HEADER, Buffer.alloc(extra, 7)]).toString('base64')}`;

beforeAll(async () => {
  app = await freshApp();
  settings = await import('../src/settings');
});
// One database across the file, so a logo set by one test would otherwise still be there for the
// next — and "was it refused?" is only meaningful against a known-empty starting point.
beforeEach(() => settings.setSchoolLogo(null));

describe('logo validation', () => {
  it('accepts a real PNG and hands it back for the statement to inline', async () => {
    const admin = caller('admin');
    await admin.settings.logoSet({ dataUri: png() });
    expect((await admin.settings.get()).logo).toBe(png());
    const parsed = settings.parseLogoDataUri(png())!;
    expect(parsed.mime).toBe('image/png');
    expect(parsed.bytes.subarray(0, 8)).toEqual(PNG_HEADER);
  });

  it('refuses content whose bytes disagree with the declared type — the header is not evidence', async () => {
    const admin = caller('admin');
    const liar = `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`;
    await expect(admin.settings.logoSet({ dataUri: liar })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await admin.settings.get()).logo).toBeNull();
  });

  it('refuses SVG outright, even a well-formed one — it is script-capable and we serve it back', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    expect(settings.parseLogoDataUri(svg)).toBeNull();
  });

  it('refuses anything over the size cap, and anything that is not a data URI at all', async () => {
    const admin = caller('admin');
    const huge = `data:image/png;base64,${Buffer.concat([PNG_HEADER, Buffer.alloc(settings.LOGO_MAX_BYTES + 1, 0)]).toString('base64')}`;
    await expect(admin.settings.logoSet({ dataUri: huge })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    for (const bad of ['https://example.test/logo.png', 'data:image/png,notbase64', '', 'javascript:alert(1)']) {
      expect(settings.parseLogoDataUri(bad)).toBeNull();
    }
  });

  it('clears back to nothing, so a masjid can remove a logo it uploaded by mistake', async () => {
    const admin = caller('admin');
    await admin.settings.logoSet({ dataUri: png() });
    await admin.settings.logoSet({ dataUri: null });
    expect((await admin.settings.get()).logo).toBeNull();
    expect(settings.getSchoolLogo()).toBeNull();
  });

  it('is admin-only and LAN-only, like every other setting', async () => {
    await expect(caller('finance').settings.logoSet({ dataUri: png() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').settings.logoSet({ dataUri: png() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
