// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * STARTING A NEW YEAR — three steps, in the order an office actually does them (0.52.0-dev.15).
 *
 * Hasan asked for this directly: "I want the readmission stuff to move to when starting a new
 * year… once you go to start a new year, that button, you know, it's going to ask for the
 * readmission stuff and whatnot… and there should be a prompt asking for how much the admission fee
 * is this time around."
 *
 * ── Why it is one flow rather than three screens ────────────────────────────
 *
 * Opening a year, deciding what it costs to join, and asking three hundred families whether they are
 * coming back are three procedures the app already had — on three different screens, in two
 * different sections, none of which mentioned the others. An office starting a new year had to KNOW
 * to visit all three, in that order, and the failure mode was silent: the year opens, nobody is
 * asked, and the first anybody notices is when September arrives with no roster.
 *
 * So the button that opens a year walks the rest of it. Each step still calls the same procedure it
 * always did — `schoolYearCreate`, `schoolYearUpdate`, `readmissionOpen` — because a wizard that
 * grew its own write path would be a second answer to what a school year is (§16).
 *
 * ── The fees are PRE-FILLED FROM LAST YEAR, and confirmed rather than retyped ─
 *
 * A madrasah's joining fee is the same most years and changes occasionally, so the useful question
 * is "still £50?" rather than "what is it?". Pre-filling from the most recent year that had one
 * makes the common case a glance and the change deliberate. **Blank means no fee**, which is what
 * most madāris charge, and clearing the box is how an office says so — it is not the same as
 * leaving the step alone.
 *
 * ── Asking the families is a SEPARATE press, and it is skippable ─────────────
 *
 * It writes a row per returning child and mints nothing until the office sends links, but it is
 * still the step that turns a quiet year into three hundred rows. An office opening next year's
 * calendar in March to plan terms should not discover they have just started re-enrollment.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Check, CircleDollarSign, Users } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { parseCents, formatMoney } from '../lib/money';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Step = 'year' | 'fees' | 'families' | 'done';

export function StartYear({ schoolId, onDone }: { schoolId?: string; onDone?: () => void | Promise<unknown> }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const thisYear = new Date().getFullYear();

  const years = trpc.structure.schoolYearList.useQuery({ schoolId });
  const display = trpc.settings.display.useQuery();
  const create = trpc.structure.schoolYearCreate.useMutation();
  const update = trpc.structure.schoolYearUpdate.useMutation();
  const openRows = trpc.admissions.readmissionOpen.useMutation();

  const [step, setStep] = useState<Step>('year');
  const [yearId, setYearId] = useState('');
  const [form, setForm] = useState({ label: '', startYear: String(thisYear), startMonth: '9', endMonth: '6' });
  const [fees, setFees] = useState({ admission: '', readmission: '' });
  const [opened, setOpened] = useState<{ created: number; existing: number } | null>(null);
  const [err, setErr] = useState('');

  const currency = display.data?.currency ?? 'usd';

  /** The most recent year that named a fee — the answer to "still the same as last time?". */
  function lastFees(): { admission: string; readmission: string } {
    const withFees = (years.data ?? []).filter((y) => y.admissionFeeCents != null || y.readmissionFeeCents != null);
    const last = withFees[0];
    if (!last) return { admission: '', readmission: '' };
    return {
      admission: last.admissionFeeCents != null ? String(last.admissionFeeCents / 100) : '',
      readmission: last.readmissionFeeCents != null ? String(last.readmissionFeeCents / 100) : '',
    };
  }

  async function makeYear(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const r = await create.mutateAsync({
        schoolId,
        label: form.label.trim(),
        startYear: Number(form.startYear),
        startMonth: Number(form.startMonth),
        endMonth: Number(form.endMonth),
        makeCurrent: true,
      });
      setYearId(r.id);
      setFees(lastFees());
      setStep('fees');
      await utils.structure.schoolYearList.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function saveFees(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await update.mutateAsync({
        id: yearId,
        // Blank is NOT "leave it alone" here — it is "no fee", which is what most madāris charge and
        // what a year starts with. The step exists to be answered, including with nothing.
        admissionFeeCents: fees.admission.trim() ? (parseCents(fees.admission) ?? null) : null,
        readmissionFeeCents: fees.readmission.trim() ? (parseCents(fees.readmission) ?? null) : null,
      });
      setStep('families');
      await utils.structure.schoolYearList.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function askFamilies() {
    setErr('');
    try {
      const r = await openRows.mutateAsync({ schoolYearId: yearId, target: { kind: 'all' } });
      setOpened({ created: r.created, existing: r.existing });
      setStep('done');
      await utils.admissions.readmissionBoard.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  const dot = (s: Step, n: number) => (
    <span className={`chip${step === s ? '' : ' is-muted'}`}>
      {n}. {t(`startYear.step_${s}`)}
    </span>
  );

  return (
    <div className="win-content">
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
          {dot('year', 1)}
          {dot('fees', 2)}
          {dot('families', 3)}
        </div>
      </section>

      {step === 'year' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><CalendarPlus size={15} /> {t('startYear.yearTitle')}</h2>
          </div>
          <p className="hint">{t('startYear.yearHint')}</p>
          <form onSubmit={makeYear}>
            <div className="inline-form">
              <div className="field" style={{ flex: '2 1 12rem' }}>
                <label className="label" htmlFor="sy-label">{t('structure.yearName')}</label>
                <input id="sy-label" className="input glass-inset" value={form.label} placeholder={t('structure.yearPlaceholder')} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </div>
              <div className="field">
                <label className="label" htmlFor="sy-start">{t('structure.startsIn')}</label>
                <input id="sy-start" className="input glass-inset" type="number" min={2000} max={2200} style={{ width: '7rem' }} value={form.startYear} onChange={(e) => setForm({ ...form, startYear: e.target.value })} />
              </div>
              <div className="field">
                <label className="label" htmlFor="sy-from">{t('structure.from')}</label>
                <select id="sy-from" className="input glass-inset" value={form.startMonth} onChange={(e) => setForm({ ...form, startMonth: e.target.value })}>
                  {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="sy-to">{t('structure.to')}</label>
                <select id="sy-to" className="input glass-inset" value={form.endMonth} onChange={(e) => setForm({ ...form, endMonth: e.target.value })}>
                  {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
                </select>
              </div>
            </div>
            <p className="hint">{t('structure.wrapHint')}</p>
            <button type="submit" className="btn btn--primary" disabled={create.isPending || !form.label.trim()}>
              {t('startYear.next')}
            </button>
          </form>
          {err && <p className="form-error">{err}</p>}
        </section>
      )}

      {step === 'fees' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><CircleDollarSign size={15} /> {t('startYear.feesTitle')}</h2>
          </div>
          <p className="hint">{t('startYear.feesHint')}</p>
          <form onSubmit={saveFees}>
            <div className="inline-form">
              <div className="field" style={{ flex: '1 1 12rem' }}>
                <label className="label" htmlFor="sy-adm">{t('startYear.admissionFee')}</label>
                <input id="sy-adm" className="input glass-inset" inputMode="decimal" value={fees.admission} placeholder={t('startYear.noFee')} onChange={(e) => setFees({ ...fees, admission: e.target.value })} />
              </div>
              <div className="field" style={{ flex: '1 1 12rem' }}>
                <label className="label" htmlFor="sy-readm">{t('startYear.readmissionFee')}</label>
                <input id="sy-readm" className="input glass-inset" inputMode="decimal" value={fees.readmission} placeholder={t('startYear.noFee')} onChange={(e) => setFees({ ...fees, readmission: e.target.value })} />
              </div>
            </div>
            <p className="hint">{t('startYear.feesBlank')}</p>
            <button type="submit" className="btn btn--primary" disabled={update.isPending}>{t('startYear.next')}</button>
          </form>
          {err && <p className="form-error">{err}</p>}
        </section>
      )}

      {step === 'families' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><Users size={15} /> {t('startYear.familiesTitle')}</h2>
          </div>
          <p className="hint">{t('startYear.familiesHint')}</p>
          {fees.readmission.trim() && (
            <p className="notice notice--warn">
              {t('startYear.familiesFee', { amount: formatMoney(parseCents(fees.readmission) ?? 0, currency) })}
            </p>
          )}
          <div className="inline-form">
            <button type="button" className="btn btn--primary" disabled={openRows.isPending} onClick={() => void askFamilies()}>
              {t('startYear.askAll')}
            </button>
            {/* Skippable on purpose — an office opening next year's calendar in March to plan terms
                should not discover they have just started re-enrollment. */}
            <button type="button" className="btn btn--ghost" onClick={() => setStep('done')}>{t('startYear.skip')}</button>
          </div>
          {err && <p className="form-error">{err}</p>}
        </section>
      )}

      {step === 'done' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><Check size={15} /> {t('startYear.doneTitle')}</h2>
          </div>
          <p className="notice notice--ok" style={{ margin: 0 }}>
            {opened
              ? t('startYear.doneAsked', { created: opened.created, existing: opened.existing })
              : t('startYear.doneQuiet')}
          </p>
          <p className="hint">{t('startYear.doneNext')}</p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onDone?.()}>{t('common.close')}</button>
        </section>
      )}
    </div>
  );
}
