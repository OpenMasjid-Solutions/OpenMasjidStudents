// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Vitest config. The only non-default is a generous testTimeout. It was raised for the report-card
 * PDF tests, which are long gone (v0.35.0 descope) — but it still earns its keep: the property-based
 * allocation-invariant suite builds hundreds of random payment histories against real SQLite and
 * takes several seconds per case, slow enough that the 5s default flakes under full-suite parallel
 * load. 30s gives it headroom without masking a real hang.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
