// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Refunds (0.48.0) — give any payment back, whichever way it arrived.
 *
 * WHY IT IS A LIST OF TRANSACTIONS. The office thinks in "that payment on Tuesday", not in ledger rows,
 * and one card charge covering three children IS three rows (§9). Refunding one of those while asking
 * Stripe for the whole charge would leave the ledger and Stripe permanently apart — so the server groups
 * by the Stripe PaymentIntent and this screen shows the group, naming the children it covered.
 *
 * THE TWO ROUTES ARE NAMED BEFORE THE PRESS, NOT AFTER. A card refund sends the money back on its own;
 * a cash one only puts the ledger right and somebody still has to hand the notes over. Those are
 * different acts with the same button, and the difference belongs in the confirmation — which is why the
 * dialog text is chosen per row rather than being one generic "are you sure?".
 *
 * Phone-first, like the rest of the finance screens: each transaction is a card on a narrow screen rather
 * than a table row to drag sideways.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Landmark, RotateCcw, Search, Wallet } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatMoney } from '../lib/money';
import { formatDate, type DateFormat } from '../lib/dates';

export function Refunds() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  /** `settings.display` rather than `settings.get`: this renders for finance as well as admin, and that
   *  is the query finance is allowed (0.47.0). */
  const dateFormat = (trpc.settings.display.useQuery().data?.dateFormat ?? 'iso') as DateFormat;
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const list = trpc.billing.refundable.useQuery({ limit: 25, query: query.trim() || undefined });
  const refund = trpc.billing.refund.useMutation();

  const money = (c: number) => formatMoney(c, list.data?.currency ?? 'usd');

  async function run(key: string, route: 'stripe' | 'manual', amount: number) {
    // The confirmation says which of the two things is about to happen and how much — a refund is the one
    // action in this app that sends money OUT, and "are you sure?" alone would not tell an office whether
    // the parent is about to be paid back automatically or waiting at the desk.
    const ask = route === 'stripe' ? t('refund.confirmStripe', { amount: money(amount) }) : t('refund.confirmManual', { amount: money(amount) });
    if (!window.confirm(ask)) return;
    setBusy(key);
    setMsg(null);
    setErr(null);
    try {
      const r = await refund.mutateAsync({ key });
      setMsg(
        r.alreadyDone
          ? t('refund.already')
          : r.route === 'stripe'
            ? t('refund.doneStripe', { amount: money(r.amountCents) })
            : t('refund.doneManual', { amount: money(r.amountCents) }),
      );
      // The balances, the year grid and every open household window all move when money is reversed.
      await Promise.all([
        utils.billing.refundable.invalidate(),
        utils.billing.familyBilling.invalidate(),
        utils.billing.studentBilling.invalidate(),
        utils.billing.yearGrid.invalidate(),
      ]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const rows = list.data?.transactions ?? [];

  return (
    <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
      <div className="section-head"><h2><RotateCcw size={16} /> {t('refund.title')}</h2></div>
      <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('refund.intro')}</p>

      {msg && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{msg}</div>}
      {err && <p className="form-error">{err}</p>}

      <div className="field" style={{ maxWidth: '22rem', marginBlockEnd: '0.7rem' }}>
        <label className="label" htmlFor="refund-q">{t('refund.search')}</label>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', insetInlineStart: '0.55rem', insetBlockStart: '0.7rem', opacity: 0.6 }} aria-hidden="true" />
          <input id="refund-q" className="input glass-inset" style={{ paddingInlineStart: '1.9rem' }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('refund.searchPlaceholder')} maxLength={120} />
        </div>
      </div>

      {list.isLoading ? (
        <p className="empty">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.9rem' }}>{query.trim() ? t('refund.noMatches') : t('refund.none')}</p>
      ) : (
        <ul className="refund-list">
          {rows.map((r) => (
            <li key={r.key} className={`refund-row glass-inset${r.refunded ? ' is-done' : ''}`}>
              <span className="ico" aria-hidden="true">{r.route === 'stripe' ? <Wallet size={16} /> : <Landmark size={16} />}</span>
              <div className="refund-main">
                <span className="refund-top">
                  <strong>{money(r.amountCents)}</strong>
                  {/* WHAT it paid, next to the amount — the office is picking which payment to reverse, and
                      on a monthly plan every row is the same figure. "How" alone cannot tell them apart. */}
                  {r.paidFor.labels.length > 0 && (
                    <span> · {r.paidFor.labels.join(' · ')}{r.paidFor.more > 0 ? ` · ${t('refund.andMore', { count: r.paidFor.more })}` : ''}</span>
                  )}
                  {r.paidFor.advance && <span className="muted"> · {t('refund.paidAhead')}</span>}
                  <span className="muted"> · {t(`billing.ch_${r.channel}`, r.channel)} · {formatDate(r.occurredAt as unknown as string, dateFormat)}</span>
                </span>
                {/* Who it was for. A charge covering several children names all of them, because that is
                    what will be reversed — and it is how the office recognises the payment. */}
                <span className="refund-sub muted">
                  {r.parts.map((p) => p.studentName).filter(Boolean).join(', ') || t('refund.unknownStudent')}
                  {r.parts.length > 1 ? ` · ${t('refund.acrossChildren', { count: r.parts.length })}` : ''}
                  {r.memo ? ` · ${r.memo}` : ''}
                </span>
                {/* Said on every row, not only in the dialog: an office scanning the list should be able to
                    see which of these it can actually undo by itself. */}
                <span className="refund-route">{r.route === 'stripe' ? t('refund.routeStripe') : t('refund.routeManual')}</span>
              </div>
              {r.refunded ? (
                <span className="chip is-muted">{t('refund.refunded')}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy !== null}
                  onClick={() => void run(r.key, r.route, r.amountCents)}
                >
                  {busy === r.key ? t('refund.working') : t('refund.action')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="hint" style={{ marginBlockStart: '0.6rem' }}>{t('refund.partialHint')}</p>
      {/* Explains an ABSENCE. A carried-forward balance is a payment on the ledger but not one this app
          took, so it is not listed — and an office that goes looking for it deserves to be told why here
          rather than concluding the list is incomplete. */}
      <p className="hint">{t('refund.carryInHint')}</p>
    </section>
  );
}
