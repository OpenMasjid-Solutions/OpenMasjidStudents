// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** One family's billing (admin/finance window): balance, per-student fee assignment + discount,
 *  invoices (with void), a manual-payment form, and the payments ledger (with reverse). Money is
 *  integer cents end-to-end; the server ledger is the source of truth. RTL-safe.
 *
 *  `focusStudentId` is the child the window was opened FOR — pressing a name in the year view lands
 *  here, so the payment form and the charge form start on that child instead of asking again. The
 *  window still shows the whole household, because one adult pays for all of them. */
import { Fragment, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer, Pencil, Users } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatMoney, parseCents, parseSignedCents } from '../lib/money';
import { formatDate, type DateFormat } from '../lib/dates';
import { PrintableLink } from './PrintableLink';
import { useWindows } from './Windows';
import { FamilyDetail } from '../routes/admin/FamilyDetail';

/** The channels the office can record by hand. Kept in step with the server's
 *  `MANUAL_PAYMENT_CHANNELS` by the router's own input type — `recordManualPayment` types `channel`
 *  as its zod enum, so if this list drifts, `tsc` fails here rather than at runtime. Declared in the
 *  web rather than imported so no server code is pulled into the browser bundle. */
const MANUAL_CHANNELS = ['cash', 'check', 'ach', 'zelle', 'other'] as const;
type ManualChannel = (typeof MANUAL_CHANNELS)[number];

export function FamilyBilling({ familyId, currency, focusStudentId }: { familyId: string; currency: string; focusStudentId?: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();
  const billing = trpc.billing.familyBilling.useQuery({ familyId });
  const fees = trpc.billing.familyFees.useQuery({ familyId });
  const plans = trpc.billing.feePlanList.useQuery();
  const assign = trpc.billing.assignFee.useMutation();
  const unassign = trpc.billing.unassignFee.useMutation();
  const setOverride = trpc.billing.setFeeOverride.useMutation();
  const items = trpc.billing.chargeItemList.useQuery();
  const chargesQ = trpc.billing.chargeList.useQuery({ familyId });
  const chargeAdd = trpc.billing.chargeAdd.useMutation();
  const chargeVoid = trpc.billing.chargeVoid.useMutation();
  const generate = trpc.billing.generateFamily.useMutation();
  const voidInv = trpc.billing.voidInvoice.useMutation();
  const pay = trpc.billing.recordManualPayment.useMutation();
  const reverse = trpc.billing.reversePayment.useMutation();

  const [gen, setGen] = useState({ periodKey: '', label: '', dueDate: '' });
  // Start on the child the window was opened for. Nothing re-syncs this afterwards on purpose: once
  // the office has picked a different sibling, moving it back under them would be the bug.
  const [payment, setPayment] = useState<{ studentId: string; amount: string; channel: ManualChannel; occurredAt: string; memo: string }>({ studentId: focusStudentId ?? '', amount: '', channel: 'cash', occurredAt: new Date().toISOString().slice(0, 10), memo: '' });
  /** Which fee assignment is having its per-student amount edited, if any. */
  const [override, setOverrideForm] = useState<{ feeId: string; amount: string; note: string } | null>(null);
  const [charge, setCharge] = useState({ studentId: focusStudentId ?? '', chargeItemId: '', label: '', amount: '', periodKey: '', note: '' });
  const [chargeErr, setChargeErr] = useState<string | null>(null);
  const money = (c: number) => formatMoney(c, currency);
  /** How this masjid writes dates (0.47.0). `settings.display` — admin AND finance, unlike
   *  `settings.get`, and this screen is finance's. */
  const dateFormat = (trpc.settings.display.useQuery().data?.dateFormat ?? 'iso') as DateFormat;
  /** Whose invoice / payment this is. Every row carries a child now, so the tables say so. */
  const nameOf = (studentId: string) => {
    const s = (billing.data?.students ?? []).find((k) => k.id === studentId);
    return s ? s.fullName : '';
  };

  const refresh = async () => {
    await utils.billing.familyBilling.invalidate({ familyId });
    await utils.billing.familyFees.invalidate({ familyId });
    await utils.billing.chargeList.invalidate({ familyId });
    // The year grid's "Paying" column and month cells both derive from these.
    await utils.billing.yearGrid.invalidate();
  };

  async function doGenerate(e: FormEvent) {
    e.preventDefault();
    if (!gen.periodKey.trim() || !gen.label.trim()) return;
    await generate.mutateAsync({ familyId, periodKey: gen.periodKey.trim(), label: gen.label.trim(), dueDate: gen.dueDate || undefined });
    setGen({ periodKey: '', label: '', dueDate: '' });
    await refresh();
  }
  async function doPay(e: FormEvent) {
    e.preventDefault();
    const cents = parseCents(payment.amount);
    if (!cents || cents < 1 || !payment.studentId) return;
    await pay.mutateAsync({ studentId: payment.studentId, amountCents: cents, channel: payment.channel, occurredAt: payment.occurredAt, memo: payment.memo.trim() || undefined });
    // The child stays selected: several siblings paying at once is several records in a row, and
    // re-picking the same name every time would be the annoying part.
    setPayment({ ...payment, amount: '', memo: '' });
    await refresh();
  }

  /** Save (or clear) one student's own amount for a plan they already carry — the "override instead
   *  of minting a whole new plan" path. A blank amount clears it back to the plan's price. */
  async function saveOverride(e: FormEvent) {
    e.preventDefault();
    if (!override) return;
    const cents = override.amount.trim() ? parseCents(override.amount) : null;
    await setOverride.mutateAsync({ id: override.feeId, overrideAmountCents: cents, note: override.note.trim() });
    setOverrideForm(null);
    await refresh();
  }

  async function addCharge(e: FormEvent) {
    e.preventDefault();
    setChargeErr(null);
    // Signed: a negative charge credits the student (a refund or scholarship), which the
    // owed-amount parser rejects.
    const cents = parseSignedCents(charge.amount);
    if (!charge.studentId || cents === null || cents === 0) return;
    if (!charge.chargeItemId && !charge.label.trim()) return;
    try {
      await chargeAdd.mutateAsync({
        studentId: charge.studentId,
        source: charge.chargeItemId
          ? { kind: 'item', chargeItemId: charge.chargeItemId, amountCents: cents }
          : { kind: 'custom', label: charge.label.trim(), amountCents: cents },
        ...(charge.periodKey.trim() ? { periodKey: charge.periodKey.trim() } : {}),
        ...(charge.note.trim() ? { note: charge.note.trim() } : {}),
      });
      setCharge({ studentId: '', chargeItemId: '', label: '', amount: '', periodKey: '', note: '' });
      await refresh();
    } catch (err) {
      setChargeErr((err as Error).message);
    }
  }

  const bal = billing.data?.balance;
  const activePlans = plans.data ?? [];
  // Group the flat (student × assignment) rows by student: a student with no fee has one row with
  // a null feeId; a student with N plans has N rows. Grouping lets us show every assigned plan AND
  // always offer an "assign another" dropdown (multiple plans per student are allowed).
  const feeGroups = (() => {
    const m = new Map<
      string,
      {
        name: string;
        fees: { feeId: string; feePlanId: string; feePlanName: string; amountCents: number; overrideAmountCents: number | null; effectiveAmountCents: number | null; note: string | null }[];
      }
    >();
    for (const r of fees.data ?? []) {
      const g = m.get(r.studentId) ?? { name: r.fullName, fees: [] };
      if (r.feeId && r.feePlanId) {
        g.fees.push({
          feeId: r.feeId,
          feePlanId: r.feePlanId,
          feePlanName: r.feePlanName ?? '',
          amountCents: r.amountCents ?? 0,
          overrideAmountCents: r.overrideAmountCents,
          effectiveAmountCents: r.effectiveAmountCents,
          note: r.note,
        });
      }
      m.set(r.studentId, g);
    }
    return [...m.entries()];
  })();

  return (
    <div className="win-content">
      {/* Balance */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('billing.balance')}</h2>
          {/* The people record is one press away — the year view now opens THIS window on a name, so
              guardians, contacts and the children themselves need a door from here. */}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => open({ title: t('billing.familyRecord'), wide: true, dedupeKey: `family:${familyId}`, icon: <Users size={15} />, node: <FamilyDetail familyId={familyId} /> })}>
            <Users size={14} /> {t('billing.familyRecord')}
          </button>
          <PrintableLink path={`/statements/family/${familyId}`} filename={`statement-${familyId}`} title={t('billing.printStatement')}><Printer size={14} /> {t('billing.printStatement')}</PrintableLink>
        </div>
        {bal && (
          <div className="bal-big" style={{ color: bal.owedCents > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
            {bal.owedCents > 0 ? money(bal.owedCents) : bal.creditCents > 0 ? `${money(bal.creditCents)} ${t('billing.credit')}` : money(0)}
          </div>
        )}
      </section>

      {/* Fees + discount */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.fees')}</h2></div>
        {feeGroups.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('billing.noStudents')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {feeGroups.map(([studentId, g]) => {
              const assigned = new Set(g.fees.map((f) => f.feePlanId));
              const available = activePlans.filter((p) => !assigned.has(p.id));
              return (
                <div key={studentId} className="glass-inset" style={{ padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-button)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ flex: '1 1 10rem' }}>{g.name}</span>
                  {g.fees.map((f) => {
                    const overridden = f.overrideAmountCents !== null;
                    return (
                      <span key={f.feeId} className={`chip ${overridden ? 'is-accent' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                        {f.feePlanName} ·{' '}
                        {overridden ? (
                          // Show what is actually billed, with the plan's price struck through, so an
                          // override is visible at a glance rather than looking like a wrong amount.
                          <>
                            <s className="muted">{money(f.amountCents)}</s> {money(f.effectiveAmountCents ?? f.amountCents)}
                          </>
                        ) : (
                          money(f.amountCents)
                        )}
                        {f.note && <span className="muted" style={{ fontSize: '0.8rem' }}>· {f.note}</span>}
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          style={{ padding: '0 0.25rem' }}
                          aria-label={t('billing.editAmount')}
                          onClick={() => setOverrideForm({ feeId: f.feeId, amount: overridden ? ((f.overrideAmountCents ?? 0) / 100).toFixed(2) : '', note: f.note ?? '' })}
                        >
                          <Pencil size={12} />
                        </button>
                        <button type="button" className="btn btn--ghost btn--sm" style={{ padding: '0 0.25rem' }} aria-label={t('billing.removeFee')} onClick={async () => { await unassign.mutateAsync({ id: f.feeId }); await refresh(); }}>×</button>
                      </span>
                    );
                  })}
                  {available.length > 0 && (
                    <select className="input glass-inset" style={{ flex: '0 1 12rem' }} value="" onChange={async (e) => { if (e.target.value) { await assign.mutateAsync({ studentId, feePlanId: e.target.value }); await refresh(); } }}>
                      <option value="">{g.fees.length ? t('billing.addFee') : t('billing.assignFee')}</option>
                      {available.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.amountCents)}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {override && (
          <form className="inline-form glass-inset" onSubmit={saveOverride}>
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label">{t('billing.overrideAmount')}</label>
              <input type="number" step="0.01" min="0" className="input glass-inset" value={override.amount} onChange={(e) => setOverrideForm({ ...override, amount: e.target.value })} placeholder={t('billing.planPrice')} autoFocus />
            </div>
            <div className="field">
              <label className="label">{t('billing.overrideNote')}</label>
              <input className="input glass-inset" value={override.note} onChange={(e) => setOverrideForm({ ...override, note: e.target.value })} maxLength={200} placeholder={t('billing.overrideNoteHint')} />
            </div>
            <button type="submit" className="btn btn--primary" disabled={setOverride.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setOverrideForm(null)}>{t('common.cancel')}</button>
            <p className="hint">{t('billing.overrideHint')}</p>
          </form>
        )}
      </section>

      {/* One-off charges for this family's students */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.charges')}</h2></div>
        {chargeErr && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{chargeErr}</div>}
        {(chargesQ.data ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('billing.noCharges')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <tbody>
                {chargesQ.data?.map((c) => (
                  <tr key={c.id}>
                    <td>{c.fullName}</td>
                    <td>{c.label}{c.note && <span className="muted"> · {c.note}</span>}</td>
                    <td className={c.amountCents < 0 ? 'merit-total is-pos' : ''}>{money(c.amountCents)}</td>
                    <td>{c.periodKey ?? '—'}</td>
                    <td><span className={`chip ${c.status === 'invoiced' ? 'is-accent' : c.status === 'void' ? 'is-muted' : ''}`}>{t(`billing.cs_${c.status}`)}</span></td>
                    <td className="actions">
                      {c.status === 'pending' && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={chargeVoid.isPending}
                          onClick={async () => {
                            setChargeErr(null);
                            try {
                              await chargeVoid.mutateAsync({ id: c.id });
                              await refresh();
                            } catch (err) {
                              setChargeErr((err as Error).message);
                            }
                          }}
                        >
                          {t('billing.void')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="inline-form glass-inset" onSubmit={addCharge}>
          <div className="field" style={{ minWidth: '9rem' }}>
            <label className="label">{t('billing.student')}</label>
            <select className="input glass-inset" value={charge.studentId} onChange={(e) => setCharge({ ...charge, studentId: e.target.value })}>
              <option value="">{t('billing.pickStudent')}</option>
              {feeGroups.map(([id, g]) => <option key={id} value={id}>{g.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: '9rem' }}>
            <label className="label">{t('billing.item')}</label>
            <select
              className="input glass-inset"
              value={charge.chargeItemId}
              onChange={(e) => {
                const it = (items.data ?? []).find((i) => i.id === e.target.value);
                setCharge({ ...charge, chargeItemId: e.target.value, amount: it ? (it.defaultAmountCents / 100).toFixed(2) : charge.amount });
              }}
            >
              <option value="">{t('billing.customCharge')}</option>
              {(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name} · {money(i.defaultAmountCents)}</option>)}
            </select>
          </div>
          {!charge.chargeItemId && (
            <div className="field"><label className="label">{t('billing.chargeLabel')}</label><input className="input glass-inset" value={charge.label} onChange={(e) => setCharge({ ...charge, label: e.target.value })} maxLength={120} /></div>
          )}
          <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.amount')}</label><input type="number" step="0.01" className="input glass-inset" value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value })} /></div>
          <div className="field" style={{ flex: '0 1 7rem' }}><label className="label">{t('billing.periodKey')}</label><input className="input glass-inset" value={charge.periodKey} onChange={(e) => setCharge({ ...charge, periodKey: e.target.value })} placeholder="2026-07" /></div>
          <div className="field"><label className="label">{t('billing.memo')}</label><input className="input glass-inset" value={charge.note} onChange={(e) => setCharge({ ...charge, note: e.target.value })} maxLength={200} /></div>
          <button type="submit" className="btn btn--primary" disabled={chargeAdd.isPending}>{t('billing.addCharge')}</button>
          <p className="hint">{t('billing.chargeHint')}</p>
        </form>
      </section>

      {/* Invoices + generate */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.invoices')}</h2></div>
        {(billing.data?.invoices ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('billing.noInvoices')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>{t('students.name')}</th><th>{t('billing.invoice')}</th><th>{t('billing.due')}</th><th>{t('billing.total')}</th><th>{t('billing.paid')}</th><th>{t('billing.status')}</th><th className="actions" /></tr></thead>
              <tbody>
                {billing.data?.invoices.map((i) => (
                  <Fragment key={i.id}>
                    <tr>
                      <td>{nameOf(i.studentId)}</td>
                      <td>{i.label}</td>
                      <td>{formatDate(i.dueDate, dateFormat) || '—'}</td>
                      <td>{money(i.totalCents)}</td>
                      <td>{money(i.paidCents)}</td>
                      <td><span className={`chip ${i.status === 'paid' ? 'is-accent' : 'is-muted'}`}>{t(`billing.st_${i.status}`)}</span></td>
                      <td className="actions">
                        {/* The bill as a document a family can be handed — one child, one period,
                            line by line, on the masjid's letterhead. Opens in a tab so the browser's
                            own Print dialog gives a real preview and a save-as-PDF. */}
                        <PrintableLink path={`/invoices/${i.id}`} filename={`invoice-${i.label.replace(/[^a-zA-Z0-9]+/g, '-')}`} title={i.label} linkTitle={t('billing.printInvoiceHint')}>
                          <Printer size={14} /> {t('billing.printInvoice')}
                        </PrintableLink>
                        {i.status !== 'void' && i.paidCents === 0 && <button type="button" className="btn btn--ghost btn--sm" onClick={async () => { await voidInv.mutateAsync({ id: i.id }); await refresh(); }}>{t('billing.void')}</button>}
                      </td>
                    </tr>
                    {/* The lines of that bill. Shown for every invoice with more than one, because a
                        parent asking "what is this $250?" is the question this answers — and it says
                        which line the money has covered, not just how much arrived. */}
                    {i.lines.length > 1 &&
                      i.lines.map((l) => (
                        <tr key={l.itemId} className="line-row">
                          <td />
                          <td colSpan={2} style={{ paddingInlineStart: '1.4rem' }}>
                            <span className={`chip ${l.kind === 'tuition' ? 'is-muted' : 'is-accent'}`}>{t(`billing.kind_${l.kind}`)}</span> {l.label}
                          </td>
                          <td>{money(l.amountCents)}</td>
                          <td>{money(l.coveredCents)}</td>
                          <td className="muted">{l.balanceCents === 0 ? t('billing.lineSettled') : t('billing.lineOwing', { amount: money(l.balanceCents) })}</td>
                          <td />
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="inline-form glass-inset" onSubmit={doGenerate}>
          <div className="field"><label className="label">{t('billing.periodKey')}</label><input className="input glass-inset" value={gen.periodKey} onChange={(e) => setGen({ ...gen, periodKey: e.target.value })} placeholder="2026-07" /></div>
          <div className="field"><label className="label">{t('billing.label')}</label><input className="input glass-inset" value={gen.label} onChange={(e) => setGen({ ...gen, label: e.target.value })} placeholder={t('billing.labelHint')} /></div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('billing.due')}</label><input type="date" className="input glass-inset" value={gen.dueDate} onChange={(e) => setGen({ ...gen, dueDate: e.target.value })} /></div>
          <button type="submit" className="btn btn--primary" disabled={generate.isPending}>{t('billing.generate')}</button>
        </form>
      </section>

      {/* Record payment — against ONE child, because that is how the money arrives: "Yusuf brought
          cash for April". It lands in his balance and his own bills absorb it oldest-first. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.recordPayment')}</h2></div>
        <form className="inline-form glass-inset" onSubmit={doPay} style={{ marginBlockStart: 0 }}>
          <div className="field" style={{ flex: '1 1 11rem' }}><label className="label">{t('billing.forStudent')}</label>
            <select className="input glass-inset" value={payment.studentId} onChange={(e) => setPayment({ ...payment, studentId: e.target.value })} required>
              <option value="">{t('billing.chooseStudent')}</option>
              {(billing.data?.students ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}{s.balance.owedCents > 0 ? ` — ${money(s.balance.owedCents)} ${t('billing.owed')}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.amount')}</label><input type="number" step="0.01" min="0" className="input glass-inset" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} /></div>
          <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.channel')}</label>
            <select className="input glass-inset" value={payment.channel} onChange={(e) => setPayment({ ...payment, channel: e.target.value as ManualChannel })}>
              {MANUAL_CHANNELS.map((c) => <option key={c} value={c}>{t(`billing.ch_${c}`)}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('billing.date')}</label><input type="date" className="input glass-inset" value={payment.occurredAt} onChange={(e) => setPayment({ ...payment, occurredAt: e.target.value })} /></div>
          <div className="field"><label className="label">{t('billing.memo')}</label><input className="input glass-inset" value={payment.memo} onChange={(e) => setPayment({ ...payment, memo: e.target.value })} /></div>
          <button type="submit" className="btn btn--primary" disabled={pay.isPending || !payment.studentId || !parseCents(payment.amount)}>{t('billing.record')}</button>
          <p className="hint">{t('billing.recordHint')}</p>
        </form>

        {(billing.data?.payments ?? []).length > 0 && (
          <div style={{ overflowX: 'auto', marginBlockStart: '0.75rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('students.name')}</th>
                  <th>{t('billing.amount')}</th>
                  <th>{t('billing.channel')}</th>
                  <th>{t('billing.date')}</th>
                  <th>{t('billing.memo')}</th>
                  {/* WHO took the money. A cash payment is the one kind nobody else can verify, so the
                      name of the person who wrote it down is part of the record — and it is what a
                      volunteer finance manager needs when a figure is queried a month later. */}
                  <th>{t('billing.recordedBy')}</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {billing.data?.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{nameOf(p.studentId)}</td>
                    <td className={p.amountCents < 0 ? 'merit-total is-neg' : 'merit-total is-pos'}>{money(p.amountCents)}</td>
                    <td>{t(`billing.ch_${p.channel}`, p.channel)}</td>
                    <td>{formatDate(new Date(p.occurredAt as unknown as number).toISOString().slice(0, 10), dateFormat)}</td>
                    <td className="muted">{p.memo ?? ''}</td>
                    {/* A card payment records itself, so there is no person to name — say so rather
                        than leaving a blank cell that reads like missing data. */}
                    <td className="muted">{p.by ?? t('billing.recordedAuto')}</td>
                    <td className="actions">{p.amountCents > 0 && !p.reversalOf && <button type="button" className="btn btn--ghost btn--sm" onClick={async () => { if (!window.confirm(t('billing.confirmReverse'))) return; await reverse.mutateAsync({ paymentId: p.id }); await refresh(); }}>{t('billing.reverse')}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* No discount section: a household discount had nowhere honest to sit once each child gets
          their own bill. A reduced rate is now the per-student amount on the fee assignment above,
          which is also where it shows up on the invoice the parent actually receives. */}
    </div>
  );
}
