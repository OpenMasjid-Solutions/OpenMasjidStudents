// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Starting a new school year (0.48.0).
 *
 * It replaces an "Activate" button that flipped one boolean: the page looked identical afterwards, every
 * child was still in last year's class, and every plan was still last year's price. This asks the four
 * questions a rollover actually is — where each class goes, who is leaving, what the fees are, and have you
 * seen what is still owed — and applies the lot in one transaction (structure/rollover.ts).
 *
 * NOTHING HAPPENS UNTIL THE LAST STEP. Every screen here edits a local draft; the single commit at the end
 * is the only write. That matters because a rollover has no undo, so it has to be reviewable — the last step
 * is a plain sentence of what is about to change.
 *
 * THE CLASS STEP IS THE HEART OF IT. Each class gets one of three answers — stays as it is, moves its
 * children into another class, or graduates — pre-filled from the class order (Hifz 1 → Hifz 2, the last one
 * graduates) so an ordinary year is a matter of reading rather than choosing. Any class can be expanded to
 * send ONE child somewhere different, which is what a repeating student needs.
 */
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Check, ChevronDown, ChevronRight, GraduationCap } from 'lucide-react';
import { fadeRise } from '../lib/motion';
import { trpc, type RouterOutputs } from '../lib/trpc';
import { formatMoney, parseCents } from '../lib/money';
import { monthName } from '../lib/months';

type Plan = RouterOutputs['structure']['yearRolloverPlan'];
type Destination = Plan['classes'][number]['suggested'];

const STEPS = ['classes', 'leavers', 'fees', 'owing', 'confirm'] as const;
type Step = (typeof STEPS)[number];

/** A destination as one dropdown value, so the select needs no parallel state. */
const toValue = (d: Destination): string => (d.kind === 'move' ? `move:${d.toClassId}` : d.kind);
const fromValue = (v: string): Destination =>
  v === 'stay' ? { kind: 'stay' } : v === 'graduate' ? { kind: 'graduate' } : { kind: 'move', toClassId: v.slice(5) };

export function YearRollover({ schoolId, onDone }: { schoolId?: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const plan = trpc.structure.yearRolloverPlan.useQuery({ schoolId });
  const commit = trpc.structure.yearRolloverCommit.useMutation();
  const currency = trpc.billing.currency.useQuery().data?.currency ?? 'usd';

  const [step, setStep] = useState<Step>('classes');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<RouterOutputs['structure']['yearRolloverCommit'] | null>(null);

  // ── The draft. Empty means "as suggested" / "unchanged", so nothing is copied until it is touched.
  const [year, setYear] = useState<{ label: string; startYear: string; startMonth: string; endMonth: string } | null>(null);
  const [moves, setMoves] = useState<Record<string, Destination>>({});
  const [studentMoves, setStudentMoves] = useState<Record<string, Destination>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [withTerms, setWithTerms] = useState(true);

  const d = plan.data;
  const yearEff = year ?? {
    label: d?.suggestedYear.label ?? '',
    startYear: String(d?.suggestedYear.startYear ?? ''),
    startMonth: String(d?.suggestedYear.startMonth ?? 9),
    endMonth: String(d?.suggestedYear.endMonth ?? 6),
  };
  /** A class's destination: what the office chose, else what we suggested. */
  const destOf = (c: Plan['classes'][number]): Destination => moves[c.id] ?? c.suggested;
  /** A child's: their own, else their class's. */
  const destOfStudent = (studentId: string, c: Plan['classes'][number]): Destination => studentMoves[studentId] ?? destOf(c);

  /**
   * Who the leavers step proposes: every child whose own resolved destination is "graduate".
   *
   * Derived rather than stored, so correcting a class on the previous step immediately changes who is
   * offered here — a list that went stale would be a list that withdraws the wrong child.
   */
  const graduating = useMemo(() => {
    const out: { id: string; fullName: string; from: string }[] = [];
    for (const c of d?.classes ?? []) {
      for (const s of c.students) if (destOfStudent(s.id, c).kind === 'graduate') out.push({ id: s.id, fullName: s.fullName, from: c.name });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- destOf* read `moves`/`studentMoves`, both listed
  }, [d?.classes, moves, studentMoves]);

  const movingCount = useMemo(() => {
    let n = 0;
    for (const c of d?.classes ?? []) for (const s of c.students) if (destOfStudent(s.id, c).kind === 'move') n++;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.classes, moves, studentMoves]);

  const withdrawIds = Object.entries(leaving).filter(([, on]) => on).map(([id]) => id);
  const changedPlans = Object.entries(amounts)
    .map(([id, v]) => ({ id, cents: parseCents(v) }))
    .filter((p): p is { id: string; cents: number } => p.cents !== null && p.cents >= 0);

  const at = STEPS.indexOf(step);
  const go = (n: 1 | -1) => {
    setErr(null);
    setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, at + n))]);
  };

  async function apply() {
    setErr(null);
    try {
      const r = await commit.mutateAsync({
        year: { label: yearEff.label.trim(), startYear: Number(yearEff.startYear), startMonth: Number(yearEff.startMonth), endMonth: Number(yearEff.endMonth), schoolId },
        classMoves: Object.fromEntries((d?.classes ?? []).map((c) => [c.id, destOf(c)])),
        studentMoves,
        withdraw: withdrawIds,
        planAmounts: Object.fromEntries(changedPlans.map((p) => [p.id, p.cents])),
        termsToCreate: withTerms ? (d?.termNames ?? []) : [],
      });
      setDone(r);
      // Everything on screen is downstream of the year, the roster or the fees.
      await Promise.all([
        utils.structure.schoolYearList.invalidate(),
        utils.structure.courseTree.invalidate(),
        utils.structure.studentsByClass.invalidate(),
        utils.people.directory.invalidate(),
        utils.billing.yearGrid.invalidate(),
        utils.billing.feePlanList.invalidate(),
        utils.billing.invoiceLabelConfig.invalidate(),
        utils.billing.billFromMonths.invalidate(),
      ]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (plan.isLoading) return <p className="empty">{t('common.loading')}</p>;
  if (!d) return <p className="empty">{t('rollover.noData')}</p>;

  if (done) {
    return (
      <motion.div variants={fadeRise} initial="initial" animate="animate">
        <div className="notice" style={{ marginBlockEnd: '0.75rem' }}>{t('rollover.doneTitle', { label: yearEff.label })}</div>
        <ul className="plain">
          <li>{t('rollover.doneMoved', { count: done.moved })}</li>
          <li>{t('rollover.doneGraduated', { count: done.graduated })}</li>
          <li>{t('rollover.doneWithdrawn', { count: done.withdrawn })}</li>
          <li>{t('rollover.donePlans', { count: done.plansChanged })}</li>
          <li>{t('rollover.doneTerms', { count: done.termsCreated })}</li>
        </ul>
        <p className="hint">{t('rollover.doneOwing')}</p>
        {onDone && <button type="button" className="btn btn--primary" onClick={onDone} style={{ marginBlockStart: '0.75rem' }}>{t('common.close')}</button>}
      </motion.div>
    );
  }

  return (
    <motion.div variants={fadeRise} initial="initial" animate="animate">
      <ol className="setup-steps" aria-label={t('rollover.title')}>
        {STEPS.map((s, i) => (
          <li key={s} className={i === at ? 'is-now' : i < at ? 'is-done' : ''}>
            <span className="n">{i < at ? <Check size={13} /> : i + 1}</span>
            {t(`rollover.step_${s}`)}
          </li>
        ))}
      </ol>

      {err && <div className="notice notice--warn" style={{ marginBlockEnd: '0.75rem' }}>{err}</div>}

      {step === 'classes' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('rollover.classesTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('rollover.classesHint')}</p>

          {/* The year being opened. Pre-filled a year on from the one closing, and editable — a madrasah
              that renames its years ("1448–49") should not have to fight the guess. */}
          <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
            <div className="field" style={{ flex: '2 1 12rem' }}>
              <label className="label" htmlFor="ro-label">{t('rollover.newYearLabel')}</label>
              <input id="ro-label" className="input glass-inset" value={yearEff.label} onChange={(e) => setYear({ ...yearEff, label: e.target.value })} maxLength={120} />
              {d.closing && <span className="hint">{t('rollover.closing', { label: d.closing.label })}</span>}
            </div>
            <div className="field" style={{ flex: '0 1 8rem' }}>
              <label className="label" htmlFor="ro-start">{t('rollover.startsIn')}</label>
              <select id="ro-start" className="input glass-inset" value={yearEff.startMonth} onChange={(e) => setYear({ ...yearEff, startMonth: e.target.value })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 8rem' }}>
              <label className="label" htmlFor="ro-end">{t('rollover.endsIn')}</label>
              <select id="ro-end" className="input glass-inset" value={yearEff.endMonth} onChange={(e) => setYear({ ...yearEff, endMonth: e.target.value })}>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{monthName(i + 1)}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 7rem' }}>
              <label className="label" htmlFor="ro-year">{t('rollover.startYear')}</label>
              <input id="ro-year" className="input glass-inset" type="number" value={yearEff.startYear} onChange={(e) => setYear({ ...yearEff, startYear: e.target.value })} />
            </div>
          </div>

          {d.classes.length === 0 ? (
            <p className="empty">{t('rollover.noClasses')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table stack-phone">
                <thead>
                  <tr>
                    <th>{t('rollover.colClass')}</th>
                    <th>{t('rollover.colCount')}</th>
                    <th>{t('rollover.colGoesTo')}</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {d.classes.map((c) => {
                    const dest = destOf(c);
                    const open = !!expanded[c.id];
                    return (
                      // The key belongs on the Fragment: React pairs list children by it, and a key on
                      // an inner row would make every class look like a new element on each render.
                      <Fragment key={c.id}>
                        <tr>
                          <td data-label={t('rollover.colClass')}>
                            <b>{c.name}</b>
                            <br />
                            <span className="hint">{c.courseName}</span>
                          </td>
                          <td data-label={t('rollover.colCount')}>{t('students.count', { count: c.studentCount })}</td>
                          <td data-label={t('rollover.colGoesTo')}>
                            <select
                              className="input glass-inset"
                              aria-label={t('rollover.goesToFor', { name: c.name })}
                              value={toValue(dest)}
                              onChange={(e) => setMoves({ ...moves, [c.id]: fromValue(e.target.value) })}
                            >
                              <option value="stay">{t('rollover.destStay', { name: c.name })}</option>
                              <option value="graduate">{t('rollover.destGraduate')}</option>
                              {d.allClasses.filter((k) => k.id !== c.id).map((k) => (
                                <option key={k.id} value={`move:${k.id}`}>{t('rollover.destMove', { name: k.name, course: k.courseName })}</option>
                              ))}
                            </select>
                          </td>
                          <td className="actions">
                            {c.students.length > 0 && (
                              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded({ ...expanded, [c.id]: !open })}>
                                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {t('rollover.perStudent')}
                              </button>
                            )}
                          </td>
                        </tr>
                        {/* One child at a time, for the ones repeating the year. */}
                        {open &&
                          c.students.map((s) => (
                            <tr key={`${c.id}:${s.id}`} className="line-row">
                              <td data-label={t('students.name')}>{s.fullName}</td>
                              <td />
                              <td data-label={t('rollover.colGoesTo')}>
                                <select
                                  className="input glass-inset"
                                  aria-label={t('rollover.goesToFor', { name: s.fullName })}
                                  value={toValue(destOfStudent(s.id, c))}
                                  onChange={(e) => setStudentMoves({ ...studentMoves, [s.id]: fromValue(e.target.value) })}
                                >
                                  <option value="stay">{t('rollover.destStay', { name: c.name })}</option>
                                  <option value="graduate">{t('rollover.destGraduate')}</option>
                                  {d.allClasses.filter((k) => k.id !== c.id).map((k) => (
                                    <option key={k.id} value={`move:${k.id}`}>{t('rollover.destMove', { name: k.name, course: k.courseName })}</option>
                                  ))}
                                </select>
                              </td>
                              <td />
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {step === 'leavers' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><GraduationCap size={16} /> {t('rollover.leaversTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('rollover.leaversHint')}</p>
          {graduating.length === 0 ? (
            <p className="empty">{t('rollover.noLeavers')}</p>
          ) : (
            <>
              {graduating.map((s) => (
                <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!leaving[s.id]} onChange={(e) => setLeaving({ ...leaving, [s.id]: e.target.checked })} />
                  <span>{s.fullName} <span className="hint">{t('rollover.leftFrom', { name: s.from })}</span></span>
                </label>
              ))}
              <div style={{ display: 'flex', gap: '0.5rem', marginBlockStart: '0.6rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLeaving(Object.fromEntries(graduating.map((s) => [s.id, true])))}>
                  {t('rollover.tickAll')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLeaving({})}>{t('rollover.tickNone')}</button>
              </div>
              <p className="hint" style={{ marginBlockStart: '0.6rem' }}>{t('rollover.leaversNote')}</p>
            </>
          )}
        </section>
      )}

      {step === 'fees' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('rollover.feesTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('rollover.feesHint')}</p>
          {d.plans.length === 0 ? (
            <p className="empty">{t('rollover.noPlans')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table stack-phone">
                <thead>
                  <tr>
                    <th>{t('rollover.colPlan')}</th>
                    <th>{t('rollover.colNow')}</th>
                    <th>{t('rollover.colNew')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.plans.map((p) => (
                    <tr key={p.id}>
                      <td data-label={t('rollover.colPlan')}>
                        {p.name}
                        <br />
                        <span className="hint">{t('rollover.planOn', { count: p.studentCount })}</span>
                      </td>
                      <td data-label={t('rollover.colNow')} className="tnum">{formatMoney(p.amountCents, currency)}</td>
                      <td data-label={t('rollover.colNew')}>
                        <input
                          className="input glass-inset"
                          inputMode="decimal"
                          placeholder={t('rollover.unchanged')}
                          aria-label={t('rollover.newAmountFor', { name: p.name })}
                          value={amounts[p.id] ?? ''}
                          onChange={(e) => setAmounts({ ...amounts, [p.id]: e.target.value })}
                          onBlur={(e) => {
                            // Two decimals on the way out, like every other money box in the app.
                            const c = parseCents(e.target.value);
                            if (c !== null) setAmounts({ ...amounts, [p.id]: (c / 100).toFixed(2) });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>{t('rollover.overridesKept')}</p>
        </section>
      )}

      {step === 'owing' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('rollover.owingTitle')}</h2></div>
          {d.owing.families === 0 ? (
            <p className="empty">{t('rollover.owingNone')}</p>
          ) : (
            <>
              <p style={{ marginBlockStart: 0 }}>
                {t('rollover.owingSummary', { count: d.owing.families, amount: formatMoney(d.owing.totalCents, currency) })}
              </p>
              <table className="data-table stack-phone">
                <thead><tr><th>{t('rollover.colFamily')}</th><th className="num">{t('rollover.colOwed')}</th></tr></thead>
                <tbody>
                  {d.owing.top.map((f) => (
                    <tr key={f.familyId}>
                      <td data-label={t('rollover.colFamily')}>{f.label}</td>
                      <td data-label={t('rollover.colOwed')} className="num tnum">{formatMoney(f.owedCents, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint" style={{ marginBlockStart: '0.6rem' }}>{t('rollover.owingNote')}</p>
            </>
          )}
        </section>
      )}

      {step === 'confirm' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('rollover.confirmTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('rollover.confirmHint')}</p>
          <ul className="plain">
            <li>{t('rollover.sumYear', { label: yearEff.label, from: monthName(Number(yearEff.startMonth)), to: monthName(Number(yearEff.endMonth)), year: yearEff.startYear })}</li>
            <li>{t('rollover.sumMoving', { count: movingCount })}</li>
            <li>{t('rollover.sumGraduating', { count: graduating.length })}</li>
            <li>{t('rollover.sumWithdrawing', { count: withdrawIds.length })}</li>
            <li>{t('rollover.sumPlans', { count: changedPlans.length })}</li>
            {d.termNames.length > 0 && (
              <li>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={withTerms} onChange={(e) => setWithTerms(e.target.checked)} />
                  {t('rollover.sumTerms', { count: d.termNames.length, names: d.termNames.map((x) => x.name).join(', ') })}
                </label>
              </li>
            )}
          </ul>
          <p className="hint">{t('rollover.confirmNote')}</p>
          <button
            type="button"
            className="btn btn--primary"
            style={{ marginBlockStart: '0.75rem', minHeight: '3rem', padding: '0.8rem 1.4rem' }}
            onClick={() => void apply()}
            disabled={commit.isPending || !yearEff.label.trim() || !Number(yearEff.startYear)}
          >
            {commit.isPending ? t('rollover.applying') : t('rollover.apply', { label: yearEff.label })}
          </button>
        </section>
      )}

      <div className="inline-form glass-inset" style={{ alignItems: 'center' }}>
        <button type="button" className="btn btn--ghost" onClick={() => go(-1)} disabled={at === 0}>{t('common.back')}</button>
        <span className="spacer" />
        <span className="hint">{t('firstRun.of', { n: at + 1, total: STEPS.length })}</span>
        {at < STEPS.length - 1 && <button type="button" className="btn btn--primary" onClick={() => go(1)}>{t('firstRun.next')}</button>}
      </div>
    </motion.div>
  );
}
