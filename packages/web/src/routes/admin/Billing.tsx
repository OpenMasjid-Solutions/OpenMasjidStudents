// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Billing (admin + finance): fee-plan definitions, a period invoice-generation action, and a
 *  families-with-balances overview that opens each family's billing as a window. */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Wallet, Users2, Pencil } from 'lucide-react';
import { fadeRise, staggerContainer, staggerItem } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { useWindows } from '../../components/Windows';
import { FamilyBilling } from '../../components/FamilyBilling';
import { MassApply } from '../../components/MassApply';
import { formatMoney, parseCents, parseSignedCents } from '../../lib/money';

/** The code-defined export sheets (the server owns the columns — §14, no query built from input). */
type CsvDataset = 'payments' | 'invoices' | 'balances' | 'students';

export function Billing() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();
  const currencyQ = trpc.billing.currency.useQuery();
  const currency = currencyQ.data?.currency ?? 'usd';
  const plans = trpc.billing.feePlanList.useQuery();
  const overview = trpc.billing.familiesOverview.useQuery();
  const planCreate = trpc.billing.feePlanCreate.useMutation();
  const planArchive = trpc.billing.feePlanArchive.useMutation();
  const genPeriod = trpc.billing.generatePeriod.useMutation();
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

  const [plan, setPlan] = useState({ name: '', amount: '', cadence: 'monthly' });
  const [gen, setGen] = useState({ periodKey: '', label: '', dueDate: '' });
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const [item, setItem] = useState({ name: '', amount: '' });
  const [itemEdit, setItemEdit] = useState<{ id: string; name: string; amount: string } | null>(null);
  const [chargeErr, setChargeErr] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const money = (c: number) => formatMoney(c, currency);

  async function addPlan(e: FormEvent) {
    e.preventDefault();
    const cents = parseCents(plan.amount);
    if (!plan.name.trim() || !cents || cents < 1) return;
    await planCreate.mutateAsync({ name: plan.name.trim(), amountCents: cents, cadence: plan.cadence as 'monthly' | 'per_term' | 'one_time' });
    setPlan({ name: '', amount: '', cadence: 'monthly' });
    await utils.billing.feePlanList.invalidate();
  }
  async function runGenerate(e: FormEvent) {
    e.preventDefault();
    if (!gen.periodKey.trim() || !gen.label.trim()) return;
    const r = await genPeriod.mutateAsync({ periodKey: gen.periodKey.trim(), label: gen.label.trim(), dueDate: gen.dueDate || undefined });
    setGenMsg(t('billing.generatedN', { n: r.created }));
    setGen({ periodKey: '', label: '', dueDate: '' });
    await utils.billing.familiesOverview.invalidate();
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
    await Promise.all([utils.billing.autoInvoiceGet.invalidate(), utils.billing.familiesOverview.invalidate()]);
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
      await Promise.all([utils.billing.chargeList.invalidate(), utils.billing.familiesOverview.invalidate()]);
    } catch (e) {
      // The useful case: it is already on an invoice, so the fix is a negative charge, not an edit.
      setChargeErr((e as Error).message);
    }
  }
  async function runReconcile() {
    const r = await reconcileNow.mutateAsync();
    setReconcileMsg(r.ok ? t('billing.reconcileDone', { scanned: r.scanned, recorded: r.recorded }) : t('billing.reconcileUnavailable'));
    await utils.billing.reconcileStatus.invalidate();
    await utils.billing.familiesOverview.invalidate();
  }

  return (
    <motion.div className="page" variants={fadeRise} initial="initial" animate="animate">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('nav.billing')}</h1>
        <span className="spacer" />
        {/* Export what the office needs for its own records. The server builds the CSV (and escapes
            spreadsheet formulas); the browser just saves it. */}
        <select
          className="input glass-inset"
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
      </div>

      {/* Fee plans */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.feePlans')}</h2></div>
        {(plans.data ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('billing.noPlans')}</p>
        ) : (
          <div className="chip-row">
            {plans.data?.map((p) => (
              <span key={p.id} className="chip">{p.name} · {money(p.amountCents)} · {t(`billing.cad_${p.cadence}`)}
                <button type="button" className="link-btn" style={{ marginInlineStart: '0.4rem' }} onClick={async () => { await planArchive.mutateAsync({ id: p.id }); await utils.billing.feePlanList.invalidate(); }}>×</button>
              </span>
            ))}
          </div>
        )}
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
                    <td>{c.firstName} {c.lastName}</td>
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

        <form className="inline-form glass-inset" onSubmit={runGenerate} style={{ marginBlockStart: 0 }}>
          <div className="field"><label className="label">{t('billing.periodKey')}</label><input className="input glass-inset" value={gen.periodKey} onChange={(e) => setGen({ ...gen, periodKey: e.target.value })} placeholder="2026-07" /></div>
          <div className="field"><label className="label">{t('billing.label')}</label><input className="input glass-inset" value={gen.label} onChange={(e) => setGen({ ...gen, label: e.target.value })} placeholder={t('billing.labelHint')} /></div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('billing.due')}</label><input type="date" className="input glass-inset" value={gen.dueDate} onChange={(e) => setGen({ ...gen, dueDate: e.target.value })} /></div>
          <button type="submit" className="btn btn--primary" disabled={genPeriod.isPending}>{t('billing.generateAll')}</button>
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

      {/* Families with balances */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('billing.families')}</h2></div>
        {(overview.data ?? []).length === 0 ? (
          <p className="empty">{t('billing.noFamilies')}</p>
        ) : (
          <motion.div className="card-grid" variants={staggerContainer} initial="initial" animate="animate">
            {overview.data?.map((f) => (
              <motion.button key={f.id} type="button" className="fam-card glass fx-glint" variants={staggerItem} onClick={() => openFamily(f.id, f.name)}>
                <h3>{f.name}</h3>
                <div className={f.balance.owedCents > 0 ? 'merit-total is-neg' : 'merit-total is-pos'} style={{ fontSize: '1.1rem' }}>
                  {f.balance.owedCents > 0 ? money(f.balance.owedCents) : f.balance.creditCents > 0 ? `${money(f.balance.creditCents)} ${t('billing.credit')}` : money(0)}
                </div>
              </motion.button>
            ))}
          </motion.div>
        )}
      </section>
    </motion.div>
  );
}
