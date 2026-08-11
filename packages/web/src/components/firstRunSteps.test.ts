// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The first-time setup's step ORDER, and the fact that every step has words on it.
 *
 * Two failure modes, both of which have happened in this app's own history:
 *
 *  1. THE ORDER. The roster importer resolves a row's Class, Course and Fee plan columns against rows
 *     already in the database and refuses a file that names one which does not exist yet
 *     (`packages/server/test/import.test.ts` pins that behaviour). So the year, the classes and the fee
 *     plans have to be OFFERED BEFORE the import — a wizard that put the roster first would walk an
 *     office into an error it could do nothing about. That is a real constraint with a real error
 *     message behind it, not a preference about pacing, so it is asserted rather than commented.
 *
 *  2. THE LABELS. A step whose `firstRun.step_*` key is missing does not fail — i18next renders the key
 *     itself, so the rail reads "firstRun.step_fees" and nobody notices until a masjid does. Same for
 *     the tab list at the end, which needs BOTH a `nav.*` name and a `firstRun.tour_*` explanation.
 *
 * `en.json` is read as data rather than through i18next: this is about whether the strings are there.
 */
import { describe, it, expect } from 'vitest';
import en from '../lib/i18n/en.json';
import { SETUP_STEPS, SETUP_STEPS_BEFORE_IMPORT, SETUP_TOUR } from './firstRunSteps';

// Only these two sections, and no cast through `unknown`: both really are flat string maps, so if a
// nested object is ever added to either the assignment stops compiling — which is the right moment to
// find out, rather than at a lookup that silently returns an object.
const firstRun: Record<string, string> = en.firstRun;
const nav: Record<string, string> = en.nav;

describe('the step order', () => {
  it('offers the year, the classes and the fee plans before the roster import', () => {
    const importAt = SETUP_STEPS.indexOf('students');
    expect(importAt).toBeGreaterThan(-1);
    for (const s of SETUP_STEPS_BEFORE_IMPORT) {
      const at = SETUP_STEPS.indexOf(s);
      expect(at, `"${s}" must be a step`).toBeGreaterThan(-1);
      expect(at, `"${s}" must come before the import — the importer resolves names against it`).toBeLessThan(importAt);
    }
  });

  it('ends on the tour, so the last thing setup does is say where everything lives', () => {
    expect(SETUP_STEPS[SETUP_STEPS.length - 1]).toBe('tour');
  });

  it('lists no step twice', () => {
    expect(new Set(SETUP_STEPS).size).toBe(SETUP_STEPS.length);
  });
});

describe('the words on it', () => {
  it('has a label for every step', () => {
    for (const s of SETUP_STEPS) {
      expect(firstRun[`step_${s}`], `firstRun.step_${s}`).toBeTruthy();
    }
  });

  it('has a title and a hint for every step', () => {
    // Every step, including the tour, keys its heading off its own name — so adding a step and
    // forgetting its prose fails here rather than printing "firstRun.feesTitle" at a masjid.
    for (const s of SETUP_STEPS) {
      expect(firstRun[`${s}Title`], `firstRun.${s}Title`).toBeTruthy();
      expect(firstRun[`${s}Hint`], `firstRun.${s}Hint`).toBeTruthy();
    }
  });

  it('names and explains every tab in the tour', () => {
    for (const s of SETUP_TOUR) {
      expect(nav[s], `nav.${s}`).toBeTruthy();
      expect(firstRun[`tour_${s}`], `firstRun.tour_${s}`).toBeTruthy();
    }
  });
});
