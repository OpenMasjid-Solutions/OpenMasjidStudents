// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The root tRPC AppRouter. The web app imports ONLY its TYPE (CLAUDE.md §6, §8).
 * This is a tuition/fee-management app: auth, people (families/students/guardians),
 * staff accounts, settings, billing (fee plans/invoices/ledger/payments), and the
 * parent portal (balance/pay/cards/autopay).
 */
import { router, publicProcedure } from './trpc';
import { authRouter } from './auth';
import { peopleRouter } from './people';
import { staffRouter } from './staff';
import { settingsRouter } from './settings';
import { billingRouter } from './billing';
import { portalRouter } from './portal';
import { structureRouter } from './structure';
import { whatsappRouter } from './whatsapp';
import { admissionsRouter } from './admissions';
import { config, fabricConfigured } from '../config';

export const appRouter = router({
  /** Liveness + a little context the shell shows (never any secret). */
  health: publicProcedure.query(() => ({
    ok: true,
    app: 'students' as const,
    version: config.version,
    standalone: !fabricConfigured(),
  })),

  auth: authRouter,
  people: peopleRouter,
  staff: staffRouter,
  settings: settingsRouter,
  billing: billingRouter,
  portal: portalRouter,
  /** School year + terms and the course → class grouping (organizational only, no academics). */
  structure: structureRouter,
  /** WhatsApp through OpenMasjidOS (0.50.0) — the masjid's policy, not the gateway. */
  whatsapp: whatsappRouter,
  /** The admissions desk (0.52.0, §4a Phase 2). ADMIN ONLY, and therefore LAN-only: finance reaches
   *  no admissions record at all. The PUBLIC half of admissions is not here — it is plain Fastify
   *  routes in `admissions/publicRoutes.ts`, outside this middleware by design (§12.4). */
  admissions: admissionsRouter,
});

export type AppRouter = typeof appRouter;
