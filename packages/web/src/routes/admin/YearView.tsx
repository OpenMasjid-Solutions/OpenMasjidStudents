// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The whole-year view: every student as a row, every billing month as a column, so the office can
 *  read a year of tuition at a glance and print it.
 *
 *  A cell is the FAMILY's invoice state for that month — that is what is billed and paid, so
 *  siblings on one bill show the same cell. Clicking a billed cell opens that family's record.
 *  The optional columns (Student ID, phones, balance…) are admin-configured and resolved server-side,
 *  so a column that is off never reaches the browser.
 *
 *  Phone-first: the grid scrolls horizontally with the name column pinned, which is the only
 *  treatment that keeps 12 months usable on a phone. */
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Settings2, Printer } from 'lucide-react';
import { cn } from '../../lib/cn';
import { trpc } from '../../lib/trpc';
import { formatMoney } from '../../lib/money';
import { formatUsPhone, telHref } from '../../lib/phone';
import { useWindows } from '../../components/Windows';
import { FamilyDetail } from './FamilyDetail';

const UNPLACED = '__unplaced';

/**
 * The contact columns, in the order an office would work down them: father, mother, anyone else on the
 * household, then the emergency number. Each is its own column with its own heading — a single "guardian
 * phones" cell full of commas could not tell you whose number you were about to ring.
 *
 * `other` catches guardians with no relation recorded, which is every guardian a CSV import created.
 * Without it their number would simply not appear on the page.
 */
const CONTACT_COLUMNS = ['fatherPhone', 'motherPhone', 'otherPhone', 'emergencyPhone', 'fatherEmail', 'motherEmail', 'otherEmail'] as const;

export function YearView({ canConfigure }: { canConfigure: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();

  const [yearId, setYearId] = useState<string>('');
  /** '' = All courses, which is where the screen starts. */
  const [courseFilter, setCourseFilter] = useState('');
  const years = trpc.structure.schoolYearList.useQuery();
  const grid = trpc.billing.yearGrid.useQuery({ schoolYearId: yearId || undefined });
  const cols = trpc.billing.yearViewColumnsGet.useQuery();
  const setCols = trpc.billing.yearViewColumnsSet.useMutation();

  const [showConfig, setShowConfig] = useState(false);

  const openFamily = (id: string, label: string) =>
    open({ title: label, wide: true, dedupeKey: `family:${id}`, icon: <Users size={15} />, node: <FamilyDetail familyId={id} /> });

  async function refresh() {
    await Promise.all([utils.billing.yearGrid.invalidate(), utils.structure.schoolYearList.invalidate(), utils.billing.yearViewColumnsGet.invalidate()]);
  }

  async function toggleColumn(key: string, on: boolean) {
    const next = on ? [...(cols.data?.enabled ?? []), key] : (cols.data?.enabled ?? []).filter((c) => c !== key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the server re-validates against its own allow-list
    await setCols.mutateAsync({ columns: next as any });
    await refresh();
  }

  const g = grid.data;
  const enabled = cols.data?.enabled ?? [];

  /** Course filter buttons, counted off the grid itself so a course with nobody in this year is not
   *  offered as an empty filter. */
  const courseButtons = useMemo(() => {
    const rows = g?.rows ?? [];
    const seen = new Map<string, { id: string; label: string; count: number }>();
    for (const r of rows) {
      const id = r.courseId ?? UNPLACED;
      if (!seen.has(id)) seen.set(id, { id, label: r.courseName ?? t('students.unplaced'), count: 0 });
      seen.get(id)!.count++;
    }
    // Unplaced last, so a real course is never buried under it.
    return [...seen.values()].sort((a, b) => (a.id === UNPLACED ? 1 : b.id === UNPLACED ? -1 : 0));
  }, [g?.rows, t]);

  const rows = useMemo(
    () => (g?.rows ?? []).filter((r) => !courseFilter || (r.courseId ?? UNPLACED) === courseFilter),
    [g?.rows, courseFilter],
  );

  return (
    <div className="page">
      <div className="admin-header no-print">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('year.title')}</h1>
        {years.data && years.data.length > 0 && (
          <select
            className="input glass-inset"
            style={{ width: 'auto', minWidth: '14rem' }}
            value={yearId || (g?.year?.id ?? '')}
            onChange={(e) => setYearId(e.target.value)}
            aria-label={t('year.schoolYear')}
          >
            {years.data.map((y) => (
              <option key={y.id} value={y.id}>{y.label}{y.isCurrent ? ` — ${t('year.current')}` : ''}</option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {g && g.rows.length > 0 && (
          <button type="button" className="btn btn--ghost" onClick={() => window.print()}>
            <Printer size={15} /> {t('year.print')}
          </button>
        )}
        {canConfigure && (
          <button type="button" className="btn btn--ghost" onClick={() => setShowConfig((v) => !v)}>
            <Settings2 size={15} /> {t('year.configure')}
          </button>
        )}
      </div>

      {/* ── Configure: which optional columns show. The school year itself is configured on the
             Structure tab — one place for it, and that tab can also edit an existing year. ───── */}
      {canConfigure && showConfig && (
        <section className="section glass no-print" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('year.configure')}</h2></div>

          <div className="field">
            <label className="label">{t('year.columns')}</label>
            <div className="chip-row">
              {(cols.data?.available ?? []).map((c) => {
                const on = enabled.includes(c);
                return (
                  <label key={c} className={`chip ${on ? '' : 'is-muted'}`} style={{ cursor: 'pointer', display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
                    <input type="checkbox" checked={on} onChange={(e) => void toggleColumn(c, e.target.checked)} />
                    {t(`year.col_${c}`)}
                  </label>
                );
              })}
            </div>
            <p className="hint">{t('year.columnsWarning')}</p>
          </div>
        </section>
      )}

      {/* ── The grid ──────────────────────────────────────────────────────────── */}
      {grid.isLoading ? (
        <p className="empty">{t('common.loading')}</p>
      ) : !g?.year ? (
        <p className="empty">{t('year.noYear')}</p>
      ) : g.needsStartYear ? (
        <p className="empty">{t('year.needsStartYear', { label: g.year.label })}</p>
      ) : g.rows.length === 0 ? (
        <p className="empty">{t('year.noStudents')}</p>
      ) : (
        <section className="section glass print-area" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{g.year.label}</h2>
            <span className="chip is-muted">{t('students.count', { count: rows.length })}</span>
          </div>

          {/* Course filter — "All" first and selected by default. Hidden when printing: a printed
              sheet should show what is on screen, not the controls that chose it. */}
          {courseButtons.length > 1 && (
            <div className="filter-bar no-print" role="group" aria-label={t('students.filterByCourse')}>
              <button type="button" className={cn('btn btn--ghost btn--sm', courseFilter === '' && 'is-active')} aria-pressed={courseFilter === ''} onClick={() => setCourseFilter('')}>
                {t('students.allCourses')}
              </button>
              {courseButtons.map((c) => (
                <button key={c.id} type="button" className={cn('btn btn--ghost btn--sm', courseFilter === c.id && 'is-active')} aria-pressed={courseFilter === c.id} onClick={() => setCourseFilter(c.id)}>
                  {c.label} <span className="chip is-muted">{c.count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="year-scroll">
            <table className="data-table year-grid">
              <thead>
                <tr>
                  <th className="year-sticky">{t('students.name')}</th>
                  <th>{t('year.paying')}</th>
                  {g.months.map((m) => <th key={m.periodKey} className="year-month">{m.label}</th>)}
                  {enabled.includes('studentId') && <th>{t('year.col_studentId')}</th>}
                  {enabled.includes('dob') && <th>{t('year.col_dob')}</th>}
                  {enabled.includes('balance') && <th>{t('year.col_balance')}</th>}
                  {enabled.includes('guardianNames') && <th>{t('year.col_guardianNames')}</th>}
                  {/* One labelled column per number, in the order an office would ring them. */}
                  {CONTACT_COLUMNS.filter((c) => enabled.includes(c)).map((c) => (
                    <th key={c}>{t(`year.col_${c}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  // Two levels of heading, in the order the office thinks: the course, then the
                  // classes inside it. Rows arrive already sorted by course → class → name, so a
                  // change of value IS a new group.
                  const prev = rows[i - 1];
                  const newCourse = !prev || (prev.courseId ?? UNPLACED) !== (r.courseId ?? UNPLACED);
                  const newClass = newCourse || prev.classId !== r.classId;
                  const span = 2 + g.months.length + enabled.length;
                  return (
                    <Fragment key={r.studentId}>
                      {newCourse && (
                        <tr className="year-group">
                          <td className="year-sticky" colSpan={span}>{r.courseName ?? t('students.unplaced')}</td>
                        </tr>
                      )}
                      {newClass && (
                        <tr className="year-group year-group--class">
                          <td className="year-sticky" colSpan={span}>{r.className ?? t('students.unplaced')}</td>
                        </tr>
                      )}
                      <tr>
                        <td className="year-sticky">
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openFamily(r.familyId, r.familyName)}>
                            {r.fullName}
                          </button>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span className="tnum">{formatMoney(r.monthlyAmountCents, g.currency)}</span>
                          {r.feeNote && <span className="chip is-muted" style={{ marginInlineStart: '0.35rem' }}>{r.feeNote}</span>}
                        </td>
                        {r.cells.map((c) => (
                          <td key={c.periodKey} className={`year-cell is-${c.status}`}>
                            {c.status === 'none' ? (
                              ''
                            ) : (
                              <button
                                type="button"
                                className="year-cell-btn"
                                onClick={() => openFamily(r.familyId, r.familyName)}
                                title={`${c.periodKey} — ${t(`year.cell_${c.status}`)}`}
                                aria-label={`${r.fullName} ${c.periodKey} ${t(`year.cell_${c.status}`)}`}
                              >
                                {c.status === 'paid' ? '✓' : c.status === 'partial' ? '½' : c.status === 'void' ? '—' : '·'}
                              </button>
                            )}
                          </td>
                        ))}
                        {enabled.includes('studentId') && <td><span className="code">{r.extra.studentCode ?? ''}</span></td>}
                        {enabled.includes('dob') && <td>{r.extra.dob ?? ''}</td>}
                        {enabled.includes('balance') && <td className="tnum">{formatMoney(r.extra.balanceCents ?? 0, g.currency)}</td>}
                        {enabled.includes('guardianNames') && <td>{(r.extra.guardianNames ?? []).join(', ')}</td>}
                        {/* Tappable numbers and addresses. Formatted for display (lib/phone.ts leaves
                            non-US numbers alone) but the href is built from the digits — see telHref.
                            On a phone this page becomes the office's call list, which is the point. */}
                        {CONTACT_COLUMNS.filter((c) => enabled.includes(c)).map((c) => (
                          <td key={c} className={c.endsWith('Phone') ? 'year-contact' : undefined}>
                            {(r.extra[c] ?? []).map((v, n) => (
                              <Fragment key={v}>
                                {n > 0 && <br />}
                                {c.endsWith('Phone') ? (
                                  <a href={`tel:${telHref(v)}`} className="contact-link">{formatUsPhone(v)}</a>
                                ) : (
                                  <a href={`mailto:${v}`} className="contact-link">{v}</a>
                                )}
                              </Fragment>
                            ))}
                          </td>
                        ))}
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="hint no-print">{t('year.legend')}</p>
        </section>
      )}
    </div>
  );
}
