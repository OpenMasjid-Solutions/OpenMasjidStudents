// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Access-origin policy (CLAUDE.md §5, §12.4 — a security invariant, DO NOT REGRESS).
 *
 *   admin    → LAN only (login refused AND existing sessions 403'd over the tunnel)
 *   finance / parent → LAN + tunnel
 *
 * Classification — FAIL-CLOSED, and a documented, hardened evolution of §12.4 (see
 * docs/DATA_MODEL.md for the full reconciliation). §12.4's literal signal
 * (`cf-ray` OR `x-forwarded-proto: https`) is unusable for this `https: true` app —
 * the OS LAN TLS proxy (app-proxy.ts) also sets `x-forwarded-proto: https` — and, worse,
 * "absence of `cf-ray`" is NOT proof of a trusted LAN: a request that reaches our port
 * directly from the internet (an unfirewalled VPS / port-forward) also lacks `cf-ray`.
 * So we grant `lan` only on a POSITIVE signal — the REAL client IP is private/loopback:
 *
 *   tunnel  if `cf-ray` is present (genuine Cloudflare tunnel), OR the effective client
 *           IP is public (reached us from the internet without Cloudflare).
 *   lan     only when the effective client IP is private/loopback/link-local.
 *
 * The effective client IP trusts `cf-connecting-ip`/`x-forwarded-for` ONLY when the TCP
 * peer is itself local (i.e. an OS proxy on this host, or loopback) — otherwise a direct
 * client could spoof those headers. Both OS proxies strip client-supplied forwarding
 * headers and set trusted values, so behind them XFF is trustworthy. Safe failure
 * direction holds: spoofing only ever DOWNGRADES to `tunnel` (removes admin), never up.
 */
import type { FastifyRequest } from 'fastify';
import type { Role } from '../db/schema';

export type Origin = 'lan' | 'tunnel';
type Headers = FastifyRequest['headers'];

/** RFC1918 / loopback / link-local / IPv6 ULA — i.e. "on the local network". */
export function isPrivateIp(ip: string | undefined): boolean {
  if (!ip) return false;
  let s = ip.trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7); // IPv4-mapped IPv6
  if (s === '::1') return true; // IPv6 loopback
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // IPv6 ULA fc00::/7
  if (s.startsWith('fe80:')) return true; // IPv6 link-local
  if (s.startsWith('127.')) return true; // IPv4 loopback
  if (s.startsWith('10.')) return true;
  if (s.startsWith('192.168.')) return true;
  if (s.startsWith('169.254.')) return true; // IPv4 link-local
  const m = s.match(/^172\.(\d{1,3})\./);
  if (m) {
    const o = Number(m[1]);
    if (o >= 16 && o <= 31) return true;
  }
  return false;
}

function leftmostForwarded(h: Headers): string | undefined {
  const xff = h['x-forwarded-for'];
  const v = Array.isArray(xff) ? xff[0] : xff;
  return v ? v.split(',')[0].trim() : undefined;
}

/** The effective real client IP. `cf-connecting-ip` / `x-forwarded-for` are trusted
 *  ONLY when the TCP peer is local (an OS proxy / loopback); a direct client's forged
 *  headers are ignored (we use the unspoofable socket peer for them). */
export function clientIpFrom(h: Headers, peerIp: string | undefined): string {
  if (isPrivateIp(peerIp)) {
    const cf = h['cf-connecting-ip'];
    const cfv = Array.isArray(cf) ? cf[0] : cf;
    if (cfv && cfv.trim()) return cfv.trim();
    const xff = leftmostForwarded(h);
    if (xff) return xff;
  }
  return peerIp ?? '';
}

export function classifyOriginParts(h: Headers, peerIp: string | undefined): Origin {
  if (h['cf-ray']) return 'tunnel'; // genuine Cloudflare tunnel
  return isPrivateIp(clientIpFrom(h, peerIp)) ? 'lan' : 'tunnel';
}

export function classifyOrigin(req: FastifyRequest): Origin {
  return classifyOriginParts(req.headers, req.socket?.remoteAddress);
}

/**
 * Expand an IPv6 address to its eight groups, or null if it is not one we can read.
 *
 * Returning null on anything unusual is deliberate and is the strict direction: the caller then keys
 * on the whole string, which can only ever give an address its OWN bucket. Guessing at a malformed
 * address is how two different clients end up sharing one.
 */
function expandIpv6(s: string): string[] | null {
  if (s.includes('.')) return null; // an embedded IPv4 literal — rare, and not worth guessing at
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, '')); // normalize, so 0db8 and db8 are one bucket
}

/**
 * THE RATE-LIMIT KEY FOR AN ADDRESS — IPv6 IS FOLDED TO ITS /64 (0.52.0, §14, §4a Phase 2).
 *
 * An IPv4 address is one host and makes one honest bucket. **An IPv6 address is not**: the smallest
 * block anybody is assigned is a /64, and most home connections get a /56 or /48 on top of that. So a
 * single ordinary customer holds at least 2^64 addresses and can present a new one per request — which
 * turns every per-IP limiter in this app into a counter that never reaches two, and floods the map on
 * the way past (see `rateLimit.ts`, where the eviction used to forgive a block under exactly this).
 *
 * Folding to /64 is the standard unit: it is the smallest thing a network operator hands out, so it is
 * the smallest thing it is fair to hold responsible. Coarser (/48) would let one ISP customer lock out
 * their neighbours; finer is no limit at all.
 *
 * Any address we cannot parse keys on itself, unfolded — strict rather than lenient, per `expandIpv6`.
 */
export function foldIpForKey(ip: string | undefined): string {
  const s = (ip ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  const bare = s.split('%')[0]; // a zone id (fe80::1%eth0) is about this host, not about the peer
  // An IPv4-mapped address is an IPv4 host wearing a hat — one address, so key it as one.
  const mapped = bare.startsWith('::ffff:') ? bare.slice(7) : bare;
  if (!mapped.includes(':')) return mapped || 'unknown';
  const groups = expandIpv6(mapped);
  if (!groups) return mapped;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * The rate-limit key for a request. **This is the one place a request becomes a limiter key** (§16),
 * which is why there is no exported "the client's IP" helper beside it: every caller of the old one
 * was a limiter, and a raw address sitting in scope is an invitation to key on it directly and lose
 * the folding above without anything failing.
 *
 * Per-client buckets rather than one shared bucket on the OS proxy's address — otherwise a single
 * attacker locks out everybody behind it.
 */
export function rateLimitKey(req: FastifyRequest): string {
  return foldIpForKey(clientIpFrom(req.headers, req.socket?.remoteAddress));
}

/** Is the browser↔edge hop HTTPS? (Cloudflare, or the OS LAN TLS proxy.) Used ONLY for
 *  the cookie Secure flag — never for the LAN/tunnel policy decision. */
export function isHttpsRequest(req: FastifyRequest): boolean {
  if (req.headers['cf-ray']) return true;
  const xfp = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(xfp) ? xfp[0] : xfp;
  return !!proto && proto.split(',')[0].trim().toLowerCase() === 'https';
}

/** May this role act from this origin? Admin is LAN-only; everyone else is both. */
export function roleAllowedFromOrigin(role: Role, origin: Origin): boolean {
  if (role === 'admin') return origin === 'lan';
  return true;
}
