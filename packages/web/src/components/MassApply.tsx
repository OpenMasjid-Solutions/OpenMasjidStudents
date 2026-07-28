// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Mass apply (admin + finance): put one fee plan, or one charge, onto many students at once.
 *
 * Both server procedures (`assignFeeBulk`, `chargeAddBulk`) take the SAME target shape — explicit
 * students, a whole class, or a whole course — so they share one picker here rather than growing two
 * that drift. Only active students are ever targeted; the server re-resolves the target and filters
 * withdrawn students again, so a stale selection can never create rows for someone who has left.
 *
 * The two are deliberately different in one way, and the copy says so: assigning a fee plan is
 * IDEMPOTENT (a student who already carries the plan is skipped, never duplicated), whereas a charge
 * is a new one-off line every time — applying it twice bills twice. That is why the charge side
 * confirms before it fires.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '../lib/trpc';
import { formatMoney, parseCents, parseSignedCents } from '../lib/money';

type TargetKind = 'course' | 'class' | 'students';
type Mode = 'fee' | 'charge';

export function MassApply({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  const tree = trpc.structure.courseTree.useQuery();
  const roster = trpc.structure.studentsByClass.useQuery({});
  const plans = trpc.billing.feePlanList.useQuery();
  const items = trpc.billing.chargeItemList.useQuery();

  const assignBulk = trpc.billing.assignFeeBulk.useMutation();
  const chargeBulk = trpc.billing.chargeAddBulk.useMutation();

  const [mode, setMode] = useState<Mode>('fee');
  const [targetKind, setTargetKind] = useState<TargetKind>('class');
  const [courseId, setCourseId] = useState('');
  const [classId, setClassId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const [feePlanId, setFeePlanId] = useState('');
  const [feeOverride, setFeeOverride] = useState('');
  const [note, setNote] = useState('');

  /** A charge is either a catalogue item (optionally re-priced here) or a free-typed one-off. */
  const [chargeItemId, setChargeItemId] = useState('');
  const [chargeLabel, setChargeLabel] = useState('');
  const [chargeAmount, setChargeAmount] = useState('');
  const [periodKey, setPeriodKey] = useState('');

  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const money = (c: number) => formatMoney(c, currency);
  const courses = tree.data ?? [];
  const allClasses = useMemo(
    () => courses.flatMap((c) => c.classes.map((k) => ({ id: k.id, label: `${c.name} · ${k.name}`, studentCount: k.studentCount }))),
    [courses],
  );

  const students = useMemo(() => {
    const rows = roster.data ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => `${r.fullName} ${r.familyName}`.toLowerCase().includes(needle)) : rows;
  }, [roster.data, q]);

  /** How many students this target currently resolves to — shown before applying, so nobody mass
   *  charges 80 families to find out. Advisory: the server resolves it again for real. */
  const targetCount = useMemo(() => {
    if (targetKind === 'students') return picked.size;
    if (targetKind === 'class') return allClasses.find((k) => k.id === classId)?.studentCount ?? 0;
    const c = courses.find((x) => x.id === courseId);
    return c ? c.classes.reduce((n, k) => n + k.studentCount, 0) : 0;
  }, [targetKind, picked, classId, courseId, allClasses, courses]);

  function target() {
    if (targetKind === 'students') return { kind: 'students' as const, studentIds: [...picked] };
    if (targetKind === 'class') return { kind: 'class' as const, classId };
    return { kind: 'course' as const, courseId };
  }

  const targetReady = targetKind === 'students' ? picked.size > 0 : targetKind === 'class' ? !!classId : !!courseId;

  function toggle(id: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function apply(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setResult(null);
    try {
      if (mode === 'fee') {
        if (!feePlanId) return;
        const cents = feeOverride.trim() ? parseCents(feeOverride) : undefined;
        const r = await assignBulk.mutateAsync({
          feePlanId,
          target: target(),
          ...(cents ? { overrideAmountCents: cents } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        setResult(t('mass.feeResult', { assigned: r.assigned, skipped: r.skipped, targeted: r.targeted }));
        await Promise.all([utils.billing.familyFees.invalidate(), utils.billing.yearGrid.invalidate()]);
      } else {
        // Signed: a negative charge is a credit, which parseCents would reject outright.
        const source = chargeItemId
          ? { kind: 'item' as const, chargeItemId, ...(chargeAmount.trim() ? { amountCents: parseSignedCents(chargeAmount) ?? 0 } : {}) }
          : { kind: 'custom' as const, label: chargeLabel.trim(), amountCents: parseSignedCents(chargeAmount) ?? 0 };
        if (source.kind === 'custom' && (!source.label || !source.amountCents)) return;
        // A charge is not idempotent — applying twice bills twice — so make the count explicit first.
        if (!window.confirm(t('mass.confirmCharge', { count: targetCount }))) return;
        const r = await chargeBulk.mutateAsync({
          source,
          target: target(),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(periodKey.trim() ? { periodKey: periodKey.trim() } : {}),
        });
        setResult(t('mass.chargeResult', { created: r.created, attached: r.attached, targeted: r.targeted }));
        await Promise.all([utils.billing.chargeList.invalidate(), utils.billing.familyBilling.invalidate(), utils.billing.familiesOverview.invalidate()]);
      }
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  const busy = assignBulk.isPending || chargeBulk.isPending;
  /** Negative charges are how a credit or scholarship is expressed — worth saying out loud so a
   *  minus sign does not look like a mistake. */
  const chargeCents = parseSignedCents(chargeAmount);

  return (
    <div className="win-content">
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('mass.what')}</h2></div>
        <div className="chip-row">
          <label className={`chip ${mode === 'fee' ? '' : 'is-muted'}`} style={{ cursor: 'pointer' }}>
            <input type="radio" name="mass-mode" checked={mode === 'fee'} onChange={() => setMode('fee')} style={{ marginInlineEnd: '0.35rem' }} />
            {t('mass.modeFee')}
          </label>
          <label className={`chip ${mode === 'charge' ? '' : 'is-muted'}`} style={{ cursor: 'pointer' }}>
            <input type="radio" name="mass-mode" checked={mode === 'charge'} onChange={() => setMode('charge')} style={{ marginInlineEnd: '0.35rem' }} />
            {t('mass.modeCharge')}
          </label>
        </div>
        <p className="hint">{mode === 'fee' ? t('mass.feeHint') : t('mass.chargeHint')}</p>

        {mode === 'fee' ? (
          <div className="inline-form glass-inset">
            <div className="field" style={{ minWidth: '12rem' }}>
              <label className="label">{t('mass.feePlan')}</label>
              <select className="input glass-inset" value={feePlanId} onChange={(e) => setFeePlanId(e.target.value)}>
                <option value="">{t('mass.pickPlan')}</option>
                {(plans.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {money(p.amountCents)} · {t(`billing.cad_${p.cadence}`)}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label">{t('mass.overrideAmount')}</label>
              <input type="number" step="0.01" min="0" className="input glass-inset" value={feeOverride} onChange={(e) => setFeeOverride(e.target.value)} placeholder={t('mass.planAmount')} />
            </div>
            <div className="field">
              <label className="label">{t('mass.note')}</label>
              <input className="input glass-inset" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            </div>
          </div>
        ) : (
          <div className="inline-form glass-inset">
            <div className="field" style={{ minWidth: '11rem' }}>
              <label className="label">{t('mass.item')}</label>
              <select
                className="input glass-inset"
                value={chargeItemId}
                onChange={(e) => {
                  setChargeItemId(e.target.value);
                  const it = (items.data ?? []).find((i) => i.id === e.target.value);
                  // Pre-fill with the item's price so "apply as-is" needs no typing, and re-pricing
                  // this one application is just editing the number.
                  setChargeAmount(it ? (it.defaultAmountCents / 100).toFixed(2) : '');
                }}
              >
                <option value="">{t('mass.customCharge')}</option>
                {(items.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>{i.name} · {money(i.defaultAmountCents)}</option>
                ))}
              </select>
            </div>
            {!chargeItemId && (
              <div className="field" style={{ minWidth: '10rem' }}>
                <label className="label">{t('mass.chargeLabel')}</label>
                <input className="input glass-inset" value={chargeLabel} onChange={(e) => setChargeLabel(e.target.value)} maxLength={120} />
              </div>
            )}
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label">{t('mass.amount')}</label>
              <input type="number" step="0.01" className="input glass-inset" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 1 8rem' }}>
              <label className="label">{t('mass.periodKey')}</label>
              <input className="input glass-inset" value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} placeholder="2026-07" />
            </div>
            <div className="field">
              <label className="label">{t('mass.note')}</label>
              <input className="input glass-inset" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            </div>
            <p className="hint">{chargeCents !== null && chargeCents < 0 ? t('mass.negativeHint') : t('mass.periodHint')}</p>
          </div>
        )}
      </section>

      {/* ── Who ────────────────────────────────────────────────────────────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('mass.who')}</h2>
          <span className="chip is-muted">{t('mass.nTargeted', { count: targetCount })}</span>
        </div>

        <div className="chip-row">
          {(['course', 'class', 'students'] as TargetKind[]).map((k) => (
            <label key={k} className={`chip ${targetKind === k ? '' : 'is-muted'}`} style={{ cursor: 'pointer' }}>
              <input type="radio" name="mass-target" checked={targetKind === k} onChange={() => setTargetKind(k)} style={{ marginInlineEnd: '0.35rem' }} />
              {t(`mass.by_${k}`)}
            </label>
          ))}
        </div>

        {targetKind === 'course' && (
          <div className="inline-form glass-inset">
            <div className="field" style={{ minWidth: '12rem' }}>
              <label className="label">{t('mass.course')}</label>
              <select className="input glass-inset" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">{t('mass.pickCourse')}</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            {courses.length === 0 && <p className="hint">{t('mass.noStructure')}</p>}
          </div>
        )}

        {targetKind === 'class' && (
          <div className="inline-form glass-inset">
            <div className="field" style={{ minWidth: '14rem' }}>
              <label className="label">{t('mass.class')}</label>
              <select className="input glass-inset" value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">{t('mass.pickClass')}</option>
                {allClasses.map((k) => <option key={k.id} value={k.id}>{k.label} · {t('mass.nStudents', { count: k.studentCount })}</option>)}
              </select>
            </div>
            {allClasses.length === 0 && <p className="hint">{t('mass.noStructure')}</p>}
          </div>
        )}

        {targetKind === 'students' && (
          <>
            <div className="inline-form glass-inset" style={{ alignItems: 'end' }}>
              <div className="field" style={{ flex: 1, minWidth: '11rem' }}>
                <label className="label">{t('students.search')}</label>
                <input className="input glass-inset" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('students.searchPlaceholder')} />
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => setPicked(new Set(students.map((s) => s.id)))}>{t('mass.selectAllShown')}</button>
              <button type="button" className="btn btn--ghost" onClick={() => setPicked(new Set())}>{t('mass.clearSelection')}</button>
            </div>
            <div className="glass-inset" style={{ maxHeight: '16rem', overflowY: 'auto', padding: '0.5rem 0.7rem', borderRadius: 'var(--radius-card)' }}>
              {students.length === 0 ? (
                <p className="muted" style={{ fontSize: '0.9rem', margin: 0 }}>{t('students.noMatches')}</p>
              ) : (
                students.map((s) => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.2rem 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                    <span>{s.fullName}</span>
                    <span className="muted" style={{ fontSize: '0.82rem' }}>
                      {s.className ? `${s.courseName ?? '—'} · ${s.className}` : t('students.unplaced')}
                    </span>
                  </label>
                ))
              )}
            </div>
          </>
        )}
      </section>

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        {err && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{err}</div>}
        {result && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{result}</div>}
        <form onSubmit={apply}>
          <button type="submit" className="btn btn--primary" disabled={busy || !targetReady || (mode === 'fee' ? !feePlanId : !chargeCents)}>
            {busy ? t('mass.applying') : t('mass.apply', { count: targetCount })}
          </button>
        </form>
      </section>
    </div>
  );
}
