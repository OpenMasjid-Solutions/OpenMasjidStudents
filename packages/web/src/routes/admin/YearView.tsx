// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The whole-year view: every student as a row, every billing month as a column, so the office can
 *  read a year of tuition at a glance and print it.
 *
 *  A cell is the FAMILY's invoice state for that month — that is what is billed and paid, so
 *  siblings on one bill show the same cell. Clicking a billed cell opens that family's record.
 *  The optional columns (phones, balance, PIN…) are admin-configured and resolved server-side, so a
 *  column that is off never reaches the browser.
 *
 *  Phone-first: the grid scrolls horizontally with the name column pinned, which is the only
 *  treatment that keeps 12 months usable on a phone. */
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Settings2, Printer } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { formatMoney } from '../../lib/money';
import { useWindows } from '../../components/Windows';
import { FamilyDetail } from './FamilyDetail';

export function YearView({ canConfigure }: { canConfigure: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();

  const [yearId, setYearId] = useState<string>('');
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
            <p className="hint">{t('year.pinWarning')}</p>
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
            <span className="chip is-muted">{t('students.count', { count: g.rows.length })}</span>
          </div>

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
                  {enabled.includes('pin') && <th>{t('year.col_pin')}</th>}
                  {enabled.includes('guardianNames') && <th>{t('year.col_guardianNames')}</th>}
                  {enabled.includes('guardianPhones') && <th>{t('year.col_guardianPhones')}</th>}
                  {enabled.includes('guardianEmails') && <th>{t('year.col_guardianEmails')}</th>}
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r, i) => {
                  const prev = g.rows[i - 1];
                  const newGroup = !prev || prev.classId !== r.classId;
                  const groupLabel = r.className ? `${r.courseName ?? '—'} · ${r.className}` : t('students.unplaced');
                  return (
                    <Fragment key={r.studentId}>
                      {newGroup && (
                        <tr className="year-group">
                          <td className="year-sticky" colSpan={2 + g.months.length + enabled.length}>{groupLabel}</td>
                        </tr>
                      )}
                      <tr>
                        <td className="year-sticky">
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openFamily(r.familyId, r.familyName)}>
                            {r.firstName} {r.lastName}
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
                                aria-label={`${r.firstName} ${c.periodKey} ${t(`year.cell_${c.status}`)}`}
                              >
                                {c.status === 'paid' ? '✓' : c.status === 'partial' ? '½' : c.status === 'void' ? '—' : '·'}
                              </button>
                            )}
                          </td>
                        ))}
                        {enabled.includes('studentId') && <td><span className="pin">{r.extra.studentCode ?? ''}</span></td>}
                        {enabled.includes('dob') && <td>{r.extra.dob ?? ''}</td>}
                        {enabled.includes('balance') && <td className="tnum">{formatMoney(r.extra.balanceCents ?? 0, g.currency)}</td>}
                        {enabled.includes('pin') && <td><span className="pin">{r.extra.pin}</span></td>}
                        {enabled.includes('guardianNames') && <td>{(r.extra.guardianNames ?? []).join(', ')}</td>}
                        {enabled.includes('guardianPhones') && <td style={{ whiteSpace: 'nowrap' }}>{(r.extra.guardianPhones ?? []).join(', ')}</td>}
                        {enabled.includes('guardianEmails') && <td>{(r.extra.guardianEmails ?? []).join(', ')}</td>}
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
