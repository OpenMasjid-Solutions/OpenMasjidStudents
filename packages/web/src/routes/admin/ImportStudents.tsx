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
import { trpc } from '../../lib/trpc';
import { autoMatchColumns, toCsv, downloadCsv } from '../../lib/csv';
import { parseSpreadsheet, XlsxError } from '../../lib/xlsx';
import { formatMoney } from '../../lib/money';
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
 */
type Step = 'pick' | 'map' | 'contacts' | 'preview' | 'siblings' | 'done';

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

export function ImportStudents() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
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
          <SiblingSuggestions onDone={() => setStep('done')} doneLabel={t('import.toIds')} />
        </>
      )}

      {/* ── Step 6: done — the generated Student IDs ────────────────────── */}
      {step === 'done' && commit.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('import.done')}</h2>
            <span className="spacer" />
            <button type="button" className="btn btn--ghost btn--sm no-print" onClick={() => setStep('siblings')}>{t('import.backToSiblings')}</button>
            <button type="button" className="btn btn--ghost btn--sm no-print" onClick={() => window.print()}>{t('import.print')}</button>
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
