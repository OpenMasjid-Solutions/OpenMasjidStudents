// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ONE Stripe integration point (CLAUDE.md §13.1, §16 — nothing else imports the SDK). Keys are
 * fetched over the Fabric from the OS core (`GET /api/fabric/stripe?account=<id>`), which returns the
 * publishable key (→ browser) and the secret key (server memory ONLY — never DB, never logs). The
 * account is the one the admin PICKED in-app (Settings → Payments), falling back to the STRIPE_ACCOUNT
 * manifest default. If the platform is unreachable or no account is chosen, the payment features report
 * "temporarily unavailable" and everything else keeps working. There is no Stripe webhook — payments
 * are recorded by the Fabric record-payment calls (donations/kiosk), the portal's confirm-on-return,
 * autopay's synchronous confirm, and the daily reconciliation (§11.4).
 */
import Stripe from 'stripe';
import { config, fabricConfigured } from '../config';
import { getChosenStripeAccount } from '../settings';
import { makeLog } from '../logger';

const log = makeLog('stripe');

interface StripeKeys {
  accountId: string;
  publishableKey: string;
  secretKey: string;
}

let keys: StripeKeys | null = null;
let client: Stripe | null = null;

/** The account to charge tuition through: the admin's in-app choice, else the manifest default. */
function chosenAccount(): string {
  return getChosenStripeAccount() || config.stripeAccount;
}

/** (Re)load the chosen account's keys from the Fabric. Safe to call on boot + on settings change.
 *  Returns true on success. Never throws; never logs key material. */
export async function loadStripeKeys(): Promise<boolean> {
  const account = chosenAccount();
  if (!fabricConfigured() || !account) {
    keys = null;
    client = null;
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe?account=${encodeURIComponent(account)}`, {
      headers: { 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn('stripe keys unavailable', { status: res.status });
      keys = null;
      client = null;
      return false;
    }
    const k = (await res.json()) as { id?: string; publishableKey?: string; secretKey?: string };
    if (!k.secretKey || !k.publishableKey) {
      keys = null;
      client = null;
      return false;
    }
    keys = { accountId: k.id ?? account, publishableKey: k.publishableKey, secretKey: k.secretKey };
    client = new Stripe(keys.secretKey);
    log.info('stripe keys loaded'); // never the keys themselves
    return true;
  } catch {
    // A thrown reload (network error / 5s timeout / bad body) must NOT leave the PREVIOUS account's
    // client live — otherwise a failed account switch silently keeps charging the old account. Clear
    // it (like every deliberate failure branch above); payments show "temporarily unavailable".
    keys = null;
    client = null;
    return false;
  }
}

/**
 * For tests / offline: inject keys + a client directly (never used in production).
 *
 * `null` means NO CLIENT, and is distinct from omitting the argument (0.48.0). It used to be
 * `c ?? new Stripe(...)`, so a test passing null to simulate "the payments connection is down" got a real
 * Stripe SDK instance pointed at api.stripe.com instead — the test then failed on a live network error
 * rather than on the branch it meant to exercise, which is a quietly misleading way for a test to pass or
 * fail. Only an omitted argument builds a real client now.
 */
export function _setStripeForTest(k: { publishableKey?: string; secretKey?: string; accountId?: string }, c?: Stripe | null): void {
  keys = { accountId: k.accountId ?? 'acct_test', publishableKey: k.publishableKey ?? 'pk_test', secretKey: k.secretKey ?? 'sk_test' };
  client = c === undefined ? new Stripe(keys.secretKey) : c;
}

export function stripeClient(): Stripe | null {
  return client;
}
export function stripeReady(): boolean {
  return client !== null;
}
export function publishableKey(): string | null {
  return keys?.publishableKey ?? null;
}
export function stripeAccountId(): string | null {
  return keys?.accountId ?? null;
}
