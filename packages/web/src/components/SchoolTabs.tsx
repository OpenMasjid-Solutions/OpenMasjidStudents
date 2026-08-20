// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The school switcher (0.47.0) — and the one place that remembers which school is being looked at.
 *
 * A masjid may run a maktab on a Sep→Jun calendar beside a hifz program that runs year-round. Each
 * has its own school year and its own classes, so the Students, Year and Structure tabs all need to
 * know which one you mean, and they need to AGREE: switching to the hifz program on Students and
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
  /** The first school, used as the fallback by screens that cannot show "all" (see below). */
  firstId: string;
}

const Ctx = createContext<SchoolCtx>({ schoolId: '', setSchoolId: () => {}, multi: false, schools: [], arg: undefined, firstId: '' });

export function useSchool(): SchoolCtx {
  return useContext(Ctx);
}

/**
 * For screens where "all schools" is not a coherent view, and would be a lie if offered.
 *
 * The year grid is ONE school year laid out as months — and each school has its own year, starting in
 * a different month and running a different length, so there is no set of columns that could show
 * both. Structure is the same in the other direction: it configures a school's calendar and its course
 * tree, and "all" would mean editing something that belongs to nobody.
 *
 * Resolved LOCALLY rather than by writing back to the provider. Falling back to the first school when
 * the shared selection is "all" means visiting Year does not silently change what the Students tab
 * shows when you go back to it — the screens disagree about what "all" means, which is exactly why
 * this is per screen, and neither should be able to reach over and edit the other's view.
 */
export function useRequiredSchool(): { schoolId: string; arg: string | undefined } {
  const { schoolId, firstId } = useContext(Ctx);
  const effective = schoolId || firstId;
  return { schoolId: effective, arg: effective || undefined };
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
    return { schoolId: live, setSchoolId, multi, schools, arg: live || undefined, firstId: schools[0]?.id ?? '' };
  }, [list.data, schoolId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The tab strip. Renders nothing at all unless there is more than one school, so every screen can
 * include it unconditionally.
 *
 * `requireOne` drops the "All schools" tab for the screens where that view cannot exist — the year
 * grid (each school has its own year, so there is no shared set of month columns) and Structure
 * (which configures one school's calendar and courses). Offering a button that could only produce a
 * misleading page is worse than not offering it. Those screens then read the selection through
 * `useRequiredSchool`, which falls back to the first school.
 */
export function SchoolTabs({ requireOne = false }: { requireOne?: boolean } = {}) {
  const { t } = useTranslation();
  const { schoolId, setSchoolId, multi, schools, firstId } = useSchool();
  if (!multi) return null;
  // With no "All" tab, the highlighted one has to be the school actually being shown, which is the
  // same fallback `useRequiredSchool` applies — otherwise nothing would look selected.
  const active = requireOne ? schoolId || firstId : schoolId;
  return (
    <div className="filter-bar no-print" role="group" aria-label={t('school.switch')}>
      {!requireOne && (
        <button
          type="button"
          className={cn('btn btn--ghost btn--sm', active === '' && 'is-active')}
          aria-pressed={active === ''}
          onClick={() => setSchoolId('')}
        >
          {t('school.all')}
        </button>
      )}
      {schools.map((s) => (
        <button
          key={s.id}
          type="button"
          className={cn('btn btn--ghost btn--sm', active === s.id && 'is-active')}
          aria-pressed={active === s.id}
          onClick={() => setSchoolId(s.id)}
        >
          {s.name}
        </button>
      ))}
    </div>
  );
}
