// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The school switcher (0.47.0) — and the one place that remembers which school is being looked at.
 *
 * A masjid may run a maktab on a Sep→Jun calendar beside a hifz programme that runs year-round. Each
 * has its own school year and its own classes, so the Students, Year and Structure tabs all need to
 * know which one you mean, and they need to AGREE: switching to the hifz programme on Students and
 * then opening Year must not drop you back into the maktab. Hence a context around the whole admin
 * shell rather than a piece of state per tab.
 *
 * IT DRAWS NOTHING ON A SINGLE-SCHOOL INSTALL, which is the overwhelmingly common case and the reason
 * the whole feature is safe to add. `multi` comes from the server, so one school means one row in the
 * table and no tab strip at all — an office that never adds a second school never learns the concept
 * exists.
 *
 * The selected id is deliberately NOT persisted anywhere. It is a view filter, not a preference: a
 * stale one restored from storage after a school is archived would silently show an empty roster, and
 * "which school am I in" is answered by a visible tab, not by memory.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { trpc } from '../lib/trpc';

interface SchoolCtx {
  /** The school in view, or '' for "all of them" — which is what a single-school install always is. */
  schoolId: string;
  setSchoolId: (id: string) => void;
  /** Is there more than one? Everything school-shaped in the UI hangs off this. */
  multi: boolean;
  schools: { id: string; name: string }[];
  /** What to pass to a query: `undefined` when nothing is selected, so the server applies its own scope. */
  arg: string | undefined;
}

const Ctx = createContext<SchoolCtx>({ schoolId: '', setSchoolId: () => {}, multi: false, schools: [], arg: undefined });

export function useSchool(): SchoolCtx {
  return useContext(Ctx);
}

export function SchoolProvider({ children }: { children: ReactNode }) {
  const [schoolId, setSchoolId] = useState('');
  const list = trpc.structure.schoolList.useQuery();
  const value = useMemo<SchoolCtx>(() => {
    const schools = list.data?.schools ?? [];
    const multi = !!list.data?.multi;
    // A school that vanished (archived, or the restriction changed under us) falls back to "all"
    // rather than filtering everything away and looking like an empty database.
    const live = multi && schools.some((s) => s.id === schoolId) ? schoolId : '';
    return { schoolId: live, setSchoolId, multi, schools, arg: live || undefined };
  }, [list.data, schoolId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The tab strip. Renders nothing at all unless there is more than one school, so every screen can
 * include it unconditionally.
 */
export function SchoolTabs() {
  const { t } = useTranslation();
  const { schoolId, setSchoolId, multi, schools } = useSchool();
  if (!multi) return null;
  return (
    <div className="filter-bar no-print" role="group" aria-label={t('school.switch')}>
      <button
        type="button"
        className={cn('btn btn--ghost btn--sm', schoolId === '' && 'is-active')}
        aria-pressed={schoolId === ''}
        onClick={() => setSchoolId('')}
      >
        {t('school.all')}
      </button>
      {schools.map((s) => (
        <button
          key={s.id}
          type="button"
          className={cn('btn btn--ghost btn--sm', schoolId === s.id && 'is-active')}
          aria-pressed={schoolId === s.id}
          onClick={() => setSchoolId(s.id)}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}
