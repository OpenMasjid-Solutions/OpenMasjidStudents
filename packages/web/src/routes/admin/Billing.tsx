// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Billing (admin + finance): recording a payment, fee-plan definitions, charges, and invoice
 *  generation.
 *
 *  RECORDING A PAYMENT IS FIRST, because it is the thing the office does twenty times a morning and
 *  everything else on this page is something they set up once. It used to be buried two clicks down —
 *  find the household in a grid of cards, open its window, then pick the child — so the top of the page
 *  is now a search box for the child and the amount. The households grid that used to sit at the bottom
 *  is gone with it: the year view is the better way into a family's record, and one press of a child's
 *  name there opens the same window.
 *
 *  `canManagePlans` is the admin/finance line (§5): finance runs the billing — generate invoices,
 *  record payments, chase balances — but WHAT the madrasa charges is the office's decision, so
 *  creating, archiving and deleting fee plans is admin-only. Finance still READS the plans, because
 *  no invoice screen means anything without their names. The server enforces the same wall. */
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Wallet, Users2, Pencil, CalendarClock, ArrowRight } from 'lucide-react';
import { fadeRise } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { useWindows } from '../../components/Windows';
import { FamilyBilling } from '../../components/FamilyBilling';
import { MassApply } from '../../components/MassApply';
import { StudentPicker } from '../../components/StudentPicker';
import { formatMoney, parseCents, parseSignedCents } from '../../lib/money';

/** The go-live wizard is a once-per-install screen — no reason for every parent's phone to download it
 *  with the rest of the app. (Same treatment as What's new.) */
const MidYearSetup = lazy(() => import('../../components/MidYearSetup').then((m) => ({ default: m.MidYearSetup })));

/** The channels the office can record by hand — kept in step with the server by the mutation's own
 *  input type, so a drift here fails `tsc` rather than at runtime. */
const MANUAL_CHANNELS = ['cash', 'check', 'ach', 'zelle', 'other'] as const;

/** Month names for the label PREVIEW only. The stored label is resolved server-side from the period key
 *  (billing/period.ts) — this is what the office sees while typing, never what is written. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
type ManualChannel = (typeof MANUAL_CHANNELS)[number];

/** The code-defined export sheets (the server owns the columns — §14, no query built from input). */
type CsvDataset = 'payments' | 'invoices' | 'balances' | 'students';

export function Billing({ canManagePlans }: { canManagePlans: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();
  const currencyQ = trpc.billing.currency.useQuery();
  const currency = currencyQ.data?.currency ?? 'usd';
  const plans = trpc.billing.feePlanList.useQuery();
  const planCreate = trpc.billing.feePlanCreate.useMutation();
  const planArchive = trpc.billing.feePlanArchive.useMutation();
  const planDelete = trpc.billing.feePlanDelete.useMutation();
  const genPeriod = trpc.billing.generatePeriod.useMutation();
  // The saved label template, the tags and the months worth billing — all from the server, so the form
  // never invents a period key and the wording persists between months.
  const labelCfg = trpc.billing.invoiceLabelConfig.useQuery();
  const reconcileStatusQ = trpc.billing.reconcileStatus.useQuery();
  const reconcileNow = trpc.billing.reconcileNow.useMutation();

  // Charge items: the catalogue the one-off charges are applied from. A charge snapshots its label
  // and amount when applied, so editing an item here never rewrites a charge already raised.
  const items = trpc.billing.chargeItemList.useQuery();
  const itemCreate = trpc.billing.chargeItemCreate.useMutation();
  const itemUpdate = trpc.billing.chargeItemUpdate.useMutation();
  const itemArchive = trpc.billing.chargeItemArchive.useMutation();
  const chargesQ = trpc.billing.chargeList.useQuery({});
  const chargeVoid = trpc.billing.chargeVoid.useMutation();
  const exportCsv = trpc.billing.exportCsv.useMutation();
  const auto = trpc.billing.autoInvoiceGet.useQuery();
  const setAuto = trpc.billing.autoInvoiceSet.useMutation();
  const runAuto = trpc.billing.autoInvoiceRunNow.useMutation();

  // ── Recording a payment (the top of the page) ─────────────────────────────
  const roster = trpc.people.studentOptions.useQuery();
  const pay = trpc.billing.recordManualPayment.useMutation();
  const [payment, setPayment] = useState<{ studentId: string; amount: string; channel: ManualChannel; occurredAt: string; memo: string }>({
    studentId: '',
    amount: '',
    channel: 'cash',
    occurredAt: new Date().toISOString().slice(0, 10),
    memo: '',
  });
  /** Lines the office ticked, when the parent said what the money was for. */
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [payMsg, setPayMsg] = useState<string | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);
  const payables = trpc.billing.studentPayables.useQuery({ studentId: payment.studentId }, { enabled: !!payment.studentId });
  const midYear = trpc.billing.midYearStatus.useQuery();

  const [plan, setPlan] = useState({ name: '', amount: '', cadence: 'monthly' });
  const [gen, setGen] = useState({ periodKey: '', label: '', dueDate: '' });
  /** Seed the month and the wording from the server ONCE it arrives, and only while the office has not
   *  typed anything — re-seeding over an edit in progress is the classic controlled-input bug. */
  useEffect(() => {
    if (!labelCfg.data) return;
    setGen((g) => ({
      ...g,
      periodKey: g.periodKey || labelCfg.data!.suggested,
      label: g.label || labelCfg.data!.template,
    }));
  }, [labelCfg.data]);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const [item, setItem] = useState({ name: '', amount: '' });
  const [itemEdit, setItemEdit] = useState<{ id: string; name: string; amount: string } | null>(null);
  const [chargeErr, setChargeErr] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const money = (c: number) => formatMoney(c, currency);

  /** The lines currently ticked, in the order they are shown. */
  const chosen = useMemo(() => (payables.data?.lines ?? []).filter((l) => ticked[l.itemId]), [payables.data, ticked]);
  const chosenCents = chosen.reduce((s, l) => s + l.balanceCents, 0);

  /** Tick a line: the amount follows the ticks, because "what am I paying for" and "how much" are the
   *  same question at the desk. Untick everything and the amount is the office's own again. */
  function toggleLine(itemId: string, on: boolean) {
    const next = { ...ticked, [itemId]: on };
    setTicked(next);
    const lines = payables.data?.lines ?? [];
    const total = lines.filter((l) => next[l.itemId]).reduce((s, l) => s + l.balanceCents, 0);
    setPayment((p) => ({ ...p, amount: total > 0 ? (total / 100).toFixed(2) : '' }));
  }

  function pickStudent(studentId: string) {
    setPayment((p) => ({ ...p, studentId, amount: '', memo: '' }));
    setTicked({});
    setPayMsg(null);
    setPayErr(null);
  }

  /**
   * Record it. When lines are ticked the money is DIRECTED at them, so the book fee the parent came in
   * to pay is the line that ends up settled — not whichever bill happens to be oldest.
   */
  async function doPay(e: FormEvent) {
    e.preventDefault();
    setPayErr(null);
    setPayMsg(null);
    const cents = parseCents(payment.amount);
    if (!cents || cents < 1 || !payment.studentId) return;
    const name = roster.data?.find((s) => s.id === payment.studentId)?.fullName ?? '';
    // Only direct the money when the ticks actually describe the amount — a part-payment of a ticked
    // line, or extra on top, is ordinary money and belongs on the oldest bill.
    const directed = chosen.length && chosenCents === cents ? chosen.map((l) => ({ itemId: l.itemId, amountCents: l.balanceCents })) : undefined;
    try {
      await pay.mutateAsync({
        studentId: payment.studentId,
        amountCents: cents,
        channel: payment.channel,
        occurredAt: payment.occurredAt,
        memo: payment.memo.trim() || undefined,
        ...(directed ? { directed } : {}),
      });
      setPayMsg(t('billing.recordedFor', { amount: money(cents), name }));
      setPayment((p) => ({ ...p, amount: '', memo: '' }));
      setTicked({});
      await Promise.all([utils.billing.studentPayables.invalidate({ studentId: payment.studentId }), utils.billing.yearGrid.invalidate(), utils.billing.chargeList.invalidate()]);
    } catch (err) {
      setPayErr((err as Error).message);
    }
  }

  function openStudentBilling(studentId: string) {
    const s = roster.data?.find((k) => k.id === studentId);
    if (!s) return;
    open({ title: s.fullName, wide: true, dedupeKey: `billing:${s.familyId}`, icon: <Wallet size={15} />, node: <FamilyBilling familyId={s.familyId} currency={currency} focusStudentId={studentId} /> });
  }

  function openMidYear() {
    open({ title: t('midyear.title'), wide: true, dedupeKey: 'midyear', icon: <CalendarClock size={15} />, node: <Suspense fallback={<p className="empty">{t('common.loading')}</p>}><MidYearSetup currency={currency} /></Suspense> });
  }

  async function addPlan(e: FormEvent) {
    e.preventDefault();
    const cents = parseCents(plan.amount);
    if (!plan.name.trim() || !cents || cents < 1) return;
    await planCreate.mutateAsync({ name: plan.name.trim(), amountCents: cents, cadence: plan.cadence as 'monthly' | 'per_term' | 'one_time' });
    setPlan({ name: '', amount: '', cadence: 'monthly' });
    await utils.billing.feePlanList.invalidate();
  }

  /**
   * Get rid of a plan — deleted outright if it has never been billed, archived if it has.
   *
   * The × used to archive unconditionally, which quietly left a wrong row (a typo, a duplicate) in the
   * history forever. Ask the server which of the two is possible and say what will happen, rather than
   * making the office guess: a plan named on a raised invoice is part of what that invoice MEANT, so it
   * can only ever be archived. Either way every student on it is unassigned, which is the part worth
   * warning about — they stop being billed for it.
   */
  async function removePlan(id: string, name: string) {
    setPlanMsg(null);
    try {
      const info = await utils.billing.feePlanDeletable.fetch({ id });
      if (info.deletable) {
        if (!window.confirm(t('billing.confirmPlanDelete', { name, count: info.assignedStudents }))) return;
        await planDelete.mutateAsync({ id });
      } else {
        if (!window.confirm(t('billing.confirmPlanArchive', { name, count: info.invoiceLines }))) return;
        await planArchive.mutateAsync({ id });
      }
      await Promise.all([utils.billing.feePlanList.invalidate()]);
    } catch (e) {
      setPlanMsg((e as Error).message);
    }
  }
  async function runGenerate(e: FormEvent) {
    e.preventDefault();
    if (!gen.periodKey || !gen.label.trim()) return;
    // The TEMPLATE goes to the server, which resolves the tags from the period key it is filing the
    // invoice under — so the label and the month cannot disagree, and the wording is remembered for next
    // month and for the nightly job (billing/period.ts resolveInvoiceLabel).
    const r = await genPeriod.mutateAsync({ periodKey: gen.periodKey, labelTemplate: gen.label.trim(), dueDate: gen.dueDate || undefined });
    setGenMsg(t('billing.generatedN', { n: r.created }));
    await utils.billing.invoiceLabelConfig.invalidate();
    setGen({ ...gen, dueDate: '' });
  }

  /** The label as it will read, using the same tags the server resolves. A preview, not the source of
   *  truth — the server derives the stored label from the period key itself. */
  function previewLabel(template: string, periodKey: string): string {
    const [y, m] = periodKey.split('-').map(Number);
    if (!y || !m) return template;
    const subs: Record<string, string> = {
      month: MONTH_NAMES[m - 1],
      mon: MONTH_NAMES[m - 1].slice(0, 3),
      year: String(y),
      yy: String(y).slice(-2),
      period: periodKey,
    };
    return template.replace(/\[(month|mon|year|yy|period)\]/gi, (whole, tag: string) => subs[tag.toLowerCase()] ?? whole);
  }
  function openFamily(id: string, name: string) {
    open({ title: name, wide: true, dedupeKey: `billing:${id}`, icon: <Wallet size={15} />, node: <FamilyBilling familyId={id} currency={currency} /> });
  }
  function openMassApply() {
    open({ title: t('mass.title'), wide: true, dedupeKey: 'mass-apply', icon: <Users2 size={15} />, node: <MassApply currency={currency} /> });
  }

  async function addItem(e: FormEvent) {
    e.preventDefault();
    // An item may be priced negative (a standing credit, e.g. a bursary line).
    const cents = parseSignedCents(item.amount);
    if (!item.name.trim() || cents === null || cents === 0) return;
    await itemCreate.mutateAsync({ name: item.name.trim(), defaultAmountCents: cents });
    setItem({ name: '', amount: '' });
    await utils.billing.chargeItemList.invalidate();
  }
  async function saveItem(e: FormEvent) {
    e.preventDefault();
    if (!itemEdit) return;
    const cents = parseSignedCents(itemEdit.amount);
    if (!itemEdit.name.trim() || cents === null || cents === 0) return;
    await itemUpdate.mutateAsync({ id: itemEdit.id, name: itemEdit.name.trim(), defaultAmountCents: cents });
    setItemEdit(null);
    await utils.billing.chargeItemList.invalidate();
  }
  async function saveAuto(patch: { enabled?: boolean; day?: number; dueDay?: number | null }) {
    setAutoMsg(null);
    await setAuto.mutateAsync(patch);
    await utils.billing.autoInvoiceGet.invalidate();
  }

  /** Run the scheduled generation now, and say plainly why it did nothing when it did nothing —
   *  "outside the school year" and "already done this month" are both normal, not errors. */
  async function runAutoNow() {
    setAutoMsg(null);
    const r = await runAuto.mutateAsync();
    setAutoMsg(r.ran ? t('billing.autoRan', { period: r.periodKey, n: r.created ?? 0 }) : t(`billing.autoWhy_${r.reason ?? 'disabled'}`));
    await Promise.all([utils.billing.autoInvoiceGet.invalidate()]);
  }

  /** Save the server-built CSV. A Blob + object URL keeps it a plain download with no extra route,
   *  and the BOM makes Excel open UTF-8 names correctly instead of mangling them. */
  async function download(dataset: CsvDataset) {
    const r = await exportCsv.mutateAsync({ dataset });
    const blob = new Blob([`﻿${r.csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = r.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doChargeVoid(id: string) {
    setChargeErr(null);
    try {
      await chargeVoid.mutateAsync({ id });
      await Promise.all([utils.billing.chargeList.invalidate()]);
    } catch (e) {
      // The useful case: it is already on an invoice, so the fix is a negative charge, not an edit.
      setChargeErr((e as Error).message);
    }
  }
  async function runReconcile() {
    const r = await reconcileNow.mutateAsync();
    setReconcileMsg(r.ok ? t('billing.reconcileDone', { scanned: r.scanned, recorded: r.recorded }) : t('billing.reconcileUnavailable'));
    await utils.billing.reconcileStatus.invalidate();
  }

  return (
    <motion.div className="page" variants={fadeRise} initial="initial" animate="animate">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('nav.billing')}</h1>
        <span className="spacer" />
        {/* Export what the office needs for its own records. The server builds the CSV (and escapes
            spreadsheet formulas); the browser just saves it.
            Hidden on a phone (`no-mobile`): a downloaded spreadsheet on a phone has nothing to open it
            and nowhere useful to go, so the control was only ever taking up the row. */}
        <select
          className="input glass-inset no-mobile"
          style={{ width: 'auto', minWidth: '11rem' }}
          value=""
          onChange={(e) => { if (e.target.value) void download(e.target.value as CsvDataset); }}
          disabled={exportCsv.isPending}
          aria-label={t('billing.exportCsv')}
        >
          <option value="">{exportCsv.isPending ? t('billing.exporting') : t('billing.exportCsv')}</option>
          <option value="payments">{t('billing.ds_payments')}</option>
          <option value="invoices">{t('billing.ds_invoices')}</option>
          <option value="balances">{t('billing.ds_balances')}</option>
          <option value="students">{t('billing.ds_students')}</option>
        </select>
        <button type="button" className="btn btn--ghost" onClick={openMassApply}><Users2 size={15} /> {t('mass.title')}</button>
        {canManagePlans && (
          <button type="button" className="btn btn--ghost" onClick={openMidYear}><CalendarClock size={15} /> {t('midyear.open')}</button>
        )}
      </div>

      {/* ── Record a payment — first, because it is the thing the office does all morning ───────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.recordPayment')}</h2></div>
        {payErr && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{payErr}</div>}
        {payMsg && (
          <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>
            {payMsg}{' '}
            <button type="button" className="link-btn" onClick={() => openStudentBilling(payment.studentId)}>{t('billing.openRecord')} <ArrowRight size={12} /></button>
          </div>
        )}
        <form className="inline-form glass-inset" onSubmit={doPay} style={{ marginBlockStart: 0 }}>
          {/* Type the name OR browse the roster — the same control does both (StudentPicker). */}
          <div style={{ flex: '1 1 15rem', minWidth: '13rem' }}>
            <StudentPicker students={roster.data ?? []} value={payment.studentId} onChange={pickStudent} label={t('billing.forStudent')} placeholder={t('billing.findStudent')} />
          </div>
          <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.amount')}</label>
            <input type="number" step="0.01" min="0" className="input glass-inset" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.channel')}</label>
            <select className="input glass-inset" value={payment.channel} onChange={(e) => setPayment({ ...payment, channel: e.target.value as ManualChannel })}>
              {MANUAL_CHANNELS.map((c) => <option key={c} value={c}>{t(`billing.ch_${c}`)}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('billing.date')}</label>
            <input type="date" className="input glass-inset" value={payment.occurredAt} onChange={(e) => setPayment({ ...payment, occurredAt: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '1 1 8rem' }}><label className="label">{t('billing.memo')}</label>
            <input className="input glass-inset" value={payment.memo} onChange={(e) => setPayment({ ...payment, memo: e.target.value })} maxLength={200} />
          </div>
          <button type="submit" className="btn btn--primary" disabled={pay.isPending || !payment.studentId || !parseCents(payment.amount)}>{t('billing.record')}</button>
        </form>

        {/* What this child owes, line by line. Ticking lines fills in the amount AND records the money
            against those lines, so "he's here to pay the trip" ends up settling the trip. */}
        {payment.studentId && payables.data && (
          <div className="glass-inset" style={{ padding: '0.7rem 0.85rem', borderRadius: 'var(--radius-card)', marginBlockStart: '0.7rem' }}>
            {payables.data.lines.length === 0 ? (
              <p className="muted" style={{ fontSize: '0.9rem', margin: 0 }}>
                {payables.data.balance.creditCents > 0
                  ? t('billing.nothingDueCredit', { amount: money(payables.data.balance.creditCents) })
                  : t('billing.nothingDue')}
              </p>
            ) : (
              <>
                <p className="label" style={{ marginBlockEnd: '0.4rem' }}>{t('billing.owesLines', { amount: money(payables.data.balance.owedCents) })}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {payables.data.lines.map((l) => (
                    <label key={l.itemId} className="pay-line" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!ticked[l.itemId]} onChange={(e) => toggleLine(l.itemId, e.target.checked)} />
                      <span className={`chip ${l.kind === 'tuition' ? '' : 'is-accent'}`}>{t(`billing.kind_${l.kind}`)}</span>
                      <span style={{ flex: '1 1 auto' }}>{l.label} <span className="muted">· {l.invoiceLabel}</span></span>
                      <span className="tnum">{money(l.balanceCents)}</span>
                    </label>
                  ))}
                </div>
                {chosen.length > 0 && <p className="hint">{t('billing.tickedHint', { count: chosen.length, amount: money(chosenCents) })}</p>}
              </>
            )}
          </div>
        )}
      </section>

      {/* Starting mid-year: offered until the go-live step has been run or the office has billed a
          month, since after that it is not what they need. */}
      {canManagePlans && midYear.data && !midYear.data.committedAt && (
        <div className="notice notice--warn" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <CalendarClock size={16} />
          <span style={{ flex: '1 1 18rem' }}>{t('midyear.banner')}</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={openMidYear}>{t('midyear.open')}</button>
        </div>
      )}

      {/* Fee plans */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.feePlans')}</h2></div>
        {(plans.data ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{canManagePlans ? t('billing.noPlans') : t('billing.noPlansFinance')}</p>
        ) : (
          <div className="chip-row">
            {plans.data?.map((p) => (
              <span key={p.id} className="chip">{p.name} · {money(p.amountCents)} · {t(`billing.cad_${p.cadence}`)}
                {canManagePlans && (
                  <button type="button" className="link-btn" style={{ marginInlineStart: '0.4rem' }} title={t('common.remove')} onClick={() => void removePlan(p.id, p.name)}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
        {planMsg && <p className="form-error">{planMsg}</p>}
        {canManagePlans && (
          <form className="inline-form glass-inset" onSubmit={addPlan}>
            <div className="field"><label className="label">{t('billing.planName')}</label><input className="input glass-inset" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} /></div>
            <div className="field" style={{ flex: '0 1 7rem' }}><label className="label">{t('billing.amount')}</label><input type="number" step="0.01" min="0" className="input glass-inset" value={plan.amount} onChange={(e) => setPlan({ ...plan, amount: e.target.value })} /></div>
            <div className="field" style={{ flex: '0 1 9rem' }}><label className="label">{t('billing.cadence')}</label>
              <select className="input glass-inset" value={plan.cadence} onChange={(e) => setPlan({ ...plan, cadence: e.target.value })}>
                {['monthly', 'per_term', 'one_time'].map((c) => <option key={c} value={c}>{t(`billing.cad_${c}`)}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={planCreate.isPending}>{t('billing.addPlan')}</button>
          </form>
        )}
      </section>

      {/* Charge items — the catalogue one-off charges are applied from (uniform, exam fee, trip…). */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.items')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('billing.itemsHint')}</p>
        {(items.data ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('billing.noItems')}</p>
        ) : (
          <div className="chip-row">
            {items.data?.map((i) => (
              <span key={i.id} className="chip">
                {i.name} · {money(i.defaultAmountCents)}
                <button type="button" className="link-btn" style={{ marginInlineStart: '0.4rem' }} aria-label={t('common.edit')} onClick={() => setItemEdit({ id: i.id, name: i.name, amount: (i.defaultAmountCents / 100).toFixed(2) })}><Pencil size={12} /></button>
                <button type="button" className="link-btn" style={{ marginInlineStart: '0.3rem' }} aria-label={t('structure.archive')} onClick={async () => { await itemArchive.mutateAsync({ id: i.id }); await utils.billing.chargeItemList.invalidate(); }}>×</button>
              </span>
            ))}
          </div>
        )}
        {itemEdit && (
          <form className="inline-form glass-inset" onSubmit={saveItem}>
            <div className="field"><label className="label">{t('billing.itemName')}</label><input className="input glass-inset" value={itemEdit.name} onChange={(e) => setItemEdit({ ...itemEdit, name: e.target.value })} autoFocus /></div>
            <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.amount')}</label><input type="number" step="0.01" className="input glass-inset" value={itemEdit.amount} onChange={(e) => setItemEdit({ ...itemEdit, amount: e.target.value })} /></div>
            <button type="submit" className="btn btn--primary" disabled={itemUpdate.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setItemEdit(null)}>{t('common.cancel')}</button>
            <p className="hint">{t('billing.itemEditHint')}</p>
          </form>
        )}
        <form className="inline-form glass-inset" onSubmit={addItem}>
          <div className="field"><label className="label">{t('billing.itemName')}</label><input className="input glass-inset" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} placeholder={t('billing.itemPlaceholder')} /></div>
          <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('billing.amount')}</label><input type="number" step="0.01" className="input glass-inset" value={item.amount} onChange={(e) => setItem({ ...item, amount: e.target.value })} /></div>
          <button type="submit" className="btn btn--primary" disabled={itemCreate.isPending}>{t('billing.addItem')}</button>
        </form>
      </section>

      {/* Charges raised — pending ones can still be voided; invoiced ones are immutable (§9). */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.charges')}</h2></div>
        {chargeErr && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{chargeErr}</div>}
        {(chargesQ.data ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('billing.noCharges')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('students.name')}</th>
                  <th>{t('billing.chargeLabel')}</th>
                  <th>{t('billing.amount')}</th>
                  <th>{t('billing.periodKey')}</th>
                  <th>{t('billing.status')}</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {chargesQ.data?.slice(0, 60).map((c) => (
                  <tr key={c.id}>
                    <td>{c.fullName}</td>
                    <td>{c.label}{c.note && <span className="muted"> · {c.note}</span>}</td>
                    <td className={c.amountCents < 0 ? 'merit-total is-pos' : ''}>{money(c.amountCents)}</td>
                    <td>{c.periodKey ?? '—'}</td>
                    <td><span className={`chip ${c.status === 'invoiced' ? 'is-accent' : c.status === 'void' ? 'is-muted' : ''}`}>{t(`billing.cs_${c.status}`)}</span></td>
                    <td className="actions">
                      {c.status === 'pending' && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={chargeVoid.isPending} onClick={() => doChargeVoid(c.id)}>{t('billing.void')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(chargesQ.data ?? []).length > 60 && <p className="hint">{t('billing.chargesTruncated', { shown: 60, total: chargesQ.data?.length ?? 0 })}</p>}
          </div>
        )}
      </section>

      {/* Generate invoices for a period */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.generateInvoices')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('billing.generateHint')}</p>
        {genMsg && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{genMsg}</div>}
        {/* Automatic generation — off until an admin turns it on, since it starts billing every
            family on its own. "Run now" uses the very same code path as the nightly job. */}
        {auto.data && (
          <div className="glass-inset" style={{ padding: '0.7rem 0.85rem', borderRadius: 'var(--radius-card)', marginBlockEnd: '0.6rem' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={auto.data.enabled} onChange={(e) => void saveAuto({ enabled: e.target.checked })} />
              <span className="label" style={{ margin: 0 }}>{t('billing.autoOn')}</span>
            </label>
            <div className="inline-form" style={{ marginBlockStart: '0.5rem' }}>
              <div className="field" style={{ flex: '0 1 8rem' }}>
                <label className="label">{t('billing.autoDay')}</label>
                <input type="number" min={1} max={31} className="input glass-inset" value={String(auto.data.day)} onChange={(e) => void saveAuto({ day: Number(e.target.value) })} />
              </div>
              <div className="field" style={{ flex: '0 1 8rem' }}>
                <label className="label">{t('billing.autoDueDay')}</label>
                <input type="number" min={1} max={31} className="input glass-inset" value={auto.data.dueDay === null ? '' : String(auto.data.dueDay)} onChange={(e) => void saveAuto({ dueDay: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <button type="button" className="btn btn--ghost" disabled={runAuto.isPending} onClick={runAutoNow}>{runAuto.isPending ? t('billing.autoRunning') : t('billing.autoRunNow')}</button>
            </div>
            <p className="hint">{t('billing.autoHint')}</p>
            {auto.data.lastPeriodKey && <p className="hint">{t('billing.autoLast', { period: auto.data.lastPeriodKey })}</p>}
            {autoMsg && <div className="notice" style={{ marginBlockStart: '0.5rem' }}>{autoMsg}</div>}
          </div>
        )}

        {/* The month is PICKED and the label is a template with tags — neither is typed out from scratch
            every month. Two free-text boxes that had to agree with each other was one keystroke away from
            "Tuition — Jun 2026" filed under 2026-07, on a record that is never edited afterwards. */}
        <form className="inline-form glass-inset" onSubmit={runGenerate} style={{ marginBlockStart: 0 }}>
          <div className="field" style={{ flex: '0 1 12rem' }}>
            <label className="label" htmlFor="gen-period">{t('billing.forMonth')}</label>
            <select id="gen-period" className="input glass-inset" value={gen.periodKey} onChange={(e) => setGen({ ...gen, periodKey: e.target.value })}>
              {(labelCfg.data?.months ?? []).map((m) => (
                <option key={m.periodKey} value={m.periodKey}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="gen-label">{t('billing.label')}</label>
            <input id="gen-label" className="input glass-inset" value={gen.label} onChange={(e) => setGen({ ...gen, label: e.target.value })} placeholder={t('billing.labelHint')} />
            {/* Tag chips, so nobody has to remember the spelling — and a live preview, because a template
                with tags in it is not what a parent will read. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBlockStart: '0.35rem', alignItems: 'center' }}>
              {(labelCfg.data?.tags ?? []).map((tg) => (
                <button
                  key={tg.tag}
                  type="button"
                  className="chip"
                  title={t('billing.tagInsert', { example: tg.example })}
                  onClick={() => setGen((g) => ({ ...g, label: `${g.label}[${tg.tag}]` }))}
                >
                  [{tg.tag}]
                </button>
              ))}
            </div>
            {gen.label.trim() && gen.periodKey && (
              <p className="hint" style={{ marginBlockStart: '0.35rem' }}>{t('billing.labelPreview', { label: previewLabel(gen.label, gen.periodKey) })}</p>
            )}
          </div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('billing.due')}</label><input type="date" className="input glass-inset" value={gen.dueDate} onChange={(e) => setGen({ ...gen, dueDate: e.target.value })} /></div>
          <button type="submit" className="btn btn--primary" disabled={genPeriod.isPending || !gen.periodKey || !gen.label.trim()}>{t('billing.generateAll')}</button>
        </form>
      </section>

      {/* Payment sync — Stripe reconciliation (§11.4): recover any card payment a webhook/broker call missed. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.paymentsSync')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('billing.reconcileHint')}</p>
        {reconcileMsg && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{reconcileMsg}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--primary" disabled={reconcileNow.isPending} onClick={runReconcile}>
            {reconcileNow.isPending ? t('billing.reconciling') : t('billing.reconcileNow')}
          </button>
          {reconcileStatusQ.data && (
            <span className="muted" style={{ fontSize: '0.85rem' }}>{t('billing.reconcileLast', { when: new Date(reconcileStatusQ.data.ranAt).toLocaleString(), recorded: reconcileStatusQ.data.recorded })}</span>
          )}
        </div>
      </section>

      {/* No households grid here any more. It was a wall of cards with one number on each, and the way
          into a family's record is now the year view — where the same name also tells you their course,
          their class and which months they have paid. */}
      <p className="hint">{t('billing.familiesMovedHint')}</p>
    </motion.div>
  );
}
