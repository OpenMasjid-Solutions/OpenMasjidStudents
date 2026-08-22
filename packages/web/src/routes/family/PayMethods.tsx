// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent portal — saved cards + autopay (CLAUDE.md §13.3). Add a card with a Stripe SetupIntent
 * (off-session capable; card data never touches our server), then toggle autopay — our scheduler
 * charges the default card when tuition comes due, with clear consent copy. Hidden when card
 * payments aren't configured. */
import { useState, type FormEvent } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, CreditCard, Landmark, Trash2, Wallet } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { describeMethod, formatExpiry, methodTitle } from '../../lib/paymentMethod';
import { formatMoney } from '../../lib/money';

/**
 * The Autopay & cards TAB (0.44.0): every household this parent is linked to, each with its own cards
 * and its own autopay switch.
 *
 * Per household on purpose — autopay is a per-family enrollment against a per-family Stripe Customer
 * (§13.3), so one switch for a parent linked to two households would be a lie about what it does.
 * Nearly every parent has exactly one, and then the heading is simply omitted.
 */
export function FamilyPayMethods() {
  const { t } = useTranslation();
  const q = trpc.portal.myFamily.useQuery();
  const payConfig = trpc.portal.payConfig.useQuery();

  if (q.isLoading) return <div className="fam-empty">{t('status.connecting')}</div>;
  if (q.isError) return <div className="fam-empty">{t('family.loadError')}</div>;
  const fams = q.data?.families ?? [];
  if (!fams.length) return <div className="fam-empty">{t('family.noFamily')}</div>;
  // Cards can go away under us (the platform unreachable, or the account unset) — say so rather than
  // showing an empty tab the parent will read as broken.
  if (!payConfig.data?.ready) return <div className="fam-empty">{t('family.payUnavailable')}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {fams.map((fam) => (
        <div key={fam.id}>
          {fams.length > 1 && <h2 className="fam-section-title">{fam.name}</h2>}
          <PayMethods familyId={fam.id} />
        </div>
      ))}
    </div>
  );
}

export function PayMethods({ familyId }: { familyId: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const statusQ = trpc.portal.autopayStatus.useQuery({ familyId });
  const createSetup = trpc.portal.createSetupIntent.useMutation();
  const saveCard = trpc.portal.saveCard.useMutation();
  const removeCard = trpc.portal.removeCard.useMutation();
  const setAutopay = trpc.portal.setAutopay.useMutation();
  const reorder = trpc.portal.reorderMethods.useMutation();
  /** The fee policy and the currency, for the disclosure below the autopay toggle (0.51.0). The FIGURES
   *  come from `autopayStatus.fee` instead — quoted server-side for the method autopay would charge. */
  const payCfg = trpc.portal.payConfig.useQuery();
  const [adding, setAdding] = useState<{ clientSecret: string; stripe: Promise<Stripe | null> } | null>(null);
  /** Set when the method just added still needs the parent to confirm it with their bank. */
  const [pendingNote, setPendingNote] = useState(false);
  const refresh = () => utils.portal.autopayStatus.invalidate({ familyId });

  if (!statusQ.data?.ready) return null; // card payments not configured → nothing to show
  const { enabled, cards, fee } = statusQ.data;
  const currency = payCfg.data?.currency ?? 'usd';

  async function addCard() {
    const r = await createSetup.mutateAsync({ familyId });
    if (r.clientSecret && r.publishableKey) setAdding({ clientSecret: r.clientSecret, stripe: loadStripe(r.publishableKey) });
  }

  /**
   * Move one method up or down.
   *
   * The WHOLE order is sent, not "move this one": a full list is idempotent and cannot be applied to a
   * different list than the parent was looking at, which a relative move can if the set changed in another
   * tab. The server refuses a list that no longer matches the household's methods.
   */
  async function move(index: number, delta: -1 | 1) {
    const next = cards.map((c) => c.id);
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    await reorder.mutateAsync({ familyId, orderedIds: next });
    await refresh();
  }

  return (
    <section className="fam-section">
      <h2>{t('family.savedCards')}</h2>

      {cards.length === 0 ? (
        <div className="fam-empty">{t('family.noCards')}</div>
      ) : (
        cards.map((c, i) => {
          const d = describeMethod(c);
          const expiry = formatExpiry(d);
          // The second line, built from whatever this method actually has: a card's expiry, a bank
          // account's checking/savings, and the "Default" mark on whichever one autopay would charge.
          // Anything missing is simply left out rather than printed as an empty gap.
          const sub = [
            d.kind === 'bank' && d.accountType ? t(`family.acct_${d.accountType}`) : null,
            expiry ? `${d.expired ? t('family.expired') : t('family.expires')} ${expiry}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <div key={c.id} className="list-row glass">
              {/* The POSITION, when there is more than one — "1st" is what autopay charges, and the rank is
                  the whole point of being able to reorder. With one method it would be noise. */}
              {cards.length > 1 && <span className="pm-rank" aria-hidden="true">{t(`family.rank_${Math.min(i + 1, 4)}`, { n: i + 1 })}</span>}
              <span style={{ display: 'inline-flex', color: d.expired ? 'var(--color-gold)' : 'var(--color-primary)' }}>
                {d.kind === 'bank' ? <Landmark size={18} /> : d.kind === 'other' ? <Wallet size={18} /> : <CreditCard size={18} />}
              </span>
              <div className="row-main">
                <span className="row-title">{methodTitle(d, t('family.savedMethod'))}</span>
                {sub && <span className="row-sub">{sub}</span>}
                {/* Said on the first row only, in words: "1st" alone does not tell a parent what the order
                    is FOR, and this is the sentence that makes the arrows worth using. */}
                {i === 0 && cards.length > 1 && <span className="row-sub">{t('family.chargedFirst')}</span>}
              </div>
              {cards.length > 1 && (
                <span className="pm-move">
                  <button type="button" className="btn btn--ghost btn--sm" disabled={i === 0 || reorder.isPending} aria-label={t('family.moveUp')} title={t('family.moveUp')} onClick={() => void move(i, -1)}>
                    <ChevronUp size={15} />
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" disabled={i === cards.length - 1 || reorder.isPending} aria-label={t('family.moveDown')} title={t('family.moveDown')} onClick={() => void move(i, 1)}>
                    <ChevronDown size={15} />
                  </button>
                </span>
              )}
              <button type="button" className="btn btn--ghost btn--sm" aria-label={t('common.remove')} onClick={async () => { if (!window.confirm(t('family.removeCardConfirm'))) return; await removeCard.mutateAsync({ familyId, paymentMethodId: c.id }); await refresh(); }}><Trash2 size={15} /></button>
            </div>
          );
        })
      )}
      {cards.length > 1 && <p className="hint" style={{ marginBlockStart: '0.4rem' }}>{t('family.orderHint')}</p>}
      {/* An expired card is the commonest reason autopay stops, and nothing used to say so. */}
      {cards.some((c) => describeMethod(c).expired) && (
        <p className="hint" style={{ marginBlockStart: '0.4rem' }}>{t('family.expiredHint')}</p>
      )}

      {pendingNote && <div className="notice notice--warn" style={{ marginBlockStart: '0.5rem' }}>{t('family.methodPending')}</div>}

      {adding ? (
        <div className="glass-inset" style={{ padding: '0.75rem', borderRadius: '12px', marginBlockStart: '0.5rem' }}>
          <Elements stripe={adding.stripe} options={{ clientSecret: adding.clientSecret, appearance: { theme: 'night' } }}>
            <CardSetupForm
              onSaved={async (pmId, pending) => {
                await saveCard.mutateAsync({ familyId, paymentMethodId: pmId });
                setPendingNote(pending);
                setAdding(null);
                await refresh();
              }}
              onCancel={() => setAdding(null)}
            />
          </Elements>
        </div>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" style={{ marginBlockStart: '0.5rem' }} onClick={addCard} disabled={createSetup.isPending}><CreditCard size={15} /> {t('family.addCard')}</button>
      )}
      {/* What the Payment Element will offer is decided by the masjid's Stripe account, so this says
          "card or bank account" without promising a specific list. */}
      <p className="hint" style={{ marginBlockStart: '0.35rem' }}>{t('family.addMethodHint')}</p>

      {/* Autopay toggle — needs a card on file. */}
      <h2 style={{ marginBlockStart: '1.25rem' }}>{t('family.autopay')}</h2>
      <div className="list-row glass">
        <div className="row-main">
          <span className="row-title">{enabled ? t('family.autopayIsOn') : t('family.autopayIsOff')}</span>
          <span className="row-sub">{enabled ? t('family.autopayOn') : cards.length === 0 ? t('family.autopayNeedsCard') : t('family.autopayOff')}</span>
        </div>
        <label className="switch" style={{ marginInlineStart: 'auto' }}>
          <input
            type="checkbox"
            aria-label={t('family.autopay')}
            checked={enabled}
            disabled={setAutopay.isPending || (!enabled && cards.length === 0)}
            onChange={async (e) => { await setAutopay.mutateAsync({ familyId, enabled: e.target.checked }); await refresh(); }}
          />
          <span className="switch-track" aria-hidden="true" />
        </label>
      </div>
      {/* Consent copy stays visible while it is ON as well: a parent should be able to see what they
          agreed to at the moment they are deciding whether to keep it (§13.3). */}
      {cards.length > 0 && <p className="hint" style={{ marginBlockStart: '0.3rem' }}>{t('family.autopayConsent')}</p>}
      {/*
       * THE FEE, WITH THE FIGURE — because this tab is the only place it can ever be shown (0.51.0).
       *
       * An autopay charge is off-session: nobody is looking at a screen when it happens, so unlike
       * pay-now — which itemizes tuition, fee and total in front of the payer — agreeing to autopay
       * means agreeing to an amount that is never presented again. This started as one sentence saying a
       * fee would be added, which told a parent the fact and withheld the only part they wanted.
       *
       * NOT GATED ON HAVING A SAVED METHOD, and that was the actual defect. It was, so the disclosure was
       * hidden during setup — the one moment a household is deciding whether to do this at all — and only
       * appeared once they had already committed a card. Someone weighing autopay has to be able to read
       * the cost before there is anything to charge.
       *
       * Every figure comes from the server (`autopayStatus.fee`, quoted by payments/fees.ts with the rate
       * for the method autopay would actually present first). The browser does no fee arithmetic: two
       * implementations of the gross-up disagree by a cent as soon as one is edited (§16).
       */}
      {payCfg.data?.fee.enabled && fee && (
        <div className="glass-inset pay-fee" style={{ marginBlockStart: '0.5rem' }}>
          <p className="hint" style={{ marginBlockStart: 0, marginBlockEnd: fee.feeCents > 0 ? '0.4rem' : 0 }}>{t('family.autopayFee')}</p>
          {/* Only with something actually owed. At a zero balance the quote is all zeros, and a table of
              nothing reads as a fault — the prose above and below still says what will happen. */}
          {fee.feeCents > 0 && (
            <>
              <div className="pay-fee-row"><span>{t('family.feeTuition')}</span><span className="tnum">{formatMoney(fee.netCents, currency)}</span></div>
              <div className="pay-fee-row"><span>{t(`family.feeLine_${fee.method}`)}</span><span className="tnum">{formatMoney(fee.feeCents, currency)}</span></div>
              <div className="pay-fee-row pay-fee-total"><strong>{t('family.feeTotal')}</strong><strong className="tnum">{formatMoney(fee.grossCents, currency)}</strong></div>
              {/* Said out loud rather than left to be assumed: this is today's balance worked through,
                  not a promise about the run date. A bill can be paid another way in between. */}
              <p className="hint" style={{ marginBlockStart: '0.4rem', marginBlockEnd: 0 }}>{t('family.autopayFeeToday')}</p>
            </>
          )}
          {/* The same sentence pay-now uses — whose money the extra is, and that cash or a check at the
              office avoids it. One wording for one fact, in both places a parent meets it. */}
          <p className="hint" style={{ marginBlockStart: '0.4rem', marginBlockEnd: 0 }}>{t(`family.feeWhose_${fee.method}`)}</p>
        </div>
      )}
    </section>
  );
}

function CardSetupForm({ onSaved, onCancel }: { onSaved: (pmId: string, pending: boolean) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setStatus('saving');
    setError('');
    // `if_required` and no return_url: the methods that can be saved for off-session use — a card, a bank
    // account — are collected in place, so a redirect should not arise. If one ever did, Stripe reports it
    // here as an error the parent can read, which is better than sending them away and losing track of
    // whether the method was saved.
    const { error: err, setupIntent } = await stripe.confirmSetup({ elements, redirect: 'if_required' });
    if (err || !setupIntent?.payment_method) {
      setError(err?.message ?? t('family.payError'));
      setStatus('error');
      return;
    }
    // A bank account verified by micro-deposits comes back NOT yet succeeded: it is a real payment method
    // and worth showing, but it cannot be charged until the parent confirms the two small amounts their
    // bank receives. Saying so is the difference between "it's there" and "it will work".
    onSaved(
      typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method.id,
      setupIntent.status !== 'succeeded',
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <PaymentElement />
      {error && <p className="form-error">{error}</p>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="submit" className="btn btn--primary" disabled={!stripe || status === 'saving'}>{status === 'saving' ? t('auth.working') : t('family.saveCard')}</button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}
