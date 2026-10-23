// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * EVERY TABLE IN THE SCHEMA IS NAMED IN THE TWO DOCUMENTS THAT CLAIM TO LIST THEM ALL.
 *
 * CLAUDE.md §9 opens "The tables, as they actually exist:" and `docs/DATA_MODEL.md` opens "The 39
 * tables that exist" — both assert completeness, and both are maintained by somebody remembering.
 * §20 already requires that "§9's table list and `docs/DATA_MODEL.md` are updated in the same commit"
 * as the phase that adds a table; this is what makes that a property rather than a hope.
 *
 * It found one on the sweep that added it: `student_notes` shipped with §4a Phase 1 and was never
 * added to §9's list, so the document that calls itself the canonical schema spec was missing a table
 * for a whole release. DATA_MODEL.md had it. That is the failure worth catching — not a doc being
 * absent, but two documents disagreeing while both claim to be complete.
 *
 * Deliberately one-directional: a table in the schema must appear in the docs. The reverse would fail
 * on every table the docs legitimately discuss but do not have — §9's "REMAINING tables" list names
 * `enrollments`, `marks`, `report_cards` and the rest of Phases 3–5 precisely because they do NOT
 * exist yet, and that forward-looking list is the point of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

/** Table names as Drizzle declares them — the schema is the source of truth, not either document. */
const tables = [...read('packages/server/src/db/schema.ts').matchAll(/sqliteTable\(\s*['"]([a-z_]+)['"]/g)]
  .map((m) => m[1]!)
  .filter((n, i, a) => a.indexOf(n) === i)
  .sort();

describe('the schema and the documents that list it agree', () => {
  it('found a believable set of tables (the positive control)', () => {
    // Without this the regex could silently match nothing and every assertion below would pass.
    expect(tables.length).toBeGreaterThan(30);
    expect(tables).toContain('students');
    expect(tables).toContain('payments');
  });

  for (const doc of ['CLAUDE.md', 'docs/DATA_MODEL.md']) {
    it(`${doc} names every table that exists`, () => {
      const txt = read(doc);
      // Backticked, which is how both documents write a table name throughout.
      const missing = tables.filter((t) => !txt.includes(`\`${t}\``));
      expect(missing, `${doc} does not mention: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('both documents state the same table COUNT', () => {
    // Each says a number out loud; a table added to one list and not the other shows up here even if
    // the name happens to appear somewhere else in the prose.
    for (const doc of ['CLAUDE.md', 'docs/DATA_MODEL.md']) {
      const m = read(doc).match(/\*\*(?:That is )?(\d+) tables\*\*/i);
      expect(m, `${doc} no longer states a table count`).toBeTruthy();
      expect(Number(m![1]), `${doc} states the wrong table count`).toBe(tables.length);
    }
  });
});
