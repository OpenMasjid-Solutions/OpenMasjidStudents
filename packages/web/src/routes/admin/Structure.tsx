// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Structure (admin only): the school year, its optional terms, and the course → class grouping.
 *
 * This is the tab everything else hangs off. Until a course and a class exist, `courseTree` is empty,
 * so the Students tab's class dropdown has nothing to offer and every student stays unplaced — which
 * makes the course-grouped roster, the year view's grouping, and mass-apply-by-class all inert. The
 * server has had these procedures since v0.36.0; this is the surface that reaches them.
 *
 * Organisational only, on purpose: a class here carries no teacher, attendance or grades (that scope
 * was removed at v0.35.0 and stays out). Terms exist purely so `fee_plans.cadence = 'per_term'` has
 * something to mean for a madrasah that bills per term.
 *
 * Archive, never delete: classes reference their course and students reference their class, so the
 * money and roster history stay intact. Archiving a class unplaces its students first (the server
 * does that in one transaction) and tells you how many moved.
 */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { CalendarRange, Layers, Pencil, Plus, School, UserPlus } from 'lucide-react';
import { fadeRise, staggerContainer, staggerItem } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { MONTH_NAMES, schoolYearSpan } from '../../lib/months';
import { useWindows } from '../../components/Windows';
import { SchoolTabs, useSchool } from '../../components/SchoolTabs';
import { ClassEnrol } from '../../components/ClassEnrol';

/** The in-progress edit of one school year, or null when nothing is being edited. */
interface YearEdit {
  id: string;
  label: string;
  startYear: string;
  startMonth: string;
  endMonth: string;
}

export function Structure() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();

  /** Mass enrolment opens as its own window: it is a list of the whole school, which does not belong
   *  inline under a class chip. */
  const openEnrol = (classId: string, classLabel: string) =>
    open({ title: t('enrol.title'), wide: true, dedupeKey: `enrol:${classId}`, icon: <UserPlus size={15} />, node: <ClassEnrol classId={classId} classLabel={classLabel} /> });

  // Both scoped to the school in view (0.47.0): a school owns its own calendar AND its own courses,
  // so this tab configures one school at a time.
  const { arg: schoolId } = useSchool();
  const years = trpc.structure.schoolYearList.useQuery({ schoolId });
  const tree = trpc.structure.courseTree.useQuery({ schoolId });

  const yearCreate = trpc.structure.schoolYearCreate.useMutation();
  const yearUpdate = trpc.structure.schoolYearUpdate.useMutation();
  const yearSetCurrent = trpc.structure.schoolYearSetCurrent.useMutation();
  const yearArchive = trpc.structure.schoolYearArchive.useMutation();

  const courseCreate = trpc.structure.courseCreate.useMutation();
  const courseUpdate = trpc.structure.courseUpdate.useMutation();
  const courseArchive = trpc.structure.courseArchive.useMutation();
  const classCreate = trpc.structure.classCreate.useMutation();
  const classUpdate = trpc.structure.classUpdate.useMutation();
  const classArchive = trpc.structure.classArchive.useMutation();

  const thisYear = new Date().getFullYear();
  /** The months start UNSET. They used to default to Apr → Mar, which is the commonest madrasa year
   *  but silently decided the billing calendar for anyone who did not notice the dropdowns — and a
   *  wrong start month generates a wrong set of invoice periods. Making it an explicit choice costs
   *  two clicks once per year. */
  const [newYear, setNewYear] = useState({ label: '', startYear: String(thisYear), startMonth: '', endMonth: '' });
  const [yearEdit, setYearEdit] = useState<YearEdit | null>(null);

  /** Which year's terms are shown. Defaults to the current year once the list loads. */
  const [termYearId, setTermYearId] = useState('');
  const activeYearId = termYearId || years.data?.find((y) => y.isCurrent)?.id || years.data?.[0]?.id || '';
  const termsQ = trpc.structure.termList.useQuery({ schoolYearId: activeYearId }, { enabled: !!activeYearId });
  const termCreate = trpc.structure.termCreate.useMutation();
  const termUpdate = trpc.structure.termUpdate.useMutation();
  const termDelete = trpc.structure.termDelete.useMutation();
  const [newTerm, setNewTerm] = useState({ name: '', startDate: '', endDate: '' });
  const [termEdit, setTermEdit] = useState<{ id: string; name: string; startDate: string; endDate: string } | null>(null);

  // ── Schools (0.47.0) ────────────────────────────────────────────────────────
  const schoolsQ = trpc.structure.schoolList.useQuery();
  const schoolCreate = trpc.structure.schoolCreate.useMutation();
  const schoolUpdate = trpc.structure.schoolUpdate.useMutation();
  const schoolDelete = trpc.structure.schoolDelete.useMutation();
  const [newSchool, setNewSchool] = useState('');
  const [schoolRename, setSchoolRename] = useState<{ id: string; name: string } | null>(null);
  /** Adding or removing a school changes the switcher, the year list and the course tree at once. */
  async function refreshSchools() {
    await Promise.all([
      utils.structure.schoolList.invalidate(),
      utils.structure.schoolCounts.invalidate(),
      utils.structure.schoolYearList.invalidate(),
      utils.structure.courseTree.invalidate(),
    ]);
  }

  const [newCourse, setNewCourse] = useState('');
  /** Per-course "add a class" input, keyed by course id — so two courses can be edited at once. */
  const [newClass, setNewClass] = useState<Record<string, string>>({});
  const [rename, setRename] = useState<{ kind: 'course' | 'class'; id: string; name: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** One place to run a mutation, refresh, and turn a server error into a readable line. */
  async function run(fn: () => Promise<unknown>, after?: () => void): Promise<void> {
    setErr(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function refreshYears() {
    await Promise.all([utils.structure.schoolYearList.invalidate(), utils.billing.yearGrid.invalidate()]);
  }
  async function refreshTerms() {
    await utils.structure.termList.invalidate();
  }
  /** Courses/classes changing moves students between groups, so the roster and the grid refresh too. */
  async function refreshTree() {
    await Promise.all([
      utils.structure.courseTree.invalidate(),
      utils.structure.studentsByClass.invalidate(),
      utils.billing.yearGrid.invalidate(),
    ]);
  }

  // ── School years ────────────────────────────────────────────────────────────
  async function addYear(e: FormEvent) {
    e.preventDefault();
    if (!newYear.label.trim() || !newYear.startMonth || !newYear.endMonth) return;
    await run(
      () =>
        yearCreate.mutateAsync({
          // The school in view owns the new year; the server falls back to the only school when
          // this is undefined, which is every single-school install.
          schoolId,
          label: newYear.label.trim(),
          startYear: Number(newYear.startYear),
          startMonth: Number(newYear.startMonth),
          endMonth: Number(newYear.endMonth),
          makeCurrent: true,
        }),
      () => setNewYear({ label: '', startYear: String(thisYear), startMonth: '', endMonth: '' }),
    );
    await refreshYears();
  }

  async function saveYear(e: FormEvent) {
    e.preventDefault();
    if (!yearEdit) return;
    await run(
      () =>
        yearUpdate.mutateAsync({
          id: yearEdit.id,
          label: yearEdit.label.trim(),
          startYear: Number(yearEdit.startYear),
          startMonth: Number(yearEdit.startMonth),
          endMonth: Number(yearEdit.endMonth),
        }),
      () => setYearEdit(null),
    );
    await refreshYears();
  }

  // ── Terms ───────────────────────────────────────────────────────────────────
  async function addTerm(e: FormEvent) {
    e.preventDefault();
    if (!activeYearId || !newTerm.name.trim()) return;
    await run(
      () =>
        termCreate.mutateAsync({
          schoolYearId: activeYearId,
          name: newTerm.name.trim(),
          startDate: newTerm.startDate || undefined,
          endDate: newTerm.endDate || undefined,
        }),
      () => setNewTerm({ name: '', startDate: '', endDate: '' }),
    );
    await refreshTerms();
  }

  async function saveTerm(e: FormEvent) {
    e.preventDefault();
    if (!termEdit) return;
    await run(
      () =>
        termUpdate.mutateAsync({
          id: termEdit.id,
          name: termEdit.name.trim(),
          // '' clears the date server-side; undefined would leave it untouched.
          startDate: termEdit.startDate,
          endDate: termEdit.endDate,
        }),
      () => setTermEdit(null),
    );
    await refreshTerms();
  }

  // ── Courses & classes ───────────────────────────────────────────────────────
  async function addCourse(e: FormEvent) {
    e.preventDefault();
    if (!newCourse.trim()) return;
    await run(() => courseCreate.mutateAsync({ schoolId, name: newCourse.trim() }), () => setNewCourse(''));
    await refreshTree();
  }

  async function addClass(courseId: string) {
    const name = (newClass[courseId] ?? '').trim();
    if (!name) return;
    await run(
      () => classCreate.mutateAsync({ courseId, name }),
      () => setNewClass((m) => ({ ...m, [courseId]: '' })),
    );
    await refreshTree();
  }

  async function saveRename(e: FormEvent) {
    e.preventDefault();
    if (!rename || !rename.name.trim()) return;
    const { kind, id, name } = rename;
    await run(
      () => (kind === 'course' ? courseUpdate.mutateAsync({ id, name: name.trim() }) : classUpdate.mutateAsync({ id, name: name.trim() })),
      () => setRename(null),
    );
    await refreshTree();
  }

  /** Nudge a course or class up/down by rewriting its sort order. The list is already sorted by
   *  sortOrder then name, so swapping with the neighbour is enough. */
  async function move(kind: 'course' | 'class', id: string, siblings: { id: string; sortOrder: number }[], dir: -1 | 1) {
    const i = siblings.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    // Sort orders may be equal (everything defaults to 0), so assign positions outright rather than
    // swapping two values that might be identical and change nothing.
    const reordered = [...siblings];
    [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
    await run(async () => {
      for (const [pos, s] of reordered.entries()) {
        if (kind === 'course') await courseUpdate.mutateAsync({ id: s.id, sortOrder: pos });
        else await classUpdate.mutateAsync({ id: s.id, sortOrder: pos });
      }
    });
    await refreshTree();
  }

  async function doCourseArchive(id: string, name: string) {
    await run(() => courseArchive.mutateAsync({ id }), () => setNote(t('structure.courseArchived', { name })));
    await refreshTree();
  }

  async function doClassArchive(id: string, name: string) {
    await run(async () => {
      const r = await classArchive.mutateAsync({ id });
      setNote(r.unplaced > 0 ? t('structure.classArchivedUnplaced', { name, count: r.unplaced }) : t('structure.classArchived', { name }));
    });
    await refreshTree();
  }

  const yearList = years.data ?? [];
  const courses = tree.data ?? [];

  return (
    <motion.div className="page" variants={fadeRise} initial="initial" animate="animate">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('structure.title')}</h1>
      </div>

      {/* Which school is being configured. Draws nothing when there is only one. */}
      <SchoolTabs />

      {err && <div className="notice notice--warn">{err}</div>}
      {note && <div className="notice">{note}</div>}

      {/* ── Schools (0.47.0) ────────────────────────────────────────────────
          A masjid may run a maktab on one calendar beside a hifz programme on another. Each school
          gets its own school year and its own courses; everything else — fee plans, staff, the
          Stripe account, and above all the HOUSEHOLD — stays shared, so a family with a child in
          each is still one family with one balance and one sheet. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><School size={16} />{t('structure.schools')}</h2>
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('structure.schoolsHint')}</p>
        <table className="data-table">
          <tbody>
            {(schoolsQ.data?.schools ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  {schoolRename?.id === s.id ? (
                    <form
                      className="inline-form"
                      style={{ margin: 0 }}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await run(() => schoolUpdate.mutateAsync({ id: s.id, name: schoolRename.name.trim() }), () => setSchoolRename(null));
                        await refreshSchools();
                      }}
                    >
                      <input className="input glass-inset" value={schoolRename.name} onChange={(e) => setSchoolRename({ id: s.id, name: e.target.value })} autoFocus />
                      <button type="submit" className="btn btn--primary btn--sm">{t('common.save')}</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSchoolRename(null)}>{t('common.cancel')}</button>
                    </form>
                  ) : (
                    <strong>{s.name}</strong>
                  )}
                </td>
                <td className="actions">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSchoolRename({ id: s.id, name: s.name })}>
                    <Pencil size={14} /> {t('common.rename')}
                  </button>
                  {/* Only offered when there is more than one — the last school cannot go, and a
                      button that always refuses is worse than no button. */}
                  {(schoolsQ.data?.schools.length ?? 0) > 1 && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={async () => {
                        // Try the clean delete first; the server refuses when anything still points
                        // at it and says what, which is more use than a confirm dialog guessing.
                        await run(() => schoolDelete.mutateAsync({ id: s.id }));
                        await refreshSchools();
                      }}
                    >
                      {t('common.remove')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="inline-form glass-inset"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newSchool.trim()) return;
            await run(() => schoolCreate.mutateAsync({ name: newSchool.trim() }), () => setNewSchool(''));
            await refreshSchools();
          }}
        >
          <div className="field">
            <label className="label" htmlFor="new-school">{t('structure.addSchool')}</label>
            <input id="new-school" className="input glass-inset" value={newSchool} onChange={(e) => setNewSchool(e.target.value)} placeholder={t('structure.addSchoolPlaceholder')} />
          </div>
          <button type="submit" className="btn btn--primary" disabled={schoolCreate.isPending || !newSchool.trim()}><Plus size={15} /> {t('common.add')}</button>
        </form>
      </section>

      {/* ── School years ───────────────────────────────────────────────────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><CalendarRange size={16} />{t('structure.years')}</h2>
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('structure.yearsHint')}</p>

        {yearList.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('structure.noYears')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('structure.yearName')}</th>
                  <th>{t('structure.runs')}</th>
                  <th>{t('structure.state')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {yearList.map((y) => (
                  <tr key={y.id}>
                    <td>{y.label}</td>
                    <td>
                      {y.startYear == null ? (
                        <span className="chip is-accent">{t('structure.needsStartYear')}</span>
                      ) : (
                        schoolYearSpan(y.startYear, y.startMonth, y.endMonth)
                      )}
                    </td>
                    <td>
                      {y.isCurrent && <span className="chip">{t('structure.current')}</span>}
                      {y.status === 'archived' && <span className="chip is-muted">{t('structure.archived')}</span>}
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          setYearEdit({
                            id: y.id,
                            label: y.label,
                            startYear: String(y.startYear ?? thisYear),
                            startMonth: String(y.startMonth),
                            endMonth: String(y.endMonth),
                          })
                        }
                      >
                        <Pencil size={13} /> {t('common.edit')}
                      </button>
                      {!y.isCurrent && y.status === 'active' && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={yearSetCurrent.isPending} onClick={() => void run(() => yearSetCurrent.mutateAsync({ id: y.id }), undefined).then(refreshYears)}>
                          {t('structure.makeCurrent')}
                        </button>
                      )}
                      {y.status === 'active' && !y.isCurrent && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={yearArchive.isPending} onClick={() => void run(() => yearArchive.mutateAsync({ id: y.id }), undefined).then(refreshYears)}>
                          {t('structure.archive')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {yearEdit && (
          <form className="inline-form glass-inset" onSubmit={saveYear}>
            <div className="field" style={{ minWidth: '12rem' }}>
              <label className="label">{t('structure.yearName')}</label>
              <input className="input glass-inset" value={yearEdit.label} onChange={(e) => setYearEdit({ ...yearEdit, label: e.target.value })} autoFocus />
            </div>
            <div className="field">
              <label className="label">{t('structure.startsIn')}</label>
              <input className="input glass-inset" type="number" min={2000} max={2200} style={{ width: '7rem' }} value={yearEdit.startYear} onChange={(e) => setYearEdit({ ...yearEdit, startYear: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">{t('structure.from')}</label>
              <select className="input glass-inset" value={yearEdit.startMonth} onChange={(e) => setYearEdit({ ...yearEdit, startMonth: e.target.value })}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">{t('structure.to')}</label>
              <select className="input glass-inset" value={yearEdit.endMonth} onChange={(e) => setYearEdit({ ...yearEdit, endMonth: e.target.value })}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={yearUpdate.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setYearEdit(null)}>{t('common.cancel')}</button>
            <p className="hint">{t('structure.wrapHint')}</p>
          </form>
        )}

        <form className="inline-form glass-inset" onSubmit={addYear}>
          <div className="field" style={{ minWidth: '12rem' }}>
            <label className="label">{t('structure.yearName')}</label>
            <input className="input glass-inset" value={newYear.label} onChange={(e) => setNewYear({ ...newYear, label: e.target.value })} placeholder={t('structure.yearPlaceholder')} />
          </div>
          <div className="field">
            <label className="label">{t('structure.startsIn')}</label>
            <input className="input glass-inset" type="number" min={2000} max={2200} style={{ width: '7rem' }} value={newYear.startYear} onChange={(e) => setNewYear({ ...newYear, startYear: e.target.value })} />
          </div>
          <div className="field">
            <label className="label">{t('structure.from')}</label>
            <select className="input glass-inset" value={newYear.startMonth} onChange={(e) => setNewYear({ ...newYear, startMonth: e.target.value })} required>
              <option value="">{t('common.select')}</option>
              {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">{t('structure.to')}</label>
            <select className="input glass-inset" value={newYear.endMonth} onChange={(e) => setNewYear({ ...newYear, endMonth: e.target.value })} required>
              <option value="">{t('common.select')}</option>
              {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </select>
          </div>
          <button type="submit" className="btn btn--primary" disabled={yearCreate.isPending || !newYear.label.trim() || !newYear.startMonth || !newYear.endMonth}>{t('structure.addYear')}</button>
          <p className="hint">{t('structure.wrapHint')}</p>
        </form>
      </section>

      {/* ── Terms (optional) ───────────────────────────────────────────────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('structure.terms')}</h2>
          {yearList.length > 0 && (
            <select
              className="input glass-inset"
              style={{ width: 'auto', minWidth: '13rem' }}
              value={activeYearId}
              onChange={(e) => setTermYearId(e.target.value)}
              aria-label={t('structure.years')}
            >
              {yearList.map((y) => (
                <option key={y.id} value={y.id}>{y.label}{y.isCurrent ? ` — ${t('structure.current')}` : ''}</option>
              ))}
            </select>
          )}
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('structure.termsHint')}</p>

        {!activeYearId ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('structure.termsNeedYear')}</p>
        ) : (
          <>
            {(termsQ.data ?? []).length === 0 ? (
              <p className="muted" style={{ fontSize: '0.9rem' }}>{t('structure.noTerms')}</p>
            ) : (
              <div className="chip-row">
                {termsQ.data?.map((tm) => (
                  <span key={tm.id} className="chip">
                    {tm.name}
                    {tm.startDate && <span className="muted"> · {tm.startDate}{tm.endDate ? ` → ${tm.endDate}` : ''}</span>}
                    <button type="button" className="link-btn" style={{ marginInlineStart: '0.4rem' }} onClick={() => setTermEdit({ id: tm.id, name: tm.name, startDate: tm.startDate ?? '', endDate: tm.endDate ?? '' })} aria-label={t('common.edit')}>
                      <Pencil size={12} />
                    </button>
                    <button type="button" className="link-btn" style={{ marginInlineStart: '0.3rem' }} onClick={() => void run(() => termDelete.mutateAsync({ id: tm.id }), undefined).then(refreshTerms)} aria-label={t('common.remove')}>×</button>
                  </span>
                ))}
              </div>
            )}

            {termEdit && (
              <form className="inline-form glass-inset" onSubmit={saveTerm}>
                <div className="field"><label className="label">{t('structure.termName')}</label><input className="input glass-inset" value={termEdit.name} onChange={(e) => setTermEdit({ ...termEdit, name: e.target.value })} autoFocus /></div>
                <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('structure.termStart')}</label><input type="date" className="input glass-inset" value={termEdit.startDate} onChange={(e) => setTermEdit({ ...termEdit, startDate: e.target.value })} /></div>
                <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('structure.termEnd')}</label><input type="date" className="input glass-inset" value={termEdit.endDate} onChange={(e) => setTermEdit({ ...termEdit, endDate: e.target.value })} /></div>
                <button type="submit" className="btn btn--primary" disabled={termUpdate.isPending}>{t('common.save')}</button>
                <button type="button" className="btn btn--ghost" onClick={() => setTermEdit(null)}>{t('common.cancel')}</button>
              </form>
            )}

            <form className="inline-form glass-inset" onSubmit={addTerm}>
              <div className="field"><label className="label">{t('structure.termName')}</label><input className="input glass-inset" value={newTerm.name} onChange={(e) => setNewTerm({ ...newTerm, name: e.target.value })} placeholder={t('structure.termPlaceholder')} /></div>
              <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('structure.termStart')}</label><input type="date" className="input glass-inset" value={newTerm.startDate} onChange={(e) => setNewTerm({ ...newTerm, startDate: e.target.value })} /></div>
              <div className="field" style={{ flex: '0 1 10rem' }}><label className="label">{t('structure.termEnd')}</label><input type="date" className="input glass-inset" value={newTerm.endDate} onChange={(e) => setNewTerm({ ...newTerm, endDate: e.target.value })} /></div>
              <button type="submit" className="btn btn--primary" disabled={termCreate.isPending || !newTerm.name.trim()}>{t('structure.addTerm')}</button>
            </form>
          </>
        )}
      </section>

      {/* ── Courses & classes ──────────────────────────────────────────────── */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><Layers size={16} />{t('structure.courses')}</h2>
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.6rem' }}>{t('structure.coursesHint')}</p>

        {rename && (
          <form className="inline-form glass-inset" onSubmit={saveRename}>
            <div className="field" style={{ minWidth: '12rem' }}>
              <label className="label">{rename.kind === 'course' ? t('structure.courseName') : t('structure.className')}</label>
              <input className="input glass-inset" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} autoFocus />
            </div>
            <button type="submit" className="btn btn--primary" disabled={courseUpdate.isPending || classUpdate.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setRename(null)}>{t('common.cancel')}</button>
          </form>
        )}

        {courses.length === 0 ? (
          <p className="empty">{t('structure.noCourses')}</p>
        ) : (
          <motion.div variants={staggerContainer} initial="initial" animate="animate">
            {courses.map((c) => (
              <motion.div key={c.id} className="glass-inset" style={{ padding: '0.7rem 0.85rem', marginBlockEnd: '0.6rem', borderRadius: 'var(--radius-card)' }} variants={staggerItem}>
                <div className="section-head" style={{ marginBlockEnd: '0.45rem' }}>
                  <h3 style={{ fontSize: '1rem', margin: 0 }}>{c.name}</h3>
                  <span className="chip is-muted">{t('structure.nClasses', { count: c.classes.length })}</span>
                  <span className="spacer" style={{ marginInlineStart: 'auto' }} />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => move('course', c.id, courses, -1)} aria-label={t('structure.moveUp')}>↑</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => move('course', c.id, courses, 1)} aria-label={t('structure.moveDown')}>↓</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRename({ kind: 'course', id: c.id, name: c.name })}><Pencil size={13} /> {t('common.edit')}</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => doCourseArchive(c.id, c.name)} disabled={courseArchive.isPending}>{t('structure.archive')}</button>
                </div>

                {c.classes.length > 0 && (
                  <div className="chip-row" style={{ marginBlockEnd: '0.45rem' }}>
                    {c.classes.map((k) => (
                      <span key={k.id} className="chip">
                        {k.name} <span className="muted">· {t('structure.nStudents', { count: k.studentCount })}</span>
                        {/* Enrol a group into this class — the September job. The per-student dropdown
                            on the roster stays for one-off corrections. */}
                        <button
                          type="button"
                          className="link-btn"
                          style={{ marginInlineStart: '0.35rem' }}
                          onClick={() => openEnrol(k.id, `${c.name} · ${k.name}`)}
                          aria-label={t('enrol.title')}
                          title={t('enrol.title')}
                        >
                          <UserPlus size={12} />
                        </button>
                        <button type="button" className="link-btn" style={{ marginInlineStart: '0.2rem' }} onClick={() => move('class', k.id, c.classes, -1)} aria-label={t('structure.moveUp')}>↑</button>
                        <button type="button" className="link-btn" style={{ marginInlineStart: '0.2rem' }} onClick={() => move('class', k.id, c.classes, 1)} aria-label={t('structure.moveDown')}>↓</button>
                        <button type="button" className="link-btn" style={{ marginInlineStart: '0.2rem' }} onClick={() => setRename({ kind: 'class', id: k.id, name: k.name })} aria-label={t('common.edit')}><Pencil size={12} /></button>
                        <button type="button" className="link-btn" style={{ marginInlineStart: '0.2rem' }} onClick={() => doClassArchive(k.id, k.name)} aria-label={t('structure.archive')}>×</button>
                      </span>
                    ))}
                  </div>
                )}

                <form
                  className="inline-form"
                  style={{ marginBlockStart: 0 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addClass(c.id);
                  }}
                >
                  <div className="field" style={{ minWidth: '10rem' }}>
                    <label className="label">{t('structure.className')}</label>
                    <input className="input glass-inset" value={newClass[c.id] ?? ''} onChange={(e) => setNewClass((m) => ({ ...m, [c.id]: e.target.value }))} placeholder={t('structure.classPlaceholder')} />
                  </div>
                  <button type="submit" className="btn btn--ghost" disabled={classCreate.isPending || !(newClass[c.id] ?? '').trim()}>
                    <Plus size={14} /> {t('structure.addClass')}
                  </button>
                </form>
              </motion.div>
            ))}
          </motion.div>
        )}

        <form className="inline-form glass-inset" onSubmit={addCourse}>
          <div className="field" style={{ minWidth: '12rem' }}>
            <label className="label">{t('structure.courseName')}</label>
            <input className="input glass-inset" value={newCourse} onChange={(e) => setNewCourse(e.target.value)} placeholder={t('structure.coursePlaceholder')} />
          </div>
          <button type="submit" className="btn btn--primary" disabled={courseCreate.isPending || !newCourse.trim()}>{t('structure.addCourse')}</button>
        </form>
      </section>
    </motion.div>
  );
}
