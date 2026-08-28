// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * `data-scrolling` is written twice per GESTURE, not twice per event.
 *
 * That is the whole reason this module is more than one line, so it is the thing worth pinning. A
 * scroll fires a stream of events — a trackpad flick is dozens — and setting an attribute on the root
 * element invalidates style for the document each time. Writing it per event would swap the repaint
 * this is meant to avoid for a style recalc per event, which is not a trade; the win only exists if the
 * attribute goes on once at the start and comes off once at the end.
 *
 * There is no jsdom in this workspace (see WhatsNew.test.tsx), so the two globals the module reads are
 * stood up by hand. The fake counts `setAttribute` calls, which is exactly the quantity under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const IDLE_MS = 180;

interface Env {
  fire: () => void;
  attrs: Set<string>;
  sets: () => number;
  listenerCount: () => number;
}

/** A window + document with only the surface `installScrollIdle` touches. */
async function install(): Promise<Env> {
  const listeners: Array<() => void> = [];
  const attrs = new Set<string>();
  let sets = 0;

  const documentElement = {
    setAttribute: (name: string) => {
      sets++;
      attrs.add(name);
    },
    removeAttribute: (name: string) => {
      attrs.delete(name);
    },
  };
  const win = {
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'scroll') listeners.push(fn);
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  };

  /* eslint-disable @typescript-eslint/no-explicit-any -- standing up two browser globals in a Node test */
  (globalThis as any).window = win;
  (globalThis as any).document = { documentElement };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Fresh module state per test: the install guard and the timer handle are module-level.
  vi.resetModules();
  const { installScrollIdle } = await import('./scrollIdle');
  installScrollIdle();

  return {
    fire: () => listeners.forEach((l) => l()),
    attrs,
    sets: () => sets,
    listenerCount: () => listeners.length,
  };
}

describe('installScrollIdle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    /* eslint-disable @typescript-eslint/no-explicit-any -- tearing the fake globals back down */
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it('marks the document on the first scroll event', async () => {
    const env = await install();
    expect(env.attrs.has('data-scrolling')).toBe(false);
    env.fire();
    expect(env.attrs.has('data-scrolling')).toBe(true);
  });

  // The regression this file exists for.
  it('writes the attribute ONCE across a burst of scroll events', async () => {
    const env = await install();
    for (let i = 0; i < 40; i++) env.fire();
    expect(env.sets()).toBe(1);
    expect(env.attrs.has('data-scrolling')).toBe(true);
  });

  it('clears the attribute once the scrolling stops', async () => {
    const env = await install();
    env.fire();
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(env.attrs.has('data-scrolling')).toBe(false);
  });

  it('does not clear it mid-gesture — each event pushes the idle window out', async () => {
    const env = await install();
    for (let i = 0; i < 10; i++) {
      env.fire();
      vi.advanceTimersByTime(IDLE_MS - 20); // a slow but continuous scroll
      expect(env.attrs.has('data-scrolling')).toBe(true);
    }
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(env.attrs.has('data-scrolling')).toBe(false);
  });

  it('marks it again on the next gesture', async () => {
    const env = await install();
    env.fire();
    vi.advanceTimersByTime(IDLE_MS + 1);
    env.fire();
    expect(env.attrs.has('data-scrolling')).toBe(true);
    expect(env.sets()).toBe(2); // once per gesture, and there were two
  });

  it('is idempotent — a second install stacks no second listener', async () => {
    const env = await install();
    const { installScrollIdle } = await import('./scrollIdle');
    installScrollIdle();
    installScrollIdle();
    expect(env.listenerCount()).toBe(1);
  });
});
