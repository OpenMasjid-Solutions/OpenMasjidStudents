// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent portal — Pay now (CLAUDE.md §13.2). Card data NEVER touches our server: the browser
 * confirms the PaymentIntent with Stripe Elements; our backend only ever sees Stripe ids. On
 * success we call confirmPayment (the server retrieves the PI and records it — no webhook); the
 * daily reconcile is the backstop, so success is worded softly. Shown only when card payments are
 * available (keys loaded).
 *
 * `chosen` is the itemised half (0.43.0): a parent who ticked "Book fee" on the home screen pays that
 * exact amount, and those lines travel through to `confirmPayment` so the book fee is what ends up
 * settled — not whichever bill happens to be oldest. With nothing ticked this behaves exactly as before:
 * one amount against the household balance.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { useTranslation } from 'react-i18next';
import { trpc } from '../../lib/trpc';
import { formatMoney, parseCents } from '../../lib/money';

export interface ChosenLine {
  itemId: string;
  label: string;
  amountCents: number;
}

export function PayNow({ familyId, owedCents, currency, onPaid, chosen = [] }: { familyId: string; owedCents: number; currency: string; onPaid: () => void; chosen?: ChosenLine[] }) {
  const { t } = useTranslation();
  const create = trpc.portal.createPayment.useMutation();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((Math.max(owedCents, 100) / 100).toFixed(2));
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<{ clientSecret: string; stripe: Promise<Stripe | null>; lines: ChosenLine[] } | null>(null);

  const chosenCents = chosen.reduce((s, l) => s + l.amountCents, 0);
  const picking = chosen.length > 0;

  /**
   * THE PROCESSING FEE (0.51.0), when the madrasah has chosen to pass Stripe's cut on.
   *
   * `method` exists because a card and a bank account cost the school different amounts, and a
   * PaymentIntent's amount is fixed before Stripe asks the payer anything — so on an install that
   * passes on both, the parent picks first. When only the card fee is on there is nothing to choose
   * and no question is asked.
   */
  const cfg = trpc.portal.payConfig.useQuery();
  const [method, setMethod] = useState<'card' | 'bank'>('card');
  const cents = picking ? chosenCents : parseCents(amount) ?? 0;
  /**
   * Quoted by the SERVER, from the same function that will create the charge (§16). The browser could
   * do this arithmetic and must not: the figure a parent agrees to has to be the figure their card is
   * charged, and two implementations of a rounding rule disagree by a cent the moment one is edited.
   */
  const quote = trpc.portal.feeQuote.useQuery({ amountCents: cents, method }, { enabled: !!cfg.data?.fee.enabled && cents > 0 });
  const fee = cfg.data?.fee.enabled ? quote.data ?? null : null;

  async function start(e: FormEvent) {
    e.preventDefault();
    setError('');
    // When lines are ticked, THEY are the amount — a parent who chose the book fee has already said how
    // much, and letting the two disagree is how money ends up on the wrong line.
    if (!cents || cents < 100) return setError(t('family.payMin'));
    try {
      // The TUITION goes up, never the total: the server re-quotes and adds the fee itself, so a
      // tampered browser cannot settle a $300 bill for $3 (§14).
      const r = await create.mutateAsync({ familyId, amountCents: cents, method });
      if (r.clientSecret && r.publishableKey) setIntent({ clientSecret: r.clientSecret, stripe: loadStripe(r.publishableKey), lines: chosen });
      else setError(t('family.payUnavailable'));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (intent) {
    return (
      <div style={{ marginBlockStart: '0.75rem' }}>
        <Elements stripe={intent.stripe} options={{ clientSecret: intent.clientSecret, appearance: { theme: 'night' } }}>
          <PayForm familyId={familyId} onPaid={onPaid} lines={intent.lines} />
        </Elements>
      </div>
    );
  }

  // Nothing due right now → this is a parent paying AHEAD. Same flow, honest wording: they are
  // topping up a balance, not settling a bill, and the money sits as credit their next invoice eats.
  const payingAhead = owedCents <= 0 && !picking;

  if (!open) {
    return (
      <button type="button" className="btn btn--primary btn--block" style={{ marginBlockStart: '0.75rem' }} onClick={() => setOpen(true)}>
        {picking ? t('family.payChosen', { amount: formatMoney(chosenCents, currency) }) : payingAhead ? t('family.payAhead') : t('family.payNow')}
      </button>
    );
  }

  return (
    <form onSubmit={start} style={{ marginBlockStart: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {picking ? (
        <>
          <span className="label">{t('family.payingFor')}</span>
          <ul className="pay-chosen">
            {chosen.map((l) => (
              <li key={l.itemId}>
                <span>{l.label}</span>
                <span className="tnum">{formatMoney(l.amountCents, currency)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <label className="label">{t('family.payAmount', { currency: currency.toUpperCase() })}</label>
          <input className="input glass-inset" type="number" step="0.01" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          {payingAhead && <p className="hint">{t('family.payAheadHint')}</p>}
        </>
      )}
      {/* Which way they are paying, only where the two actually cost the school different amounts.
          Asked BEFORE the total is shown, because it changes the total. */}
      {cfg.data?.chooseMethod && (
        <>
          <span className="label">{t('family.payHow')}</span>
          <div className="chip-row">
            {(['card', 'bank'] as const).map((m) => (
              <label key={m} className={`chip ${method === m ? '' : 'is-muted'}`} style={{ cursor: 'pointer' }}>
                <input type="radio" name="pay-method" checked={method === m} onChange={() => setMethod(m)} style={{ marginInlineEnd: '0.35rem' }} />
                {t(`family.payMethod_${m}`)}
              </label>
            ))}
          </div>
        </>
      )}
      {/* WHAT THEY WILL ACTUALLY BE CHARGED, itemised, before they commit to it — and a plain sentence
          saying whose money the extra is. A total that appears for the first time on Stripe's own form
          is the version of this feature that generates phone calls. */}
      {fee && fee.feeCents > 0 && (
        <div className="glass-inset pay-fee">
          <div className="pay-fee-row"><span>{t('family.feeTuition')}</span><span className="tnum">{formatMoney(fee.netCents, currency)}</span></div>
          <div className="pay-fee-row"><span>{t(`family.feeLine_${fee.method}`)}</span><span className="tnum">{formatMoney(fee.feeCents, currency)}</span></div>
          <div className="pay-fee-row pay-fee-total"><strong>{t('family.feeTotal')}</strong><strong className="tnum">{formatMoney(fee.grossCents, currency)}</strong></div>
          <p className="hint" style={{ marginBlockStart: '0.4rem', marginBlockEnd: 0 }}>{t(`family.feeWhose_${fee.method}`)}</p>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn btn--primary btn--block" disabled={create.isPending}>{create.isPending ? t('auth.working') : t('family.continueToCard')}</button>
    </form>
  );
}

function PayForm({ familyId, onPaid, lines }: { familyId: string; onPaid: () => void; lines: ChosenLine[] }) {
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
        // The ticked lines ride along so the server can settle exactly those. If this call never
        // happens, reconciliation records the money the ordinary way (oldest bill first) — the lines
        // are a refinement of where it lands, never a condition of it landing.
        await confirm.mutateAsync({ familyId, paymentIntentId: paymentIntent.id, ...(lines.length ? { lines: lines.map((l) => ({ itemId: l.itemId, amountCents: l.amountCents })) } : {}) });
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
