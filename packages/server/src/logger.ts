// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Minimal structured logger. NEVER log secrets, PII, or request bodies
 * (CLAUDE.md §14 — ids and event names only). Kept tiny on purpose.
 */
type Level = 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const head = `[${ts}] ${level.toUpperCase()} ${scope}: ${msg}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra !== undefined) sink(head, extra);
  else sink(head);
}

export function makeLog(scope: string) {
  return {
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}
