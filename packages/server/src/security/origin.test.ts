// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { classifyOriginParts, clientIpFrom, isPrivateIp, isHttpsRequest, roleAllowedFromOrigin } from './origin';

type H = FastifyRequest['headers'];
const req = (headers: H) => ({ headers }) as FastifyRequest;

describe('isPrivateIp', () => {
  it('recognizes private / loopback / link-local', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.5.10', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('recognizes public addresses', () => {
    for (const ip of ['203.0.113.5', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2606:4700::1', undefined]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe('origin classification (§12.4 — DO NOT REGRESS, fail-closed)', () => {
  it('genuine Cloudflare tunnel (cf-ray) → tunnel, regardless of peer', () => {
    expect(classifyOriginParts({ 'cf-ray': 'abc-DFW' }, '10.0.0.9')).toBe('tunnel');
  });

  it('LAN device connecting directly (private peer, no proxy headers) → lan', () => {
    expect(classifyOriginParts({}, '192.168.1.50')).toBe('lan');
    expect(classifyOriginParts({}, '127.0.0.1')).toBe('lan');
  });

  it('CRITICAL: a public client reaching the port directly (no cf-ray) → tunnel (admin denied)', () => {
    // An unfirewalled VPS / port-forward: the request never touched Cloudflare, so it has
    // no cf-ray — but it is NOT the trusted LAN. Fail closed.
    expect(classifyOriginParts({}, '203.0.113.7')).toBe('tunnel');
  });

  it('LAN access over the https app-proxy (private peer + private XFF, xfp=https, no cf-ray) → lan', () => {
    expect(classifyOriginParts({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.168.1.20' }, '172.17.0.1')).toBe('lan');
  });

  it('internet client via a proxy without cf-ray (private peer, PUBLIC XFF) → tunnel', () => {
    expect(classifyOriginParts({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }, '172.17.0.1')).toBe('tunnel');
  });

  it('a direct public client CANNOT spoof a private XFF to reach lan (peer not local ⇒ XFF ignored)', () => {
    expect(classifyOriginParts({ 'x-forwarded-for': '10.0.0.1' }, '203.0.113.7')).toBe('tunnel');
  });

  it('cf-connecting-ip is trusted only behind a local peer', () => {
    expect(clientIpFrom({ 'cf-connecting-ip': '203.0.113.4' }, '172.17.0.1')).toBe('203.0.113.4');
    // direct connection: a spoofed cf-connecting-ip is ignored, socket peer wins
    expect(clientIpFrom({ 'cf-connecting-ip': '10.0.0.1' }, '203.0.113.4')).toBe('203.0.113.4');
  });
});

describe('cookie Secure signal (separate from the policy)', () => {
  it('isHttpsRequest reflects the browser hop', () => {
    expect(isHttpsRequest(req({ 'cf-ray': 'x' }))).toBe(true);
    expect(isHttpsRequest(req({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isHttpsRequest(req({ 'x-forwarded-proto': 'http' }))).toBe(false);
    expect(isHttpsRequest(req({}))).toBe(false);
  });
});

describe('origin policy matrix', () => {
  it('admin is LAN-only; everyone else works from both origins', () => {
    expect(roleAllowedFromOrigin('admin', 'lan')).toBe(true);
    expect(roleAllowedFromOrigin('admin', 'tunnel')).toBe(false);
    for (const role of ['finance', 'parent'] as const) {
      expect(roleAllowedFromOrigin(role, 'lan')).toBe(true);
      expect(roleAllowedFromOrigin(role, 'tunnel')).toBe(true);
    }
  });
});
