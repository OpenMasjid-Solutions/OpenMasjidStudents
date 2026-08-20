// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The generated temporary staff password.
 *
 * It is short-lived — the server forces a change on first sign-in — but it is a credential on an account
 * that, for `finance`, signs in over the internet (§12.4). So the two things worth pinning are that it
 * clears the server's minimum and that it is actually random, plus the small readability promises the
 * office relies on when reading one down a phone.
 */
import { describe, it, expect } from 'vitest';
import { generateTempPassword } from './password';

/** The server's `MIN_PASSWORD_LENGTH`. Hard-coded rather than imported: the web package does not depend
 *  on the server, and a change there that made this too short should fail loudly here. */
const SERVER_MIN = 12;

describe('generateTempPassword', () => {
  it('clears the server minimum with room to spare', () => {
    for (let i = 0; i < 50; i++) expect(generateTempPassword().length).toBeGreaterThanOrEqual(SERVER_MIN);
  });

  it('leaves out the characters that get misread', () => {
    // 0/O, 1/l/I, 5/S, 2/Z — this travels on paper and over the phone.
    for (let i = 0; i < 200; i++) expect(generateTempPassword()).not.toMatch(/[0O1lI5S2Z]/);
  });

  it('groups with dashes so it can be read aloud', () => {
    expect(generateTempPassword(15)).toMatch(/^[^-]{5}-[^-]{5}-[^-]{5}$/);
  });

  it('honors a requested length', () => {
    // 20 characters in groups of five = 20 + 3 dashes.
    expect(generateTempPassword(20).replace(/-/g, '')).toHaveLength(20);
  });

  it('does not repeat itself', () => {
    // 500 draws from 52^15 — a collision here means the randomness is broken, not bad luck. This is the
    // assertion that would have caught `Math.random` seeded per session, or a mistakenly cached value.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateTempPassword());
    expect(seen.size).toBe(500);
  });

  it('draws on the whole alphabet', () => {
    // A modulo bias or a truncated alphabet shows up as characters that never appear. 500 passwords is
    // 7,500 characters over 52, so each is expected ~144 times and all of them should turn up.
    const chars = new Set<string>();
    for (let i = 0; i < 500; i++) for (const c of generateTempPassword().replace(/-/g, '')) chars.add(c);
    expect(chars.size).toBe(52);
  });
});
