// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The order of the first-time setup steps, and the tabs it explains at the end.
 *
 * WHY THIS IS ITS OWN FILE. The order is not a layout preference — it is a dependency order that the
 * server enforces, and getting it wrong produces errors rather than an odd-looking wizard. Keeping the
 * lists here means `firstRunSteps.test.ts` can assert that order without rendering a component that
 * needs a tRPC provider, a browser and a file picker.
 *
 * The rule, in one line: everything the ROSTER IMPORT resolves names against has to be offered before
 * the import. `people/import.ts` looks a row's Class, Course and Fee plan columns up among rows already
 * in the database and refuses the file when one is missing ("create it first, or clear the column"), so
 * a wizard that imported first would walk an office straight into that error — which is what the app
 * used to do by having no wizard at all.
 */

/** In dependency order — see the rule above; `firstRunSteps.test.ts` holds it in place. */
export const SETUP_STEPS = ['school', 'look', 'year', 'classes', 'fees', 'payments', 'email', 'students', 'tour'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Steps whose rows the importer resolves against, so they must precede `students`. */
export const SETUP_STEPS_BEFORE_IMPORT = ['year', 'classes', 'fees'] as const;

/** What each tab is for, in the dock's own order so the list reads left to right along it. */
export const SETUP_TOUR = ['dashboard', 'students', 'year', 'structure', 'billing', 'staff', 'settings'] as const;
