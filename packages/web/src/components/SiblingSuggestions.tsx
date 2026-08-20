// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "These look like siblings — shall I link them?" The step that finishes a CSV import.
 *
 * An import gives every row its own household on purpose (guessing a family from a spreadsheet and
 * getting it wrong merges two families' money). That leaves 120 children in 120 households when the
 * truth is 40 families, and until they are linked a parent gets four separate balances and four
 * separate portal invitations. So the office is shown the likely groups and confirms them here, while
 * the import is still on screen and the names still mean something.
 *
 * The design follows the strength of the evidence, because the two cases deserve different trust:
 *  - **Same phone or email** — one adult, recorded once per child. Ticked ready to go; the office
 *    glances and accepts.
 *  - **Same surname only** — a maybe. Three unrelated Ismail families in one roster is completely
 *    normal in a madrasa, so these start UNTICKED and are worded as a question.
 *
 * Nothing is ever linked without a click, and every group can be linked on its own — an office that
 * recognizes four families and is unsure about the fifth is not made to decide all five at once.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Users, Check } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatUsPhone } from '../lib/phone';
import { cn } from '../lib/cn';

export function SiblingSuggestions({ onDone, doneLabel }: { onDone?: () => void; doneLabel?: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const suggestions = trpc.people.siblingSuggestions.useQuery();
  const linkGroup = trpc.people.linkSiblingGroup.useMutation();

  /** Which students are ticked, per group. Contact groups arrive fully ticked; surname groups empty. */
  const [ticked, setTicked] = useState<Record<string, Set<string>>>({});
  /** Groups already linked in this sitting, so the list can show what was done rather than just shrink. */
  const [linked, setLinked] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const groups = suggestions.data ?? [];

  // Seed the ticks once the suggestions land. Strong evidence pre-ticked, weak evidence not — the
  // difference between "confirm this" and "have a look at this".
  //
  // It MUST return `prev` untouched when there is nothing new to seed. `groups` is a fresh array on
  // every render (`data ?? []`), so this effect runs on every render; handing back a new object each
  // time would re-render, re-run the effect, and spin forever.
  useEffect(() => {
    setTicked((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const g of suggestions.data ?? []) {
        if (next[g.key]) continue;
        next[g.key] = new Set(g.reason === 'contact' ? g.students.map((s) => s.id) : []);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [suggestions.data]);

  const counts = useMemo(
    () => ({
      contact: groups.filter((g) => g.reason === 'contact').length,
      surname: groups.filter((g) => g.reason === 'surname').length,
    }),
    [groups],
  );

  function toggle(groupKey: string, studentId: string) {
    setTicked((prev) => {
      const set = new Set(prev[groupKey] ?? []);
      if (set.has(studentId)) set.delete(studentId);
      else set.add(studentId);
      return { ...prev, [groupKey]: set };
    });
  }

  async function link(groupKey: string) {
    const ids = [...(ticked[groupKey] ?? [])];
    if (ids.length < 2) return;
    setErr(null);
    try {
      const r = await linkGroup.mutateAsync({ studentIds: ids });
      setLinked((m) => ({ ...m, [groupKey]: r.mergedGuardians > 0 ? t('siblings.linkedMerged', { count: ids.length, merged: r.mergedGuardians }) : t('siblings.linked', { count: ids.length }) }));
      await Promise.all([
        utils.people.siblingSuggestions.invalidate(),
        utils.people.directory.invalidate(),
        utils.people.studentOptions.invalidate(),
        utils.structure.studentsByClass.invalidate(),
      ]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (suggestions.isLoading) return <p className="empty">{t('common.loading')}</p>;

  const pending = groups.filter((g) => !linked[g.key]);

  return (
    <div style={{ display: 'grid', gap: '0.9rem' }}>
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><Users size={16} /> {t('siblings.title')}</h2>
          {pending.length > 0 && <span className="chip">{t('siblings.groupCount', { count: pending.length })}</span>}
        </div>

        {groups.length === 0 ? (
          <>
            <p className="hint" style={{ marginBlockStart: 0 }}>{t('siblings.none')}</p>
            {onDone && (
              <button type="button" className="btn btn--primary" onClick={onDone}>{doneLabel ?? t('siblings.finish')}</button>
            )}
          </>
        ) : (
          <>
            <p className="hint" style={{ marginBlockStart: 0 }}>{t('siblings.intro')}</p>
            {counts.contact > 0 && <p className="hint">{t('siblings.contactIntro', { count: counts.contact })}</p>}
            {counts.surname > 0 && <p className="hint">{t('siblings.surnameIntro', { count: counts.surname })}</p>}
            {err && <p className="form-error">{err}</p>}

            <div style={{ display: 'grid', gap: '0.6rem', marginBlockStart: '0.5rem' }}>
              {groups.map((g) => {
                const done = linked[g.key];
                const set = ticked[g.key] ?? new Set<string>();
                return (
                  <div key={g.key} className={cn('glass-inset sib-group', done && 'is-done')} style={{ padding: '0.7rem 0.85rem', borderRadius: 'var(--radius-card)' }}>
                    <div className="section-head" style={{ marginBlockEnd: '0.4rem' }}>
                      <h3 style={{ fontSize: '0.98rem', margin: 0 }}>
                        {g.reason === 'contact' ? t('siblings.sameContact') : t('siblings.sameSurname', { surname: g.label })}
                      </h3>
                      {/* The shared detail itself, so the office can see the evidence, not just trust it. */}
                      {g.reason === 'contact' && g.label && <span className="chip is-muted">{g.label.includes('@') ? g.label : formatUsPhone(g.label)}</span>}
                      <span className="spacer" style={{ marginInlineStart: 'auto' }} />
                      {done ? (
                        <span className="chip"><Check size={12} /> {done}</span>
                      ) : (
                        <button type="button" className="btn btn--primary btn--sm" onClick={() => void link(g.key)} disabled={set.size < 2 || linkGroup.isPending}>
                          <Link2 size={13} /> {t('siblings.linkAction', { count: set.size })}
                        </button>
                      )}
                    </div>

                    {!done && (
                      <ul className="pick-list" style={{ maxBlockSize: 'none', margin: '0.2rem 0 0' }}>
                        {g.students.map((s) => (
                          <li key={s.id}>
                            <label className={cn('pick-row', set.has(s.id) && 'is-picked')}>
                              <input type="checkbox" checked={set.has(s.id)} onChange={() => toggle(g.key, s.id)} />
                              <span className="pick-name">{s.fullName}</span>
                              {s.studentCode && <span className="code">{s.studentCode}</span>}
                              {/* Whose household it is, which is how the office recognizes the family. */}
                              {s.guardianNames.length > 0 && <span className="muted">{s.guardianNames.join(', ')}</span>}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>

            {onDone && (
              <div className="inline-form" style={{ marginBlockStart: '0.8rem' }}>
                <button type="button" className="btn btn--ghost" onClick={onDone}>{doneLabel ?? t('siblings.finish')}</button>
                <p className="hint" style={{ margin: 0 }}>{t('siblings.laterHint')}</p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
