// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The Students tab (replaces the family-first Directory): every student grouped by
 *  course → class, with an Unplaced bucket last. A student's record still lives in their family
 *  window — that is where siblings, guardians and fees are edited — so a row opens the family.
 *  Class placement is inline here because that is the one field you set while reading the roster. */
import { useMemo, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Users, Upload } from 'lucide-react';
import { staggerContainer, staggerItem } from '../../lib/motion';
import { trpc } from '../../lib/trpc';
import { useWindows } from '../../components/Windows';
import { FamilyDetail } from './FamilyDetail';
import { ImportStudents } from './ImportStudents';

type Row = {
  id: string;
  firstName: string;
  lastName: string;
  status: 'active' | 'withdrawn';
  familyId: string;
  familyName: string;
  classId: string | null;
  className: string | null;
  courseId: string | null;
  courseName: string | null;
};

export function Students() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();

  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [q, setQ] = useState('');
  const list = trpc.structure.studentsByClass.useQuery({ includeWithdrawn: showWithdrawn });
  const tree = trpc.structure.courseTree.useQuery();
  const setClass = trpc.structure.setStudentClass.useMutation();
  const addStudent = trpc.people.studentAdd.useMutation();
  const plans = trpc.billing.feePlanList.useQuery();
  const siblings = trpc.people.siblingOptions.useQuery();

  const [adding, setAdding] = useState(false);
  /** A student is added on its own terms; `linkToStudentId` is what makes them a sibling — guardians
   *  hang off the household, so linking IS how the parent details come to apply to them. */
  const [stu, setStu] = useState({ firstName: '', lastName: '', dob: '', feePlanId: '', classId: '', linkToStudentId: '' });

  const openFamily = (id: string, label: string) =>
    open({ title: label, wide: true, dedupeKey: `family:${id}`, icon: <Users size={15} />, node: <FamilyDetail familyId={id} /> });

  const openImport = () =>
    open({ title: t('students.import'), wide: true, dedupeKey: 'import:students', icon: <Upload size={15} />, node: <ImportStudents /> });

  async function submitStudent(e: FormEvent) {
    e.preventDefault();
    if (!stu.firstName.trim() || !stu.lastName.trim() || !stu.feePlanId) return;
    const r = await addStudent.mutateAsync({
      firstName: stu.firstName.trim(),
      lastName: stu.lastName.trim(),
      dob: stu.dob || undefined,
      feePlanId: stu.feePlanId,
      classId: stu.classId || undefined,
      linkToStudentId: stu.linkToStudentId || undefined,
    });
    setStu({ firstName: '', lastName: '', dob: '', feePlanId: stu.feePlanId, classId: stu.classId, linkToStudentId: '' });
    setAdding(false);
    await Promise.all([
      utils.people.directory.invalidate(),
      utils.people.siblingOptions.invalidate(),
      utils.structure.studentsByClass.invalidate(),
      utils.structure.courseTree.invalidate(),
    ]);
    // Straight into their record — the next thing the office does is add the guardian details.
    openFamily(r.familyId, r.familyLabel);
  }

  async function place(studentId: string, classId: string) {
    await setClass.mutateAsync({ studentId, classId: classId || null });
    await utils.structure.studentsByClass.invalidate();
    await utils.structure.courseTree.invalidate();
  }

  /** Group into course → class sections, with unplaced students last. */
  const groups = useMemo(() => {
    const rows = (list.data ?? []) as Row[];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((r) => `${r.firstName} ${r.lastName} ${r.familyName}`.toLowerCase().includes(needle))
      : rows;
    const byKey = new Map<string, { key: string; label: string; rows: Row[] }>();
    for (const r of filtered) {
      const key = r.classId ?? '__unplaced';
      const label = r.classId ? `${r.courseName ?? '—'} · ${r.className}` : t('students.unplaced');
      if (!byKey.has(key)) byKey.set(key, { key, label, rows: [] });
      byKey.get(key)!.rows.push(r);
    }
    const out = [...byKey.values()];
    // studentsByClass already orders by course/class/name, so insertion order is correct —
    // only the unplaced bucket needs forcing to the end.
    out.sort((a, b) => (a.key === '__unplaced' ? 1 : b.key === '__unplaced' ? -1 : 0));
    return out;
  }, [list.data, q, t]);

  const classOptions = useMemo(
    () => (tree.data ?? []).flatMap((c) => c.classes.map((k) => ({ id: k.id, label: `${c.name} · ${k.name}` }))),
    [tree.data],
  );

  const total = (list.data ?? []).length;

  return (
    <div className="page">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('students.title')}</h1>
        <span className="chip is-muted">{t('students.count', { count: total })}</span>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost" onClick={openImport}>{t('students.import')}</button>
        <button type="button" className="btn btn--primary" onClick={() => setAdding((v) => !v)}>{t('directory.addStudent')}</button>
      </div>

      {adding && (
        <form className="inline-form glass-inset" onSubmit={submitStudent}>
          <div className="field"><label className="label" htmlFor="stu-first">{t('directory.firstName')}</label>
            <input id="stu-first" className="input glass-inset" value={stu.firstName} onChange={(e) => setStu({ ...stu, firstName: e.target.value })} autoFocus />
          </div>
          <div className="field"><label className="label" htmlFor="stu-last">{t('directory.lastName')}</label>
            <input id="stu-last" className="input glass-inset" value={stu.lastName} onChange={(e) => setStu({ ...stu, lastName: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '0 1 10rem' }}><label className="label" htmlFor="stu-dob">{t('directory.dob')}</label>
            <input id="stu-dob" type="date" className="input glass-inset" value={stu.dob} onChange={(e) => setStu({ ...stu, dob: e.target.value })} />
          </div>
          {/* A fee plan is required: a student on no plan is skipped by invoice generation, which is
              how a child silently stops being billed. */}
          <div className="field" style={{ flex: '1 1 12rem' }}><label className="label" htmlFor="stu-plan">{t('directory.feePlan')}</label>
            <select id="stu-plan" className="input glass-inset" value={stu.feePlanId} onChange={(e) => setStu({ ...stu, feePlanId: e.target.value })} required>
              <option value="">{(plans.data ?? []).length ? t('directory.feePlan') : t('directory.noFeePlans')}</option>
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
          {/* The sibling link. This is the ONLY way households are formed — nobody names a family. */}
          <div className="field" style={{ flex: '1 1 13rem' }}><label className="label" htmlFor="stu-sibling">{t('students.linkSibling')}</label>
            <select id="stu-sibling" className="input glass-inset" value={stu.linkToStudentId} onChange={(e) => setStu({ ...stu, linkToStudentId: e.target.value })}>
              <option value="">{t('students.noSibling')}</option>
              {(siblings.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
            </select>
            <span className="hint">{t('students.linkSiblingHint')}</span>
          </div>
          <button type="submit" className="btn btn--primary" disabled={addStudent.isPending || !stu.feePlanId}>{t('common.save')}</button>
        </form>
      )}

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
      ) : groups.length === 0 ? (
        <p className="empty">{total === 0 ? t('students.empty') : t('students.noMatches')}</p>
      ) : (
        <motion.div variants={staggerContainer} initial="initial" animate="animate">
          {groups.map((g) => (
            <motion.section key={g.key} className="section glass" style={{ padding: '1rem 1.1rem', marginBottom: '0.9rem' }} variants={staggerItem}>
              <div className="section-head">
                <h2>{g.label}</h2>
                <span className="chip is-muted">{g.rows.length}</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('students.name')}</th>
                      <th>{t('students.family')}</th>
                      <th>{t('students.class')}</th>
                      <th>{t('students.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openFamily(s.familyId, s.familyName)}>
                            {s.firstName} {s.lastName}
                          </button>
                        </td>
                        <td>{s.familyName}</td>
                        <td>
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
            </motion.section>
          ))}
        </motion.div>
      )}
    </div>
  );
}
