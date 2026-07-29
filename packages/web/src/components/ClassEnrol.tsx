// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Enrol a group of students into one class at once (window content, opened from Courses & classes).
 *
 * The per-student dropdown on the roster is still there and is still right for one correction. This is
 * for September, when thirty children go into Hifz 1 and doing that one dropdown at a time is the
 * difference between a five-minute job and an hour.
 *
 * Two details that decide whether this is actually usable:
 *  - it opens filtered to students **not in a class yet**, because that is who you are almost always
 *    placing. The filter is a visible control, not a hidden assumption, so moving children out of
 *    another class is one click away;
 *  - the children already in this class are listed too, ticked and greyed, so the office can see who is
 *    in before adding more — an empty list would look like the class was empty.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Check } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ageFromDob } from '../lib/age';
import { cn } from '../lib/cn';

type Scope = 'unplaced' | 'others' | 'all';

export function ClassEnrol({ classId, classLabel }: { classId: string; classLabel: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const list = trpc.structure.studentsByClass.useQuery({});
  const enrol = trpc.structure.setStudentClassBulk.useMutation();

  const [scope, setScope] = useState<Scope>('unplaced');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);

  const rows = list.data ?? [];
  const alreadyIn = useMemo(() => rows.filter((r) => r.classId === classId), [rows, classId]);

  /** The pool to choose from, under the current scope and search. */
  const pool = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => r.classId !== classId)
      .filter((r) => (scope === 'unplaced' ? !r.classId : scope === 'others' ? !!r.classId : true))
      .filter((r) => !needle || `${r.fullName} ${r.familyName} ${r.className ?? ''}`.toLowerCase().includes(needle));
  }, [rows, classId, scope, q]);

  const counts = useMemo(
    () => ({
      unplaced: rows.filter((r) => !r.classId).length,
      others: rows.filter((r) => r.classId && r.classId !== classId).length,
      all: rows.filter((r) => r.classId !== classId).length,
    }),
    [rows, classId],
  );

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select-all works on what is VISIBLE, which is the only meaning that isn't a trap: a search for
   *  "hifz" followed by "select all" must not quietly enrol the whole school. */
  function toggleAllVisible() {
    const visible = pool.map((r) => r.id);
    const allOn = visible.length > 0 && visible.every((id) => picked.has(id));
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of visible) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function submit() {
    if (!picked.size) return;
    setMsg(null);
    try {
      const r = await enrol.mutateAsync({ studentIds: [...picked], classId });
      setPicked(new Set());
      setMsg(r.skipped > 0 ? t('enrol.doneSkipped', { count: r.placed, skipped: r.skipped }) : t('enrol.done', { count: r.placed }));
      await Promise.all([utils.structure.studentsByClass.invalidate(), utils.structure.courseTree.invalidate(), utils.billing.yearGrid.invalidate()]);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const allVisiblePicked = pool.length > 0 && pool.every((r) => picked.has(r.id));

  return (
    <div className="win-content">
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{classLabel}</h2>
          <span className="chip is-muted">{t('enrol.inClass', { count: alreadyIn.length })}</span>
        </div>
        <p className="hint" style={{ marginBlockStart: 0 }}>{t('enrol.hint')}</p>

        {/* Who to choose from. "Not in a class yet" first, because that is the usual job. */}
        <div className="filter-bar" role="group" aria-label={t('enrol.scope')}>
          {(['unplaced', 'others', 'all'] as Scope[]).map((s) => (
            <button key={s} type="button" className={cn('btn btn--ghost btn--sm', scope === s && 'is-active')} aria-pressed={scope === s} onClick={() => setScope(s)}>
              {t(`enrol.scope_${s}`)} <span className="chip is-muted">{counts[s]}</span>
            </button>
          ))}
        </div>

        <div className="inline-form glass-inset" style={{ alignItems: 'end' }}>
          <div className="field" style={{ flex: 1, minWidth: '11rem' }}>
            <label className="label" htmlFor="enrol-search">{t('students.search')}</label>
            <input id="enrol-search" className="input glass-inset" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('students.searchPlaceholder')} />
          </div>
          <button type="button" className="btn btn--ghost" onClick={toggleAllVisible} disabled={!pool.length}>
            {allVisiblePicked ? t('enrol.selectNone') : t('enrol.selectAll', { count: pool.length })}
          </button>
        </div>

        {list.isLoading ? (
          <p className="empty">{t('common.loading')}</p>
        ) : pool.length === 0 ? (
          <p className="empty">{scope === 'unplaced' && counts.unplaced === 0 ? t('enrol.allPlaced') : t('students.noMatches')}</p>
        ) : (
          <ul className="pick-list">
            {pool.map((r) => {
              const age = ageFromDob(r.dob);
              return (
                <li key={r.id}>
                  <label className={cn('pick-row', picked.has(r.id) && 'is-picked')}>
                    <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                    <span className="pick-name">{r.fullName}</span>
                    {age !== null && <span className="muted">{t('enrol.ageShort', { age })}</span>}
                    {/* Where they are now, so moving a child out of another class is a deliberate act. */}
                    {r.className ? <span className="chip is-muted">{r.className}</span> : <span className="chip">{t('students.unplaced')}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className="inline-form" style={{ alignItems: 'center' }}>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={!picked.size || enrol.isPending}>
            <UserPlus size={15} /> {t('enrol.action', { count: picked.size })}
          </button>
          {msg && <p className="hint" style={{ margin: 0 }}>{msg}</p>}
        </div>
      </section>

      {alreadyIn.length > 0 && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h3 style={{ fontSize: '1rem', margin: 0 }}>{t('enrol.current')}</h3>
          </div>
          <ul className="pick-list">
            {alreadyIn.map((r) => (
              <li key={r.id}>
                <span className="pick-row is-done">
                  <Check size={14} />
                  <span className="pick-name">{r.fullName}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">{t('enrol.currentHint')}</p>
        </section>
      )}
    </div>
  );
}
