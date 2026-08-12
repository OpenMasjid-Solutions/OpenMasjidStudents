// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The whole-year view: every student as a row, every billing month as a column, so the office can
 *  read a year of tuition at a glance and print it.
 *
 *  A cell is that CHILD's own invoice state for the month — bills are per student since 0.39.0, so two
 *  siblings can legitimately differ in the same column. Pressing a name (or a month cell) opens that
 *  child's billing: their balance, their bills line by line, and the box to record a payment. This is
 *  the way into a family's money since 0.43.0, when the grid of household cards on the Billing tab went
 *  away — the name here tells you their course, class and paid months as well, which a card could not.
 *  The optional columns (Student ID, phones, balance…) are admin-configured and resolved server-side,
 *  so a column that is off never reaches the browser.
 *
 *  Phone-first: the grid scrolls horizontally with the name column pinned, which is the only
 *  treatment that keeps 12 months usable on a phone. */
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet, Settings2, Printer } from 'lucide-react';
import { cn } from '../../lib/cn';
import { trpc } from '../../lib/trpc';
import { formatMoney } from '../../lib/money';
import { formatDate, type DateFormat } from '../../lib/dates';
import { formatUsPhone, telHref } from '../../lib/phone';
import { useWindows } from '../../components/Windows';
import { SchoolTabs, useRequiredSchool } from '../../components/SchoolTabs';
import { FamilyBilling } from '../../components/FamilyBilling';

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

/** The minimum a row needs for grouping — kept structural so `classBlocks` is testable on its own. */
interface GroupableRow {
  courseId: string | null;
  courseName: string | null;
  classId: string | null;
  className: string | null;
}

/** One class, with the course heading when it is the first class of that course. */
export interface ClassBlock<R> {
  key: string;
  /** True on the first class of a course, which is where the course heading is printed. A separate flag
   *  from the name because a course can legitimately have NO name — the unplaced children — and testing
   *  the name for null would silently drop that heading. */
  startsCourse: boolean;
  courseName: string | null;
  className: string | null;
  rows: R[];
}

/**
 * Split the sorted roster into one block PER CLASS.
 *
 * WHY BLOCKS AND NOT A FLAT LIST (0.48.0). Each block becomes its own `<tbody>`, which is what lets the
 * printed page keep a class together: `break-inside: avoid` on a `<tbody>` tells the browser not to split
 * that group, so it fits as many WHOLE classes onto a sheet as the paper allows — two small classes share
 * a page, a big one starts its own. That is the actual request ("its own page unless two fit"), and it is
 * strictly better than forcing a page break before every class, which would leave half of every sheet
 * blank for a madrasah whose classes run eight children long.
 *
 * A class with more students than fit on one page still breaks, because the constraint is then
 * unsatisfiable — the right failure, and the browser's own.
 *
 * Rows arrive already sorted by course → class → name, so a change of value IS a new group; this reads
 * the same transition the flat render used to compute inline.
 */
export function classBlocks<R extends GroupableRow>(rows: R[]): ClassBlock<R>[] {
  const blocks: ClassBlock<R>[] = [];
  let seq = 0;
  for (const r of rows) {
    const last = blocks[blocks.length - 1];
    const prev = last?.rows[last.rows.length - 1];
    const newCourse = !prev || (prev.courseId ?? UNPLACED) !== (r.courseId ?? UNPLACED);
    const newClass = newCourse || prev.classId !== r.classId;
    if (newClass) {
      blocks.push({
        // Course and class ids are not unique together when both are null (every unplaced child), and two
        // courses can hold a same-named class — so the key carries a sequence number rather than trying to
        // build uniqueness out of the data.
        key: `${r.courseId ?? UNPLACED}:${r.classId ?? UNPLACED}:${seq++}`,
        startsCourse: newCourse,
        courseName: r.courseName,
        className: r.className,
        rows: [r],
      });
    } else {
      last.rows.push(r);
    }
  }
  return blocks;
}

export function YearView({ canConfigure }: { canConfigure: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();

  const [yearId, setYearId] = useState<string>('');
  /** '' = All courses, which is where the screen starts. */
  const [courseFilter, setCourseFilter] = useState('');
  // The school in view (0.47.0). ALWAYS exactly one: the grid is one school year laid out as months,
  // and two schools have different years — different start month, different length — so there is no
  // set of columns that could honestly show both. Both queries take it, because each school has its
  // own current year and the list and the grid must be asking about the same one.
  const { arg: schoolId } = useRequiredSchool();
  const years = trpc.structure.schoolYearList.useQuery({ schoolId });
  const grid = trpc.billing.yearGrid.useQuery({ schoolYearId: yearId || undefined, schoolId });
  const cols = trpc.billing.yearViewColumnsGet.useQuery();
  const setCols = trpc.billing.yearViewColumnsSet.useMutation();
  /** How this masjid writes dates. `settings.display` rather than `settings.get`, because this screen
   *  is finance's too and `get` is admin-only. */
  const dateFormat = (trpc.settings.display.useQuery().data?.dateFormat ?? 'iso') as DateFormat;

  const [showConfig, setShowConfig] = useState(false);

  async function refresh() {
    await Promise.all([utils.billing.yearGrid.invalidate(), utils.structure.schoolYearList.invalidate(), utils.billing.yearViewColumnsGet.invalidate()]);
  }

  async function toggleColumn(key: string, on: boolean) {
    const next = on ? [...(cols.data?.enabled ?? []), key] : (cols.data?.enabled ?? []).filter((c) => c !== key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the server re-validates against its own allow-list
    await setCols.mutateAsync({ columns: next as any });
    await refresh();
  }

  /** The fee-override note beside "Paying" — the office's own words about why a child pays less. Not a
   *  column, so it has its own switch; off means the server stops sending it at all. */
  async function toggleFeeNote(on: boolean) {
    await setCols.mutateAsync({ feeNote: on });
    await refresh();
  }

  const g = grid.data;
  const enabled = cols.data?.enabled ?? [];

  /**
   * Open a child's billing. Titled with the CHILD, keyed on the HOUSEHOLD.
   *
   * Both halves are deliberate: you pressed Yusuf, so the window says Yusuf and his payment box starts
   * on him — but one adult pays for all their children, so the window shows the household, and pressing
   * his sister afterwards does not stack a second window on the same family's money.
   */
  const openBilling = (row: { studentId: string; fullName: string; familyId: string }) =>
    open({
      title: row.fullName,
      wide: true,
      dedupeKey: `billing:${row.familyId}`,
      icon: <Wallet size={15} />,
      node: <FamilyBilling familyId={row.familyId} currency={g?.currency ?? 'usd'} focusStudentId={row.studentId} />,
    });

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
  /** One group per class — each renders as its own `<tbody>` so a class is not split across printed
   *  pages unless it genuinely cannot fit on one (0.48.0). */
  const blocks = useMemo(() => classBlocks(rows), [rows]);

  return (
    // `page--wide` lifts the shell's reading-width cap for this one screen (0.48.0): a whole year of
    // months plus the optional columns is wider than 1040px, and it was scrolling sideways with the
    // edges of the screen left empty. See admin.css.
    <div className="page page--wide">
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
        {/* The paper hint sits on the button rather than in a notice nobody reads: a year of months is
            wide even in landscape, and legal is what fits it without the columns closing up. */}
        {g && g.rows.length > 0 && (
          <button type="button" className="btn btn--ghost" onClick={() => window.print()} title={t('year.printPaperHint')}>
            <Printer size={15} /> {t('year.print')}
          </button>
        )}
        {canConfigure && (
          <button type="button" className="btn btn--ghost" onClick={() => setShowConfig((v) => !v)}>
            <Settings2 size={15} /> {t('year.configure')}
          </button>
        )}
      </div>

      <SchoolTabs requireOne />

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

          {/* Separate from the column chips because it is not a column: it is the note inside the
              "Paying" cell. Some offices want it in front of them all year; others don't want a
              bursary reason on a page that gets printed and left on a desk. */}
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ marginBlockStart: '0.2rem' }}
                checked={cols.data?.feeNote ?? true}
                onChange={(e) => void toggleFeeNote(e.target.checked)}
                disabled={setCols.isPending}
              />
              <span>
                {t('year.showFeeNote')}
                <span className="hint" style={{ display: 'block' }}>{t('year.showFeeNoteHint')}</span>
              </span>
            </label>
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
                  {/* A month before the go-live is marked in the HEADING as well as in the cells: it is
                      a property of the month, not of each child in it, and one dimmed column reads far
                      faster than forty identical cells. */}
                  {g.months.map((m) => {
                    const before = !!g.startPeriod && m.periodKey < g.startPeriod;
                    return (
                      <th key={m.periodKey} className={cn('year-month', before && 'is-before')} title={before ? t('year.beforeStart') : undefined}>
                        {m.label}
                      </th>
                    );
                  })}
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
              {/* One <tbody> PER CLASS, so a printed page can keep a class whole (see `classBlocks`).
                  Two levels of heading, in the order the office thinks: the course, then the classes
                  inside it. */}
              {blocks.map((block) => {
                const span = 2 + g.months.length + enabled.length;
                return (
                <tbody key={block.key} className="year-block">
                  {block.startsCourse && (
                    <tr className="year-group">
                      <td className="year-sticky" colSpan={span}>{block.courseName ?? t('students.unplaced')}</td>
                    </tr>
                  )}
                  <tr className="year-group year-group--class">
                    <td className="year-sticky" colSpan={span}>{block.className ?? t('students.unplaced')}</td>
                  </tr>
                  {block.rows.map((r) => (
                    <Fragment key={r.studentId}>
                      <tr>
                        <td className="year-sticky">
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openBilling(r)} title={t('year.openBilling')}>
                            {r.fullName}
                          </button>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span className="tnum">{formatMoney(r.monthlyAmountCents, g.currency)}</span>
                          {r.feeNote && <span className="chip is-muted" style={{ marginInlineStart: '0.35rem' }}>{r.feeNote}</span>}
                        </td>
                        {r.cells.map((c) => (
                          <td key={c.periodKey} className={`year-cell is-${c.status}`}>
                            {/* Four unclickable states, because there is no invoice of this app's to open:
                                  none     — nothing generated yet, and it COULD be. Blank, so a real gap
                                             still stands out.
                                  settled  — before go-live and the office said it was paid. A hollow ✓:
                                             true, but not something this app collected.
                                  carried  — before go-live and NOT paid. It is in the carried-forward
                                             bill, and flips to `settled` server-side once that is
                                             cleared, so the column stays true as the family pays.
                                  before   — before go-live and nobody told us either way. */}
                            {c.status === 'none' ? (
                              ''
                            ) : c.status === 'settled' || c.status === 'carried' || c.status === 'before' ? (
                              <span
                                className="year-cell-flat"
                                title={t(`year.hint_${c.status}`)}
                                aria-label={`${r.fullName} ${c.periodKey} ${t(`year.cell_${c.status}`)}`}
                              >
                                {c.status === 'settled' ? '✓' : c.status === 'carried' ? '○' : '·'}
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="year-cell-btn"
                                onClick={() => openBilling(r)}
                                title={`${c.periodKey} — ${t(`year.cell_${c.status}`)}`}
                                aria-label={`${r.fullName} ${c.periodKey} ${t(`year.cell_${c.status}`)}`}
                              >
                                {/* A filled ● for "billed, nothing paid". It was `·`, which at this size
                                    was almost invisible against the paid ticks — the one state the office
                                    is scanning FOR was the one hardest to see. */}
                                {c.status === 'paid' ? '✓' : c.status === 'partial' ? '½' : c.status === 'void' ? '—' : '●'}
                              </button>
                            )}
                          </td>
                        ))}
                        {enabled.includes('studentId') && <td><span className="code">{r.extra.studentCode ?? ''}</span></td>}
                        {enabled.includes('dob') && <td>{formatDate(r.extra.dob, dateFormat)}</td>}
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
                  ))}
                </tbody>
                );
              })}
            </table>
          </div>

          <p className="hint no-print">{t('year.legend')}</p>
        </section>
      )}
    </div>
  );
}
