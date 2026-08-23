// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The Students tab: every student under COURSE → CLASS, with an Unplaced bucket last, and course
 *  filter buttons across the top ("All" selected by default). A student's record opens their
 *  household window — that is where siblings, guardians and fees live — so a row opens the family.
 *  Class placement is inline here because that is the one field you set while reading the roster.
 *
 *  `readOnly` is how finance sees this screen (§5): they can read the roster, open a record and see
 *  contact details and balances, but every write — adding a student, placing them in a class,
 *  importing — is admin-only. The server enforces the same walls; this only stops finance being
 *  offered buttons that would fail. */
import { useMemo, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Printer, Send, Users, Upload } from 'lucide-react';
import { staggerContainer, staggerItem } from '../../lib/motion';
import { ageFromDob } from '../../lib/age';
import { parseCents } from '../../lib/money';
import { cn } from '../../lib/cn';
import { trpc } from '../../lib/trpc';
import { withBase } from '../../lib/base';
import { useWindows } from '../../components/Windows';
import { SchoolTabs, useSchool } from '../../components/SchoolTabs';
import { FamilyDetail } from './FamilyDetail';
import { ImportStudents } from './ImportStudents';
import { StudentPicker } from '../../components/StudentPicker';
import { OnboardingSend } from '../../components/OnboardingSend';
import { SiblingSuggestions } from '../../components/SiblingSuggestions';

type Row = {
  id: string;
  fullName: string;
  status: 'active' | 'withdrawn';
  dob: string | null;
  familyId: string;
  /** Not a column — the household label titles the window a row opens, and search matches it so
   *  typing a surname still finds every sibling. */
  familyName: string;
  classId: string | null;
  className: string | null;
  courseId: string | null;
  courseName: string | null;
};

/** One class, with the students in it. */
interface ClassGroup {
  key: string;
  label: string;
  rows: Row[];
}
/** One course, with its classes. The unplaced bucket is a course with a single nameless class. */
interface CourseGroup {
  key: string;
  label: string;
  classes: ClassGroup[];
  count: number;
}

const UNPLACED = '__unplaced';

export function Students({ readOnly = false }: { readOnly?: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();

  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [q, setQ] = useState('');
  /** '' = All, which is where the screen starts. */
  const [courseFilter, setCourseFilter] = useState('');
  /** The school in view (0.47.0) — '' / undefined on a single-school install, which is every query's
   *  "no filter" and therefore costs that install nothing. */
  const { arg: schoolId } = useSchool();
  const list = trpc.structure.studentsByClass.useQuery({ includeWithdrawn: showWithdrawn, schoolId });
  const tree = trpc.structure.courseTree.useQuery({ schoolId });
  const setClass = trpc.structure.setStudentClass.useMutation();
  const addStudent = trpc.people.studentAdd.useMutation();
  const plans = trpc.billing.feePlanList.useQuery();
  const siblings = trpc.people.studentOptions.useQuery();

  const [adding, setAdding] = useState(false);
  /** A student is added on its own terms; `linkToStudentId` is what makes them a sibling — guardians
   *  hang off the household, so linking IS how the parent details come to apply to them.
   *
   *  `billFromPeriod` empty is the default and means "bill nothing yet" — see the field below. */
  const [stu, setStu] = useState({ fullName: '', dob: '', feePlanId: '', classId: '', linkToStudentId: '', billFromPeriod: '', firstMonth: '' });
  /** The months a catch-up may start from: this school year's, back to the billing floor, up to now. */
  const billFrom = trpc.billing.billFromMonths.useQuery({ schoolId });
  /** What the catch-up did, so five new invoices are never created silently. */
  const [addedMsg, setAddedMsg] = useState<string | null>(null);

  const openFamily = (id: string, label: string) =>
    open({ title: label, wide: true, dedupeKey: `family:${id}`, icon: <Users size={15} />, node: <FamilyDetail familyId={id} readOnly={readOnly} /> });

  const openImport = () =>
    open({ title: t('students.import'), wide: true, dedupeKey: 'import:students', icon: <Upload size={15} />, node: <ImportStudents /> });

  const openSiblings = () =>
    open({ title: t('siblings.title'), wide: true, dedupeKey: 'siblings:suggest', icon: <Users size={15} />, node: <SiblingSuggestions /> });

  /** The onboarding message — the explain-what-this-is note, to a class, a course or the whole roster. */
  const openOnboarding = () =>
    open({ title: t('onboarding.title'), wide: true, dedupeKey: 'onboarding:send', icon: <Send size={15} />, node: <OnboardingSend /> });

  async function submitStudent(e: FormEvent) {
    e.preventDefault();
    if (!stu.fullName.trim() || !stu.feePlanId) return;
    const r = await addStudent.mutateAsync({
      fullName: stu.fullName.trim(),
      dob: stu.dob || undefined,
      feePlanId: stu.feePlanId,
      classId: stu.classId || undefined,
      // Only consulted when no class is chosen — a class already implies its school. Note this is
      // NOT inherited from the sibling being linked to: two children in one household may attend
      // different schools, which is the case the feature exists for.
      schoolId,
      linkToStudentId: stu.linkToStudentId || undefined,
      billFromPeriod: stu.billFromPeriod || undefined,
      ...(stu.firstMonth.trim() && stu.billFromPeriod ? { firstMonthCents: parseCents(stu.firstMonth) ?? undefined } : {}),
    });
    // Say what the catch-up did. Creating five invoices for a family is not something to do quietly, and
    // neither is creating none because the month was before the billing floor.
    setAddedMsg(
      !r.billed
        ? null
        : r.billed.created
          ? t('students.billedFrom', { count: r.billed.created, from: r.billed.periods[0] })
          : t(`students.billedNone_${r.billed.reason ?? 'nothing_to_bill'}`),
    );
    // The month is kept, like the plan and the class: a madrasah entering a group of children who all
    // started in October should not re-pick October for each of them.
    setStu({ fullName: '', dob: '', feePlanId: stu.feePlanId, classId: stu.classId, linkToStudentId: '', billFromPeriod: stu.billFromPeriod, firstMonth: '' });
    setAdding(false);
    await Promise.all([
      utils.people.directory.invalidate(),
      utils.people.studentOptions.invalidate(),
      utils.structure.studentsByClass.invalidate(),
      utils.structure.courseTree.invalidate(),
      // A catch-up writes invoices, so the year grid and the billing screens are now stale.
      utils.billing.yearGrid.invalidate(),
    ]);
    // Straight into their record — the next thing the office does is add the guardian details.
    openFamily(r.familyId, r.familyLabel);
  }

  async function place(studentId: string, classId: string) {
    await setClass.mutateAsync({ studentId, classId: classId || null });
    await utils.structure.studentsByClass.invalidate();
    await utils.structure.courseTree.invalidate();
  }

  /** Course → class → students. Unplaced students are their own trailing group so they are visible
   *  rather than quietly missing from a course-shaped list. */
  const courses = useMemo<CourseGroup[]>(() => {
    const rows = (list.data ?? []) as Row[];
    const needle = q.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (needle && !`${r.fullName} ${r.familyName}`.toLowerCase().includes(needle)) return false;
      if (courseFilter && (r.courseId ?? UNPLACED) !== courseFilter) return false;
      return true;
    });

    const byCourse = new Map<string, CourseGroup>();
    for (const r of filtered) {
      const ck = r.courseId ?? UNPLACED;
      if (!byCourse.has(ck)) {
        byCourse.set(ck, { key: ck, label: r.courseName ?? t('students.unplaced'), classes: [], count: 0 });
      }
      const course = byCourse.get(ck)!;
      const kk = r.classId ?? UNPLACED;
      let klass = course.classes.find((c) => c.key === kk);
      if (!klass) {
        klass = { key: kk, label: r.className ?? t('students.unplaced'), rows: [] };
        course.classes.push(klass);
      }
      klass.rows.push(r);
      course.count++;
    }
    const out = [...byCourse.values()];
    // studentsByClass already orders by course/class/name, so insertion order is correct — only the
    // unplaced bucket needs forcing to the end.
    out.sort((a, b) => (a.key === UNPLACED ? 1 : b.key === UNPLACED ? -1 : 0));
    return out;
  }, [list.data, q, courseFilter, t]);

  /** The filter buttons. Built from the course list, not from the rows, so a course with nobody in
   *  it yet is still offered — otherwise a new course looks broken until someone is enrolled. */
  const courseButtons = useMemo(() => {
    const rows = (list.data ?? []) as Row[];
    const countFor = (id: string) => rows.filter((r) => (r.courseId ?? UNPLACED) === id).length;
    const fromTree = (tree.data ?? []).map((c) => ({ id: c.id, label: c.name, count: countFor(c.id) }));
    const unplaced = countFor(UNPLACED);
    return unplaced ? [...fromTree, { id: UNPLACED, label: t('students.unplaced'), count: unplaced }] : fromTree;
  }, [tree.data, list.data, t]);

  const classOptions = useMemo(
    () => (tree.data ?? []).flatMap((c) => c.classes.map((k) => ({ id: k.id, label: `${c.name} · ${k.name}` }))),
    [tree.data],
  );

  const total = (list.data ?? []).length;
  const shown = courses.reduce((n, c) => n + c.count, 0);

  return (
    <div className="page">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('students.title')}</h1>
        <span className="chip is-muted">{t('students.count', { count: total })}</span>
        <span className="spacer" />
        {/* The Student ID sheet (0.48.0) — the whole active roster with everyone's ID, by class. Not
            behind `readOnly`: finance reads Student IDs and prints these, and the route allows exactly
            the same two roles. It is a page of its own rather than a print of this screen, which is what
            the import's Print button used to do (people/idSheet.ts). */}
        <a className="btn btn--ghost no-mobile" href={withBase(`/sheets/ids/${schoolId ?? 'all'}`)} target="_blank" rel="noopener noreferrer">
          <Printer size={14} /> {t('students.printIds')}
        </a>
        {!readOnly && (
          <>
            {/* Reachable outside the import too: an install that imported before 0.42.0 has households
                that were never linked, and this is where someone goes looking for them. */}
            {/* Admin only (behind `readOnly`, like every other write here): writing to every family at
                once speaks for the madrasah, which is the wall §5 draws around finance. */}
            <button type="button" className="btn btn--ghost" onClick={openOnboarding}>
              <Send size={14} /> {t('onboarding.button')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={openSiblings}>{t('siblings.title')}</button>
            <button type="button" className="btn btn--ghost no-mobile" onClick={openImport}>{t('students.import')}</button>
            <button type="button" className="btn btn--primary" onClick={() => setAdding((v) => !v)}>{t('directory.addStudent')}</button>
          </>
        )}
      </div>

      {/* Which school's roster. Draws nothing when there is only one. */}
      <SchoolTabs />

      {/* What the catch-up billed, if anything. Dismissible, because it is news rather than a problem. */}
      {addedMsg && (
        <div className="notice" style={{ marginBlockEnd: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ flex: 1 }}>{addedMsg}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAddedMsg(null)}>{t('common.close')}</button>
        </div>
      )}

      {adding && !readOnly && (
        <form className="inline-form glass-inset" onSubmit={submitStudent}>
          {/* ONE name field. Plenty of the names a madrasa enrols do not split into a western
              first/last pair, and forcing them to was losing information. */}
          <div className="field" style={{ flex: '2 1 16rem' }}><label className="label" htmlFor="stu-name">{t('directory.fullName')}</label>
            <input id="stu-name" className="input glass-inset" value={stu.fullName} onChange={(e) => setStu({ ...stu, fullName: e.target.value })} autoFocus />
          </div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label" htmlFor="stu-dob">{t('directory.dob')}</label>
            <input id="stu-dob" type="date" className="input glass-inset" value={stu.dob} onChange={(e) => setStu({ ...stu, dob: e.target.value })} />
          </div>
          {/* A fee plan is required: a student on no plan is skipped by invoice generation, which is
              how a child silently stops being billed. */}
          <div className="field" style={{ flex: '1 1 12rem' }}><label className="label" htmlFor="stu-plan">{t('directory.feePlan')}</label>
            <select id="stu-plan" className="input glass-inset" value={stu.feePlanId} onChange={(e) => setStu({ ...stu, feePlanId: e.target.value })} required>
              {/* "Choose a plan…", not the field's own label again — repeating "Fee plan" inside the box
                  read as though a plan called "Fee plan" were already selected. */}
              <option value="">{(plans.data ?? []).length ? t('directory.choosePlan') : t('directory.noFeePlans')}</option>
              {(plans.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="hint">{t('directory.feePlanHint')}</span>
          </div>
          <div className="field" style={{ flex: '1 1 11rem' }}><label className="label" htmlFor="stu-class">{t('students.class')}</label>
            <select id="stu-class" className="input glass-inset" value={stu.classId} onChange={(e) => setStu({ ...stu, classId: e.target.value })}>
              <option value="">{t('students.unplaced')}</option>
              {classOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          {/* Joining part-way through the year (0.48.0). The default is "nothing yet", which is what
              adding a student has always done — the months are for a child who has really been attending
              since October, and picking one creates their invoice for every month from then to now. Past
              months only: there is nothing to create for a month that has not happened, and the normal
              monthly run bills them when it arrives.
              ALWAYS RENDERED. It used to be hidden when the month list came back empty, which happens on a
              perfectly ordinary install — a school year that has not started yet, or a go-live month later
              than today — so the field was there on a fresh install and missing on a real one. An empty
              list is now a disabled box that says why, because a control you cannot find is worse than one
              that tells you it has nothing to offer. */}
          <div className="field" style={{ flex: '1 1 12rem' }}>
            <label className="label" htmlFor="stu-billfrom">{t('students.billFrom')}</label>
            <select
              id="stu-billfrom"
              className="input glass-inset"
              value={stu.billFromPeriod}
              disabled={(billFrom.data?.months ?? []).length === 0}
              onChange={(e) => setStu({ ...stu, billFromPeriod: e.target.value })}
            >
              <option value="">{t('students.billFromNone')}</option>
              {(billFrom.data?.months ?? []).map((m) => (
                <option key={m.periodKey} value={m.periodKey}>
                  {m.periodKey === billFrom.data?.current ? t('students.billFromThisMonth', { month: m.label }) : m.label}
                </option>
              ))}
            </select>
            {/* The hint has to distinguish a CATCH-UP from a month that has not happened. On an install
                whose go-live is next month, the only month offered IS in the future, and telling them it
                "creates one invoice per month from then until now" would be plainly untrue. */}
            <span className="hint">
              {(billFrom.data?.months ?? []).length === 0
                ? t('students.billFromEmpty')
                : !stu.billFromPeriod
                  ? t('students.billFromNoneHint')
                  : stu.billFromPeriod > (billFrom.data?.current ?? '')
                    ? t('students.billFromFutureHint')
                    : t('students.billFromHint')}
            </span>
          </div>
          {/* WHAT THEIR FIRST MONTH COMES TO, when it is not the plan's own amount — a child starting on
              the 15th is often charged part of that month. Only offered when a catch-up will actually
              create that invoice: for a future start month there is no invoice yet to adjust, and for "not
              yet" there is nothing at all. Left blank it bills the normal amount, which is the common case.
              The adjustment shows on the bill as its own line, so the parent can see why it differs. */}
          {!!stu.billFromPeriod && stu.billFromPeriod <= (billFrom.data?.current ?? '') && (
            <div className="field" style={{ flex: '0 1 10rem' }}>
              <label className="label" htmlFor="stu-firstmonth">{t('students.firstMonth')}</label>
              <input
                id="stu-firstmonth"
                type="number"
                step="0.01"
                min="0"
                className="input glass-inset"
                value={stu.firstMonth}
                onChange={(e) => setStu({ ...stu, firstMonth: e.target.value })}
                placeholder={t('students.firstMonthPlaceholder')}
              />
              <span className="hint">{t('students.firstMonthHint')}</span>
            </div>
          )}
          {/* The sibling link. This is the ONLY way households are formed — nobody names a family.
              Type-to-search, because by the time a school has three hundred children a dropdown of
              every one of them is not a way to find a brother. */}
          <div style={{ flex: '1 1 15rem' }}>
            <StudentPicker
              id="stu-sibling"
              label={t('students.linkSibling')}
              placeholder={t('students.noSibling')}
              students={siblings.data ?? []}
              value={stu.linkToStudentId}
              onChange={(id) => setStu({ ...stu, linkToStudentId: id })}
              // Which household this child joins IS the choice here, so it is named on every row.
              showFamily
            />
            <span className="hint">{t('students.linkSiblingHint')}</span>
          </div>
          <button type="submit" className="btn btn--primary" disabled={addStudent.isPending || !stu.feePlanId}>{t('common.save')}</button>
        </form>
      )}

      {/* Course filter. "All" first and selected by default, so the screen opens on the whole
          school and narrowing is a deliberate act. */}
      <div className="filter-bar" role="group" aria-label={t('students.filterByCourse')}>
        <button type="button" className={cn('btn btn--ghost btn--sm', courseFilter === '' && 'is-active')} aria-pressed={courseFilter === ''} onClick={() => setCourseFilter('')}>
          {t('students.allCourses')}
        </button>
        {courseButtons.map((c) => (
          <button key={c.id} type="button" className={cn('btn btn--ghost btn--sm', courseFilter === c.id && 'is-active')} aria-pressed={courseFilter === c.id} onClick={() => setCourseFilter(c.id)}>
            {c.label} <span className="chip is-muted">{c.count}</span>
          </button>
        ))}
      </div>

      <div className="inline-form glass-inset" style={{ alignItems: 'end' }}>
        <div className="field" style={{ flex: 1, minWidth: '12rem' }}>
          <label className="label" htmlFor="stu-search">{t('students.search')}</label>
          <input id="stu-search" className="input glass-inset" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('students.searchPlaceholder')} />
        </div>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.45rem' }}>
          <input type="checkbox" checked={showWithdrawn} onChange={(e) => setShowWithdrawn(e.target.checked)} />
          <span className="label" style={{ margin: 0 }}>{t('students.showWithdrawn')}</span>
        </label>
      </div>

      {list.isLoading ? (
        <p className="empty">{t('common.loading')}</p>
      ) : courses.length === 0 ? (
        <p className="empty">{total === 0 ? t('students.empty') : t('students.noMatches')}</p>
      ) : (
        <motion.div variants={staggerContainer} initial="initial" animate="animate">
          {courses.map((course) => (
            <motion.section key={course.key} className="section glass course-group" variants={staggerItem}>
              <div className="section-head">
                <h2>{course.label}</h2>
                <span className="chip is-muted">{t('students.count', { count: course.count })}</span>
              </div>

              {course.classes.map((klass) => (
                <div key={klass.key} className="class-group">
                  <div className="class-group-head">
                    <h3>{klass.label}</h3>
                    <span className="chip is-muted">{klass.rows.length}</span>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>{t('students.name')}</th>
                          {/* Age, not the date of birth: on a roster the useful question is "is this
                              child in the right class", and that is a number you can scan down. */}
                          <th>{t('students.age')}</th>
                          <th>{t('students.class')}</th>
                          <th>{t('students.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {klass.rows.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <button type="button" className="btn btn--ghost btn--sm" onClick={() => openFamily(s.familyId, s.familyName)}>
                                {s.fullName}
                              </button>
                            </td>
                            <td>{ageFromDob(s.dob) ?? <span className="muted">—</span>}</td>
                            <td>
                              {readOnly ? (
                                <span>{s.className ?? t('students.unplaced')}</span>
                              ) : (
                                <select
                                  className="input glass-inset"
                                  style={{ width: 'auto', minWidth: '10rem', padding: '0.25rem 0.4rem' }}
                                  value={s.classId ?? ''}
                                  onChange={(e) => void place(s.id, e.target.value)}
                                  aria-label={t('students.class')}
                                >
                                  <option value="">{t('students.unplaced')}</option>
                                  {classOptions.map((c) => (
                                    <option key={c.id} value={c.id}>{c.label}</option>
                                  ))}
                                </select>
                              )}
                            </td>
                            <td>
                              <span className={`chip ${s.status === 'withdrawn' ? 'is-muted' : ''}`}>
                                {s.status === 'withdrawn' ? t('directory.withdrawn') : t('directory.active')}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </motion.section>
          ))}
          {shown !== total && <p className="hint" style={{ textAlign: 'center' }}>{t('students.showingOf', { shown, total })}</p>}
        </motion.div>
      )}
    </div>
  );
}
