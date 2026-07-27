// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Append-only audit log for sensitive writes (§14). One tiny helper used across routers.
 * NEVER pass passwords, tokens, or full PII into `detail` — ids + before/after of
 * non-secret fields only.
 */
import { db } from '../db';
import { auditLog } from '../db/schema';
import { rid } from '../db/ids';

export interface AuditActor {
  userId?: string | null;
  role?: string | null;
  name?: string | null;
}

export function audit(
  actor: AuditActor,
  action: string,
  opts: { entity?: string; entityId?: string; detail?: Record<string, unknown> } = {},
): void {
  db.insert(auditLog)
    .values({
      id: rid('aud'),
      actorUserId: actor.userId ?? null,
      actorRole: actor.role ?? null,
      actorName: actor.name ?? null,
      action,
      entity: opts.entity ?? null,
      entityId: opts.entityId ?? null,
      detail: opts.detail ?? null,
      createdAt: new Date(),
    })
    .run();
}
