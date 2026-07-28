// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent portal — Pay now (CLAUDE.md §13.2). Card data NEVER touches our server: the browser
 * confirms the PaymentIntent with Stripe Elements; our backend only ever sees Stripe ids. On
 * success we call confirmPayment (the server retrieves the PI and records it — no webhook); the
 * daily reconcile is the backstop, so success is worded softly. Shown only when card payments are
 * available (keys loaded).
 */
import { useMemo, useState, type FormEvent } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { useTranslation } from 'react-i18next';
import { trpc } from '../../lib/trpc';
import { parseCents } from '../../lib/money';

export function PayNow({ familyId, owedCents, currency, onPaid }: { familyId: string; owedCents: number; currency: string; onPaid: () => void }) {
  const { t } = useTranslation();
  const create = trpc.portal.createPayment.useMutation();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((Math.max(owedCents, 100) / 100).toFixed(2));
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<{ clientSecret: string; stripe: Promise<Stripe | null> } | null>(null);

  async function start(e: FormEvent) {
    e.preventDefault();
    setError('');
    const cents = parseCents(amount);
    if (!cents || cents < 100) return setError(t('family.payMin'));
    try {
      const r = await create.mutateAsync({ familyId, amountCents: cents });
      if (r.clientSecret && r.publishableKey) setIntent({ clientSecret: r.clientSecret, stripe: loadStripe(r.publishableKey) });
      else setError(t('family.payUnavailable'));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (intent) {
    return (
      <div style={{ marginBlockStart: '0.75rem' }}>
        <Elements stripe={intent.stripe} options={{ clientSecret: intent.clientSecret, appearance: { theme: 'night' } }}>
          <PayForm familyId={familyId} onPaid={onPaid} />
        </Elements>
      </div>
    );
  }

  // Nothing due right now → this is a parent paying AHEAD. Same flow, honest wording: they are
  // topping up a balance, not settling a bill, and the money sits as credit their next invoice eats.
  const payingAhead = owedCents <= 0;

  if (!open) {
    return (
      <button type="button" className="btn btn--primary btn--block" style={{ marginBlockStart: '0.75rem' }} onClick={() => setOpen(true)}>
        {payingAhead ? t('family.payAhead') : t('family.payNow')}
      </button>
    );
  }

  return (
    <form onSubmit={start} style={{ marginBlockStart: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <label className="label">{t('family.payAmount', { currency: currency.toUpperCase() })}</label>
      <input className="input glass-inset" type="number" step="0.01" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      {payingAhead && <p className="hint">{t('family.payAheadHint')}</p>}
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn btn--primary btn--block" disabled={create.isPending}>{create.isPending ? t('auth.working') : t('family.continueToCard')}</button>
    </form>
  );
}

function PayForm({ familyId, onPaid }: { familyId: string; onPaid: () => void }) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const confirm = trpc.portal.confirmPayment.useMutation();
  const [status, setStatus] = useState<'idle' | 'paying' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setStatus('paying');
    setError('');
    const { error: err, paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required' });
    if (err) {
      setError(err.message ?? t('family.payError'));
      setStatus('error');
      return;
    }
    // Record it server-side on return (no webhook). Best-effort: if this call fails, the daily
    // reconcile still records the payment — so we always show the soft success.
    if (paymentIntent?.id) {
      try {
        await confirm.mutateAsync({ familyId, paymentIntentId: paymentIntent.id });
      } catch {
        /* reconciliation (§11.4) will pick it up */
      }
    }
    setStatus('done');
    onPaid();
  }

  const ok = useMemo(() => !!stripe && !!elements, [stripe, elements]);
  if (status === 'done') return <div className="notice notice--ok">{t('family.paidOptimistic')}</div>;

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <PaymentElement />
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn btn--primary btn--block" disabled={!ok || status === 'paying'}>{status === 'paying' ? t('auth.working') : t('family.payCard')}</button>
    </form>
  );
}
