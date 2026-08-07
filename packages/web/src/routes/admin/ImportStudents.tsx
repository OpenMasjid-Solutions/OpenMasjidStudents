// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Student import: pick a file → confirm the column mapping (auto-matched first) → say where any
 *  unrecognised relationships go → review the resolved rows and their problems → commit.
 *
 *  The mapping step is always shown even when every column auto-matched, because a silently wrong
 *  guess here creates real students with real fees. The commit is all-or-nothing server-side, so a
 *  file with any error cannot half-import. */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { withBase } from '../../lib/base';
import { autoMatchColumns, toCsv, downloadCsv } from '../../lib/csv';
import { parseSpreadsheet, XlsxError } from '../../lib/xlsx';
import { formatMoney } from '../../lib/money';
import { useSchool } from '../../components/SchoolTabs';
import { SiblingSuggestions } from '../../components/SiblingSuggestions';

/**
 * `siblings` sits between the commit and the finished roster on purpose.
 *
 * The import cannot work out households itself — that is a deliberate refusal, since a wrong guess
 * merges two families' money. But leaving it there means 120 children in 120 households, and a parent
 * with four separate balances. So the moment the rows land, while the names are still on screen, the
 * office is shown the likely families and confirms them. Skippable, and reachable later from Students.
 *
 * `contacts` is skipped entirely unless the file names a relationship we cannot place (0.48.0) — a
 * file of fathers and mothers should not stop to ask a question with one obvious answer.
 *
 * `fees` follows siblings, and follows it for a reason (0.48.0). Every imported row gets the SAME plan,
 * because a spreadsheet column cannot say "the second child pays less" — but the discounts a madrasah
 * actually gives are per household, so the moment to correct them is once the siblings are grouped and
 * you can see who is whose brother. Skippable, and reachable afterwards from any child's record.
 */
type Step = 'pick' | 'map' | 'contacts' | 'preview' | 'siblings' | 'fees' | 'done';

type Placement = 'guardian' | 'emergency';

/** Matches the server's own cap. Said here rather than letting a 5,000-row file come back as an
 *  opaque validation failure after the upload. */
const MAX_ROWS = 2000;

/** The lines of the file a student came from, as the office sees them: 1-based, header first. A range
 *  when nameless rows were folded in, which is how the merge is shown rather than asserted. */
function fileLines(sourceRows: number[]): string {
  const first = sourceRows[0] + 2;
  const last = sourceRows[sourceRows.length - 1] + 2;
  return first === last ? String(first) : `${first}–${last}`;
}

/**
 * The fee step: every imported child, their plan, and what they will actually be billed.
 *
 * Both halves are editable because both are wrong for somebody. The PLAN is wrong when a madrasah runs
 * more than one (a full-time rate and a weekend rate) and the file had no column for it; the AMOUNT is
 * wrong wherever the office agreed something — a sibling rate, a hardship reduction — which is per
 * household and cannot live in a spreadsheet column at all. Since 0.39.0 that reduction IS the
 * per-student override (the family discount went with per-child invoices), so this screen is where a
 * roster becomes what the office actually charges.
 *
 * Saved PER ROW rather than as one big submit: 36 children is a long screen, and an office that
 * corrects three of them should not have to wonder whether the other 33 were rewritten. Which makes the
 * per-row FEEDBACK load-bearing — see `dirty` below.
 */
function ImportFees({ studentIds, onDone }: { studentIds: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const fees = trpc.billing.studentFeeList.useQuery({ studentIds });
  const plans = trpc.billing.feePlanList.useQuery();
  const setFee = trpc.billing.setStudentFee.useMutation();
  /** Only the rows the office has actually touched, so an untouched row is never written. A row's draft
   *  is DELETED once it saves, which is what makes the Save button disappear and the tick appear. */
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');

  /** Type-as-you-go name filter. A 200-child import is a very long table, and the office arrives at it
   *  wanting three particular families. Filtering only what is SHOWN — a hidden row's draft is still
   *  saved, and the unsaved count below still counts it, so a search cannot lose an edit. */
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const all = fees.data ?? [];
  const rows = needle ? all.filter((r) => r.fullName.toLowerCase().includes(needle)) : all;
  const planById = new Map((plans.data ?? []).map((p) => [p.id, p]));
  const unsaved = Object.keys(draft).length;
  /** Anything touched at all — a saved change or one still pending. The way out says "Next" rather than
   *  "Skip" once that is true: an office that has just edited three fees has not skipped this step. */
  const touched = unsaved > 0 || Object.keys(saved).length > 0;

  async function save(studentId: string, fallbackPlanId: string | null) {
    const d = draft[studentId];
    if (!d) return;
    const planId = d.feePlanId || fallbackPlanId;
    if (!planId) return;
    const plan = planById.get(planId);
    const cents = parseAmount(d.amount);
    if (cents === 'bad') {
      setErr(t('import.feeBadAmount'));
      return;
    }
    setErr('');
    // Matching the plan's own price is NOT an override — storing one would freeze this child at today's
    // figure, so a later change to the plan would silently skip them. The note explains an override, so
    // it goes with it.
    const override = cents == null || (plan && cents === plan.amountCents) ? null : cents;
    await setFee.mutateAsync({ studentId, feePlanId: planId, overrideAmountCents: override, note: override == null ? '' : d.note.trim() });
    // Refetch BEFORE dropping the draft, so the row never flashes its old figures in the gap between the
    // two. Then the draft goes, `dirty` turns false, and the row shows a tick instead of a button.
    await Promise.all([utils.billing.studentFeeList.invalidate({ studentIds }), utils.people.directory.invalidate(), utils.billing.yearGrid.invalidate()]);
    setDraft((s) => {
      const next = { ...s };
      delete next[studentId];
      return next;
    });
    setSaved((s) => ({ ...s, [studentId]: true }));
  }

  return (
    <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
      <div className="section-head">
        <h2>{t('import.feesTitle')}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn--primary btn--sm" onClick={onDone}>
          {touched ? t('import.feesNext') : t('import.toIds')}
        </button>
      </div>
      <p className="hint" style={{ marginBlockStart: 0 }}>{t('import.feesIntro')}</p>
      {err && <p className="form-error">{err}</p>}
      {setFee.error && <p className="form-error">{setFee.error.message}</p>}
      {/* Said plainly rather than left for somebody to discover: leaving now loses these. */}
      {unsaved > 0 && <p className="form-error">{t('import.feesUnsaved', { count: unsaved })}</p>}
      <div className="field" style={{ marginBlockEnd: '0.6rem' }}>
        <input
          className="input glass-inset"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('import.feeSearch')}
          aria-label={t('import.feeSearch')}
        />
        {needle && <p className="hint">{t('import.feeSearchCount', { shown: rows.length, total: all.length })}</p>}
      </div>
      <div style={{ overflowX: 'auto', maxHeight: '24rem' }}>
        <table className="data-table stack-phone">
          <thead>
            <tr>
              <th>{t('students.name')}</th>
              <th>{t('directory.feePlan')}</th>
              <th>{t('import.feeAmount')}</th>
              <th>{t('import.feeNote')}</th>
              <th className="actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = draft[r.studentId];
              const planId = d?.feePlanId ?? r.feePlanId ?? '';
              const amount = d?.amount ?? (r.effectiveAmountCents != null ? money2(r.effectiveAmountCents) : '');
              const note = d?.note ?? r.note ?? '';
              const dirty = !!d;
              const plan = planById.get(planId);
              const cents = parseAmount(amount);
              /** An override is in force when the amount differs from the plan's own price — which is
               *  the only thing a note has to explain, so the field appears with it and not otherwise. */
              const overridden = cents !== 'bad' && cents != null && !!plan && cents !== plan.amountCents;
              // First edit seeds the draft from what is on screen; later ones patch the draft.
              const set = (patch: Partial<Draft>) =>
                setDraft((s) => ({ ...s, [r.studentId]: { ...(s[r.studentId] ?? { feePlanId: planId, amount, note }), ...patch } }));
              return (
                <tr key={r.studentId}>
                  {/* data-label is what lets each cell name itself once the row stacks into a card on a
                      phone (see .stack-phone in admin.css). Desktop ignores it entirely. */}
                  <td className="row-title">{r.fullName}</td>
                  <td data-label={t('directory.feePlan')}>
                    <select
                      className="input glass-inset"
                      style={{ width: 'auto', minWidth: '10rem', padding: '0.25rem 0.4rem' }}
                      value={planId}
                      aria-label={`${r.fullName} ${t('directory.feePlan')}`}
                      onChange={(e) => {
                        // Switching plan re-fills the amount from the NEW plan's price, so the box shows
                        // what will be billed rather than the old plan's figure sitting there as a
                        // now-meaningless override. A note about the old amount goes with it.
                        const p = planById.get(e.target.value);
                        set({ feePlanId: e.target.value, amount: p ? money2(p.amountCents) : '', note: '' });
                      }}
                    >
                      {/* A child with no fee at all cannot happen through the import (a plan is
                          required), but the query left-joins so it is representable — and without an
                          option to match, the select would show a plan this child does not have and
                          Save would quietly do nothing. */}
                      {!planId && <option value="">{t('import.feeNoPlan')}</option>}
                      {(plans.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>{p.name} — {formatMoney(p.amountCents)}</option>
                      ))}
                    </select>
                  </td>
                  <td data-label={t('import.feeAmount')}>
                    <input
                      className="input glass-inset"
                      style={{ width: '7rem', padding: '0.25rem 0.4rem' }}
                      inputMode="decimal"
                      value={amount}
                      aria-label={`${r.fullName} ${t('import.feeAmount')}`}
                      onChange={(e) => set({ amount: e.target.value })}
                      onBlur={(e) => {
                        // Typing "100" and leaving it reading `100` beside every other figure written
                        // `100.00` looks like a different kind of number. Tidied on the way OUT, never
                        // while typing — reformatting under the cursor fights the person doing it.
                        const c = parseAmount(e.target.value);
                        if (c !== 'bad' && c != null) set({ amount: money2(c) });
                      }}
                    />
                  </td>
                  <td data-label={t('import.feeNote')}>
                    {overridden ? (
                      <input
                        className="input glass-inset"
                        style={{ minWidth: '9rem', padding: '0.25rem 0.4rem' }}
                        value={note}
                        maxLength={200}
                        placeholder={t('billing.overrideNoteHint')}
                        aria-label={`${r.fullName} ${t('import.feeNote')}`}
                        onChange={(e) => set({ note: e.target.value })}
                      />
                    ) : (
                      <span className="muted" style={{ fontSize: '0.85rem' }}>—</span>
                    )}
                  </td>
                  <td className="actions">
                    {/* The whole point of clearing the draft above: a Save button that stays put after a
                        successful save reads as a button that did nothing. */}
                    {dirty ? (
                      <button type="button" className="btn btn--primary btn--sm" onClick={() => void save(r.studentId, r.feePlanId)} disabled={setFee.isPending}>
                        {t('common.save')}
                      </button>
                    ) : saved[r.studentId] ? (
                      <span className="chip"><Check size={12} /> {t('import.feeSaved')}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">{t('import.feesLater')}</p>
    </section>
  );
}

type Draft = { feePlanId: string; amount: string; note: string };

/** Cents as an office writes money: always two decimal places, so a typed "100" does not sit in a
 *  column of "100.00" looking like a different kind of number. */
const money2 = (cents: number): string => (cents / 100).toFixed(2);

/** "350", "350.00", "$350" → cents. `null` = blank (use the plan's own price), `'bad'` = not a number.
 *  Deliberately the same shapes the import's Amount column accepts (people/import.ts). */
function parseAmount(v: string): number | null | 'bad' {
  const s = v.replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 'bad';
  return Math.round(parseFloat(s) * 100);
}

export function ImportStudents() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  // Which school the roster lands in, and which school's ID sheet the Print link opens. '' / undefined
  // means the switcher is on "all" — which is what a single-school install always is, and where the
  // server applies its own scope. Passed to BOTH preview and commit so they cannot disagree: a preview
  // that checked class names against one school while the commit wrote them into another would report
  // a clean file and then import it wrong.
  const { schoolId, arg: schoolArg } = useSchool();
  const fields = trpc.people.importTemplate.useQuery();
  const plans = trpc.billing.feePlanList.useQuery();
  const preview = trpc.people.importPreview.useMutation();
  const commit = trpc.people.importCommit.useMutation();

  const [step, setStep] = useState<Step>('pick');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [cells, setCells] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [defaultFeePlanId, setDefaultFeePlanId] = useState('');
  /** Where each unrecognised relationship goes, keyed by the lowercased label the file used. */
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const [parseError, setParseError] = useState('');

  /** Turn the parsed grid into the row objects the server validates. */
  const rows = useMemo(() => {
    if (!fields.data) return [];
    return cells.map((r) => {
      const o: Record<string, string> = {};
      for (const f of fields.data) {
        const i = mapping[f.key];
        if (i !== undefined && i >= 0) o[f.key] = r[i] ?? '';
      }
      return o;
    });
  }, [cells, mapping, fields.data]);

  function downloadTemplate() {
    if (!fields.data) return;
    // Header-only file: the labels are exactly what the auto-matcher recognises.
    downloadCsv('students-template.csv', toCsv(fields.data.map((f) => f.label), []));
  }

  async function onFile(file: File) {
    setParseError('');
    setPlacements({});
    try {
      // Reads a workbook or a CSV, decided by the file's BYTES — see lib/xlsx.ts.
      const parsed = await parseSpreadsheet(file);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setParseError(t('import.emptyFile'));
        return;
      }
      if (parsed.rows.length > MAX_ROWS) {
        setParseError(t('import.tooManyRows', { count: parsed.rows.length, max: MAX_ROWS }));
        return;
      }
      setFileName(file.name);
      setHeaders(parsed.headers);
      setCells(parsed.rows);
      setMapping(autoMatchColumns(parsed.headers, (fields.data ?? []).map((f) => ({ key: f.key, label: f.label, aliases: f.aliases }))));
      setStep('map');
    } catch (e) {
      // One friendly sentence about the file itself; anything unexpected falls back to "no rows".
      setParseError(e instanceof XlsxError ? t(`import.file.${e.code}`, { defaultValue: t('import.emptyFile') }) : t('import.emptyFile'));
    }
  }

  const requiredUnmapped = (fields.data ?? []).filter((f) => f.required && (mapping[f.key] ?? -1) < 0);
  const matchedCount = Object.values(mapping).filter((i) => i >= 0).length;
  // Columns in the file that no field claims — most often an "ID" column, which this app always
  // generates itself. Say so instead of dropping them silently.
  const ignoredColumns = headers.filter((h, i) => h !== '' && !Object.values(mapping).includes(i));

  /** Validate server-side, then either stop to ask where the odd relationships go, or show the review. */
  async function runPreview(chosen: Record<string, Placement>) {
    const res = await preview.mutateAsync({
      rows,
      defaultFeePlanId: defaultFeePlanId || undefined,
      schoolId: schoolArg,
      placements: Object.keys(chosen).length ? chosen : undefined,
    });
    const unanswered = res.askRelations.filter((r) => !(r.key in chosen));
    if (unanswered.length > 0) {
      // Guardian is the pre-selected answer: these people came out of a guardian column, so it is
      // the answer that loses nothing if the office simply presses on.
      setPlacements({ ...chosen, ...Object.fromEntries(unanswered.map((r) => [r.key, 'guardian' as const])) });
      setStep('contacts');
      return;
    }
    setStep('preview');
  }

  async function runCommit() {
    await commit.mutateAsync({
      rows,
      defaultFeePlanId: defaultFeePlanId || undefined,
      schoolId: schoolArg,
      placements: Object.keys(placements).length ? placements : undefined,
    });
    await Promise.all([
      utils.structure.studentsByClass.invalidate(),
      utils.structure.courseTree.invalidate(),
      utils.people.directory.invalidate(),
      utils.people.studentOptions.invalidate(),
      // The suggestions are computed from what was just written, so they must not come from cache.
      utils.people.siblingSuggestions.invalidate(),
    ]);
    setStep('siblings');
  }

  return (
    <div style={{ padding: '0.25rem 0.1rem', display: 'grid', gap: '0.9rem' }}>
      {/* ── Step 1: pick a file ─────────────────────────────────────────── */}
      {step === 'pick' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('import.title')}</h2></div>
          <p className="hint">{t('import.intro')}</p>
          <div className="field">
            <label className="label" htmlFor="csv-file">{t('import.pickFile')}</label>
            <input
              id="csv-file"
              className="input glass-inset"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
            />
            <p className="hint">{t('import.pickFileHint')}</p>
          </div>
          {parseError && <p className="form-error">{parseError}</p>}
          <button type="button" className="btn btn--ghost btn--sm" onClick={downloadTemplate} disabled={!fields.data}>
            {t('import.downloadTemplate')}
          </button>
        </section>
      )}

      {/* ── Step 2: confirm the column mapping ──────────────────────────── */}
      {step === 'map' && fields.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('import.matchColumns')}</h2>
            <span className="chip is-muted">{t('import.matched', { count: matchedCount, total: fields.data.length })}</span>
          </div>
          <p className="hint">{t('import.matchHint', { file: fileName, rows: cells.length })}</p>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>{t('import.field')}</th><th>{t('import.column')}</th><th>{t('import.sample')}</th></tr></thead>
              <tbody>
                {fields.data.map((f) => {
                  const idx = mapping[f.key] ?? -1;
                  return (
                    <tr key={f.key}>
                      <td>
                        {f.label}
                        {f.required && <span className="chip" style={{ marginInlineStart: '0.4rem' }}>{t('import.required')}</span>}
                      </td>
                      <td>
                        <select
                          className="input glass-inset"
                          style={{ width: 'auto', minWidth: '11rem', padding: '0.25rem 0.4rem' }}
                          value={String(idx)}
                          onChange={(e) => setMapping({ ...mapping, [f.key]: Number(e.target.value) })}
                          aria-label={`${f.label} ${t('import.column')}`}
                        >
                          <option value="-1">{t('import.notMatched')}</option>
                          {headers.map((h, i) => (
                            <option key={i} value={String(i)}>{h || `#${i + 1}`}</option>
                          ))}
                        </select>
                      </td>
                      <td className="muted" style={{ fontSize: '0.85rem' }}>{idx >= 0 ? (cells[0]?.[idx] ?? '') : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="field">
            <label className="label" htmlFor="default-plan">{t('import.defaultPlan')}</label>
            <select id="default-plan" className="input glass-inset" value={defaultFeePlanId} onChange={(e) => setDefaultFeePlanId(e.target.value)}>
              <option value="">{t('import.noDefaultPlan')}</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {formatMoney(p.amountCents)}</option>
              ))}
            </select>
            <p className="hint">{t('import.defaultPlanHint')}</p>
          </div>

          {ignoredColumns.length > 0 && <p className="hint">{t('import.ignoredColumns', { names: ignoredColumns.join(', ') })}</p>}
          <p className="hint">{t('import.idsGenerated')}</p>
          {/* Said before the review, because it explains why 40 rows can come back as 25 students. */}
          <p className="hint">{t('import.extraRowsHint')}</p>

          {requiredUnmapped.length > 0 && (
            <p className="form-error">{t('import.missingRequired', { fields: requiredUnmapped.map((f) => f.label).join(', ') })}</p>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn--ghost" onClick={() => setStep('pick')}>{t('common.back')}</button>
            <button type="button" className="btn btn--primary" onClick={() => void runPreview(placements)} disabled={requiredUnmapped.length > 0 || preview.isPending}>
              {t('import.checkRows')}
            </button>
          </div>
          {preview.error && <p className="form-error">{preview.error.message}</p>}
        </section>
      )}

      {/* ── Step 3: where do the unrecognised relationships go? ─────────── */}
      {step === 'contacts' && preview.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('import.placeContacts')}</h2></div>
          <p className="hint">{t('import.placeContactsIntro')}</p>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('import.relationship')}</th>
                  <th>{t('import.people')}</th>
                  <th>{t('import.asGuardian')}</th>
                  <th>{t('import.asEmergency')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.data.askRelations.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="muted">{t('import.peopleCount', { count: r.count })}</td>
                    {(['guardian', 'emergency'] as const).map((p) => (
                      <td key={p}>
                        <input
                          type="radio"
                          name={`place-${r.key}`}
                          checked={(placements[r.key] ?? 'guardian') === p}
                          value={p}
                          aria-label={`${r.label} — ${t(p === 'guardian' ? 'import.asGuardian' : 'import.asEmergency')}`}
                          onChange={() => setPlacements({ ...placements, [r.key]: p })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">{t('import.asGuardianHint')}</p>
          <p className="hint">{t('import.asEmergencyHint')}</p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn--ghost" onClick={() => setStep('map')}>{t('common.back')}</button>
            <button type="button" className="btn btn--primary" onClick={() => void runPreview(placements)} disabled={preview.isPending}>
              {t('import.checkRows')}
            </button>
          </div>
        </section>
      )}

      {/* ── Step 4: preview + problems ──────────────────────────────────── */}
      {step === 'preview' && preview.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('import.preview')}</h2>
            <span className="chip">{t('import.rowsOk', { count: preview.data.okCount })}</span>
            {preview.data.errorCount > 0 && (
              <span className="chip" style={{ color: 'var(--color-danger)' }}>{t('import.rowsError', { count: preview.data.errorCount })}</span>
            )}
          </div>

          {/* Said before they commit, not after: an import gives every row its own household, so
              siblings look unrelated until someone links them. */}
          <p className="hint">{t('import.siblingsNote')}</p>
          {preview.data.mergedCount > 0 && <p className="hint">{t('import.mergedNote', { count: preview.data.mergedCount })}</p>}

          <div style={{ overflowX: 'auto', maxHeight: '22rem' }}>
            <table className="data-table">
              <thead><tr><th>{t('import.line')}</th><th>{t('students.name')}</th><th>{t('students.class')}</th><th>{t('directory.feePlan')}</th><th>{t('import.amount')}</th><th>{t('import.people')}</th><th>{t('import.problems')}</th></tr></thead>
              <tbody>
                {preview.data.rows.map((r) => (
                  <tr key={r.row}>
                    <td className="muted">{fileLines(r.sourceRows)}</td>
                    <td>{r.resolved ? r.resolved.fullName : '—'}</td>
                    <td>{r.resolved?.className ?? '—'}</td>
                    <td>{r.resolved?.feePlanName ?? (defaultFeePlanId ? t('import.usingDefault') : '—')}</td>
                    <td>{r.resolved?.amountCents != null ? formatMoney(r.resolved.amountCents) : '—'}</td>
                    <td>
                      {r.contacts.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div style={{ display: 'grid', gap: '0.15rem', fontSize: '0.85rem' }}>
                          {r.contacts.map((c, i) => (
                            <span key={i}>
                              {c.name || <span className="error-text">{t('import.contactNoName')}</span>}
                              {c.relation && <span className="muted"> · {c.relation}</span>}
                              {c.placement === 'emergency' && <span className="chip" style={{ marginInlineStart: '0.3rem' }}>{t('import.emergencyShort')}</span>}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={r.ok ? 'muted' : 'error-text'}>{r.ok ? '✓' : r.errors.join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn--ghost" onClick={() => setStep(preview.data.askRelations.length > 0 ? 'contacts' : 'map')}>{t('common.back')}</button>
            <button type="button" className="btn btn--primary" onClick={() => void runCommit()} disabled={preview.data.errorCount > 0 || commit.isPending}>
              {t('import.commit', { count: preview.data.okCount })}
            </button>
          </div>
          {preview.data.errorCount > 0 && <p className="hint">{t('import.fixFirst')}</p>}
          {commit.error && <p className="form-error">{commit.error.message}</p>}
        </section>
      )}

      {/* ── Step 5: siblings — the households the import deliberately did not guess ──── */}
      {step === 'siblings' && commit.data && (
        <>
          <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
            <div className="section-head">
              <h2>{t('import.imported')}</h2>
              <span className="chip">{t('import.summaryShort', { count: commit.data.created })}</span>
            </div>
            <p className="hint" style={{ marginBlockStart: 0 }}>{t('import.siblingsStepIntro')}</p>
          </section>
          <SiblingSuggestions onDone={() => setStep('fees')} doneLabel={t('import.toFees')} />
        </>
      )}

      {/* ── Step 6: fees — correct the ones the file could not express ──── */}
      {step === 'fees' && commit.data && <ImportFees studentIds={commit.data.students.map((s) => s.studentId)} onDone={() => setStep('done')} />}

      {/* ── Step 7: done — the generated Student IDs ────────────────────── */}
      {step === 'done' && commit.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('import.done')}</h2>
            <span className="spacer" />
            <button type="button" className="btn btn--ghost btn--sm no-print" onClick={() => setStep('fees')}>{t('import.backToFees')}</button>
            {/* A real document, not `window.print()` on this window. That printed the app — the page
                behind, the window chrome, the dock — and spread 39 children over five sheets. The sheet
                behind this link is built on the server with the masjid's letterhead, grouped by class,
                two children to a row (people/idSheet.ts). It lists the whole active roster rather than
                only this import's rows, which is both the more useful sheet and the reason it does not
                need 36 ids in a URL. */}
            <a className="btn btn--ghost btn--sm no-print" href={withBase(`/sheets/ids/${schoolId || 'all'}`)} target="_blank" rel="noopener noreferrer">
              {t('import.printIdSheet')}
            </a>
          </div>
          <p className="hint">
            {t('import.summary', { students: commit.data.created, guardians: commit.data.guardiansCreated })}
            {commit.data.contactsCreated > 0 && ` ${t('import.summaryContacts', { count: commit.data.contactsCreated })}`}
          </p>
          <p className="hint">{t('import.idsAssigned')}</p>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>{t('students.name')}</th><th>{t('directory.studentId')}</th></tr></thead>
              <tbody>
                {commit.data.students.map((s) => (
                  <tr key={s.studentId}>
                    <td>{s.fullName}</td>
                    <td><span className="code">{s.studentCode}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
