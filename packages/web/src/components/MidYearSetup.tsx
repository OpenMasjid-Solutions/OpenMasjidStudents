// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "We're starting mid-year" — the one-time step a madrasa runs when it adopts this app in February of a
 * September–June year.
 *
 * The office is not going to re-key five months of cash receipts, so nothing here asks them to. One
 * dropdown per child — the last month they have already settled — and the app works out the rest: a
 * child paid through January owes nothing, a child paid through November owes December and January, and
 * a child paid through June has five months in hand. The money figure is derived from that child's own
 * rate and stays editable, because the notebook is the authority when it disagrees.
 *
 * EVERY NUMBER ON THIS SCREEN COMES FROM THE SERVER, including the derived amounts and the resulting
 * balances. That is deliberate: the same function computes the preview and the commit, so the balances
 * the office reads here are the ones parents will see. Nothing is written until Commit.
 *
 * What Commit writes is a real, dated ledger artifact per child — a "Balance carried forward" bill for
 * arrears, a dated payment for money paid ahead — never a stored balance, and never the months
 * themselves. It also fixes the first month this install bills, so nobody can generate December
 * afterwards and charge those arrears a second time.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatMoney, parseCents } from '../lib/money';

type Row = { paidThrough: string; amount: string; kind: 'owes' | 'ahead' };

/**
 * The dropdown's value for "they have paid nothing at all this year" (0.48.0).
 *
 * The list used to be "Not said" plus the months, which left no way to say the commonest awkward case: a
 * family who has paid nothing since the year began. Picking the first month of the year is not the same
 * answer — that says they paid THAT month — and "Not said" writes nothing at all.
 *
 * A sentinel only inside this component. It becomes the `paidNothing` FLAG on the wire, and the server
 * turns that into the real month it means (the one before the year started), so no non-period string
 * ever reaches a place that compares period keys. See MidYearRow in billing/carryIn.ts.
 */
const PAID_NOTHING = '__nothing__';

/** A `YYYY-MM` key rendered the way an office reads it. */
function monthLabel(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  if (!y || !m) return periodKey;
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

export function MidYearSetup({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const status = trpc.billing.midYearStatus.useQuery();
  const years = trpc.structure.schoolYearList.useQuery();
  const commit = trpc.billing.midYearCommit.useMutation();

  const [goLive, setGoLive] = useState('');
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [memo, setMemo] = useState('');
  const [query, setQuery] = useState('');
  const [done, setDone] = useState<{ owed: number; ahead: number; skipped: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const goLivePeriod = goLive || status.data?.suggestedGoLive || '';
  const money = (c: number) => formatMoney(c, currency);

  // The office's answers, in the shape the server takes. An untouched child is simply absent, which the
  // server reads as "square" — no row means no artifact.
  const input = useMemo(
    () => ({
      goLivePeriod,
      rows: Object.entries(rows)
        .filter(([, r]) => r.paidThrough || r.amount)
        .map(([studentId, r]) => ({
          studentId,
          // The sentinel becomes a flag; a real month stays a month. Never both.
          paidThrough: r.paidThrough && r.paidThrough !== PAID_NOTHING ? r.paidThrough : undefined,
          ...(r.paidThrough === PAID_NOTHING ? { paidNothing: true } : {}),
          ...(parseCents(r.amount) ? { amountOverrideCents: parseCents(r.amount)!, kindOverride: r.kind } : {}),
        })),
      ...(memo.trim() ? { memo: memo.trim() } : {}),
    }),
    [goLivePeriod, rows, memo],
  );

  const preview = trpc.billing.midYearPreview.useQuery(input, { enabled: !!goLivePeriod });

  /** The months a "paid through" dropdown may offer: the school year, plus nothing before it. */
  const monthOptions = preview.data?.months ?? [];

  const BLANK: Row = { paidThrough: '', amount: '', kind: 'owes' };

  function setRow(studentId: string, patch: Partial<Row>) {
    setRows((prev) => ({ ...prev, [studentId]: { ...BLANK, ...prev[studentId], ...patch } }));
  }

  /** Set the whole column at once — most of a roster paid through the same month. */
  function setAllPaidThrough(periodKey: string) {
    const next: Record<string, Row> = {};
    // Every child, not the filtered ones: the control says "the whole column", and quietly meaning
    // "the ones matching your search" would be the wrong kind of surprise on a screen about money.
    for (const s of allStudents) next[s.studentId] = { ...BLANK, ...rows[s.studentId], paidThrough: periodKey };
    setRows(next);
  }

  async function doCommit() {
    setErr(null);
    try {
      const r = await commit.mutateAsync(input);
      setDone({ owed: r.owed, ahead: r.ahead, skipped: r.skipped });
      await Promise.all([utils.billing.midYearStatus.invalidate(), utils.billing.yearGrid.invalidate()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const allStudents = preview.data?.students ?? [];
  /** Type-as-you-go name filter. A whole-school roster is a long table and the office works down it
   *  family by family. It narrows only what is SHOWN — every answer already given is still committed,
   *  and the counts below are still of everybody, so searching cannot quietly change what gets written. */
  const needle = query.trim().toLowerCase();
  const students = needle ? allStudents.filter((s) => s.fullName.toLowerCase().includes(needle)) : allStudents;
  const willWrite = allStudents.filter((s) => !s.already && s.kind !== 'square' && s.amountCents > 0);

  if (done) {
    return (
      <div className="win-content">
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><CheckCircle2 size={16} /> {t('midyear.doneTitle')}</h2></div>
          {/* `count` rather than `owed`: i18next selects the singular/plural key from `count`. */}
          <p>{t('midyear.doneBody', { count: done.owed, ahead: done.ahead, period: monthLabel(goLivePeriod) })}</p>
          {done.skipped > 0 && <p className="hint">{t('midyear.doneSkipped', { count: done.skipped })}</p>}
          <p className="hint">{t('midyear.doneNext', { period: monthLabel(goLivePeriod) })}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="win-content">
      {/* ── 1. When we start ─────────────────────────────────────────────────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('midyear.step1')}</h2></div>
        <p className="muted" style={{ fontSize: '0.9rem' }}>{t('midyear.step1Hint')}</p>
        {status.data?.startPeriod && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{t('midyear.alreadyFloor', { period: monthLabel(status.data.startPeriod) })}</div>}
        <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
          {years.data && years.data.length > 0 && (
            <div className="field" style={{ flex: '0 1 14rem' }}>
              <label className="label">{t('year.schoolYear')}</label>
              <span className="input glass-inset" style={{ display: 'flex', alignItems: 'center' }}>{years.data.find((y) => y.isCurrent)?.label ?? years.data[0].label}</span>
            </div>
          )}
          <div className="field" style={{ flex: '0 1 12rem' }}>
            <label className="label">{t('midyear.goLive')}</label>
            <select className="input glass-inset" value={goLivePeriod} onChange={(e) => setGoLive(e.target.value)}>
              {monthOptions.length === 0 && <option value={goLivePeriod}>{monthLabel(goLivePeriod)}</option>}
              {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">{t('midyear.memo')}</label>
            <input className="input glass-inset" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} placeholder={t('midyear.memoHint')} />
          </div>
        </div>
      </section>

      {/* ── 2. The roster ────────────────────────────────────────────────────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('midyear.step2')}</h2></div>
        <p className="muted" style={{ fontSize: '0.9rem' }}>{t('midyear.step2Hint')}</p>
        {monthOptions.length === 0 ? (
          <p className="empty">{t('midyear.needsYear')}</p>
        ) : (
          <>
            <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
              <div className="field" style={{ flex: '0 1 16rem' }}>
                <label className="label">{t('midyear.setAll')}</label>
                <select className="input glass-inset" value="" onChange={(e) => { if (e.target.value) setAllPaidThrough(e.target.value); }}>
                  <option value="">{t('midyear.setAllPick')}</option>
                  {/* Offered here too: a madrasah that collected nothing all year and is adopting the
                      app to fix exactly that sets the whole column in one go. */}
                  <option value={PAID_NOTHING}>{t('midyear.paidNothing')}</option>
                  {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
              </div>
              {/* Beside the bulk control, not above the table: set most of the roster in one go, then
                  search out the handful that differ. */}
              <div className="field" style={{ flex: '1 1 12rem' }}>
                <label className="label" htmlFor="midyear-search">{t('midyear.search')}</label>
                <input
                  id="midyear-search"
                  className="input glass-inset"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('midyear.searchHint')}
                />
              </div>
            </div>
            {needle && <p className="hint">{t('midyear.searchCount', { shown: students.length, total: allStudents.length })}</p>}
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table stack-phone">
                <thead>
                  <tr>
                    <th>{t('students.name')}</th>
                    <th>{t('year.paying')}</th>
                    <th>{t('midyear.paidThrough')}</th>
                    <th>{t('midyear.carried')}</th>
                    <th>{t('midyear.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => {
                    const row = rows[s.studentId];
                    return (
                      <tr key={s.studentId}>
                        {/* data-label lets each cell name itself once the row stacks into a card on a
                            phone (.stack-phone in admin.css). Desktop ignores it. */}
                        <td className="row-title">
                          {s.fullName}
                          {/* A child who left before go-live can still owe money, so they are here — but
                              say so, or the office wonders why a withdrawn name is on the list. */}
                          {s.withdrawn && <span className="chip is-muted" style={{ marginInlineStart: '0.4rem' }}>{t('students.withdrawn')}</span>}
                          {s.already && <span className="chip is-muted" style={{ marginInlineStart: '0.4rem' }}>{t('midyear.alreadyDone')}</span>}
                        </td>
                        <td className="tnum" data-label={t('year.paying')}>{money(s.monthlyCents)}</td>
                        <td data-label={t('midyear.paidThrough')}>
                          <select className="input glass-inset" style={{ minWidth: '9rem' }} value={row?.paidThrough ?? ''} disabled={s.already} onChange={(e) => setRow(s.studentId, { paidThrough: e.target.value })}>
                            <option value="">{t('midyear.notSaid')}</option>
                            {/* Right after "Not said", because it is the other answer that is not a
                                month — and the commonest awkward one. */}
                            <option value={PAID_NOTHING}>{t('midyear.paidNothing')}</option>
                            {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                          </select>
                        </td>
                        <td data-label={t('midyear.carried')}>
                          {/* The derived figure, editable. Typing a number is what an office does when
                              the notebook and the rate disagree — a child who missed two weeks, say. */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              className="input glass-inset"
                              style={{ width: '7rem' }}
                              disabled={s.already}
                              value={row?.amount ?? ''}
                              placeholder={(s.amountCents / 100).toFixed(2)}
                              onChange={(e) => setRow(s.studentId, { amount: e.target.value, kind: row?.kind ?? (s.kind === 'ahead' ? 'ahead' : 'owes') })}
                            />
                            {row?.amount ? (
                              <select className="input glass-inset" style={{ width: '7.5rem' }} value={row.kind} onChange={(e) => setRow(s.studentId, { kind: e.target.value as 'owes' | 'ahead' })}>
                                <option value="owes">{t('midyear.owes')}</option>
                                <option value="ahead">{t('midyear.ahead')}</option>
                              </select>
                            ) : (
                              <span className={`chip ${s.kind === 'ahead' ? 'is-accent' : s.kind === 'owes' ? '' : 'is-muted'}`}>{t(`midyear.k_${s.kind}`)}</span>
                            )}
                          </div>
                        </td>
                        <td data-label={t('midyear.result')} className={s.afterOwedCents > 0 ? 'merit-total is-neg' : 'merit-total is-pos'}>
                          {s.afterOwedCents > 0 ? money(s.afterOwedCents) : s.afterCreditCents > 0 ? `${money(s.afterCreditCents)} ${t('billing.credit')}` : money(0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* ── 3. Apply it ───────────────────────────────────────────────────────
          The per-HOUSEHOLD preview table that used to be here is gone (0.48.0). It listed the same figures
          step 2 already shows per child, one row up the tree — and a household's balance is only ever the
          sum of its children's (§9), so it added a second place to read the same number and a second thing
          to keep in your head while filling the step above it in.

          What is left is the confirm: the amount about to be written, and the button. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('midyear.step3')}</h2></div>
        <p className="muted" style={{ fontSize: '0.9rem' }}>{t('midyear.step3Hint')}</p>
        {err && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}><CircleAlert size={15} /> {err}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--primary" disabled={commit.isPending || !goLivePeriod} onClick={doCommit}>
            {commit.isPending ? t('common.saving') : t('midyear.commit', { count: willWrite.length })}
          </button>
          <span className="muted" style={{ fontSize: '0.85rem' }}>{t('midyear.commitHint', { period: monthLabel(goLivePeriod) })}</span>
        </div>
      </section>
    </div>
  );
}
