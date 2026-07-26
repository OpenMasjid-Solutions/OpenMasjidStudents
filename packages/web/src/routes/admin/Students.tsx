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
  const createFamily = trpc.people.familyCreate.useMutation();

  const [adding, setAdding] = useState(false);
  const [famName, setFamName] = useState('');

  const openFamily = (id: string, label: string) =>
    open({ title: label, wide: true, dedupeKey: `family:${id}`, icon: <Users size={15} />, node: <FamilyDetail familyId={id} /> });

  const openImport = () =>
    open({ title: t('students.import'), wide: true, dedupeKey: 'import:students', icon: <Upload size={15} />, node: <ImportStudents /> });

  async function addFamily(e: FormEvent) {
    e.preventDefault();
    if (!famName.trim()) return;
    const r = await createFamily.mutateAsync({ name: famName.trim() });
    setFamName('');
    setAdding(false);
    await utils.people.directory.invalidate();
    openFamily(r.id, famName.trim());
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
        <button type="button" className="btn btn--primary" onClick={() => setAdding((v) => !v)}>{t('directory.addFamily')}</button>
      </div>

      {adding && (
        <form className="inline-form glass-inset" onSubmit={addFamily}>
          <div className="field">
            <label className="label" htmlFor="fam-name">{t('directory.familyName')}</label>
            <input id="fam-name" className="input glass-inset" value={famName} onChange={(e) => setFamName(e.target.value)} autoFocus />
          </div>
          <button type="submit" className="btn btn--primary" disabled={createFamily.isPending}>{t('common.save')}</button>
          <p className="hint">{t('students.addViaFamily')}</p>
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
