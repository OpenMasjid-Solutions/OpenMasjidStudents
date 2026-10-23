// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHICH FIELDS THIS MADRASAH KEEPS about a child (0.52.0, CLAUDE.md §4a Phase 1).
 *
 * A fixed catalog with switches — **not** user-defined custom fields, which stay out of scope (§4 ❌):
 * a masjid adding its own columns is a different product with a different validation, import, export
 * and privacy story. The catalog, the defaults and the role allow-list all live server-side in
 * `people/fields.ts`; this panel renders what that returns and never holds a copy.
 *
 * Two things this screen has to say out loud, because getting either wrong is how an office is
 * surprised by its own data:
 *
 *  1. **The medical fields are different.** §14 read "no medical fields" for the life of the project
 *     and was amended on conditions — admin only, off until asked for, never parent-facing, never in a
 *     log or an alert. So they are grouped separately and the conditions are printed beside them,
 *     rather than being three more rows in a list of eleven.
 *  2. **Switching a field off HIDES it, it does not erase it.** `holdsData` comes back per field so
 *     this can say which ones actually have something in them, and the confirmation names it. An
 *     office that believes "off" means "deleted" has made a data decision it did not intend.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stethoscope } from 'lucide-react';
import { trpc } from '../lib/trpc';

export function StudentFieldsSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.people.studentFieldsGet.useQuery();
  const save = trpc.people.studentFieldsSet.useMutation();
  const [on, setOn] = useState<Set<string> | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (q.data && on === null) setOn(new Set(q.data.fields.filter((f) => f.enabled).map((f) => f.key)));
  }, [q.data, on]);

  if (!q.data || on === null) return <p className="muted" style={{ fontSize: '0.9rem' }}>{t('common.loading')}</p>;

  const fields = q.data.fields;

  /**
   * Toggling OFF a field that holds data asks first, and the question names the field.
   *
   * The dialog says what will actually happen (§15) — hidden, not erased — because the two are
   * genuinely different and the word "off" does not distinguish them.
   */
  function toggle(key: string, enabled: boolean, holdsData: boolean) {
    if (!enabled && holdsData && !window.confirm(t('settings.fieldsHideConfirm', { field: t(`record.field.${key}`) }))) return;
    const next = new Set(on!);
    if (enabled) next.add(key);
    else next.delete(key);
    setOn(next);
    setMsg('');
  }

  async function submit() {
    setMsg('');
    try {
      await save.mutateAsync({ keys: [...on!] });
      await Promise.all([utils.people.studentFieldsGet.invalidate(), utils.people.studentGet.invalidate(), utils.people.familyGet.invalidate()]);
      setMsg(t('settings.fieldsSaved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const row = (f: (typeof fields)[number]) => (
    <label key={f.key} className="check" style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', padding: '0.25rem 0' }}>
      <input type="checkbox" checked={on!.has(f.key)} onChange={(e) => toggle(f.key, e.target.checked, f.holdsData)} />
      <span>
        {t(`record.field.${f.key}`)}
        {/* Only said when it is true, and only for a field being kept: "nothing recorded yet" is noise. */}
        {f.holdsData && !on!.has(f.key) && <span className="chip is-muted" style={{ marginInlineStart: '0.4rem' }}>{t('settings.fieldsHolds')}</span>}
      </span>
    </label>
  );

  const ordinary = fields.filter((f) => f.sensitivity === 'ordinary');
  const medical = fields.filter((f) => f.sensitivity === 'medical');
  const dirty = fields.some((f) => f.enabled !== on.has(f.key));

  return (
    <>
      <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.fieldsHint')}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.1rem 1rem' }}>{ordinary.map(row)}</div>

      {medical.length > 0 && (
        <div className="glass-inset" style={{ padding: '0.75rem 0.9rem', marginBlockStart: '0.9rem', borderRadius: '0.6rem' }}>
          <h3 style={{ margin: '0 0 0.35rem', fontSize: '0.95rem' }}>
            <Stethoscope size={14} /> {t('record.medical')}
          </h3>
          <p className="hint" style={{ marginBlockStart: 0 }}>{t('settings.fieldsMedicalHint')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.1rem 1rem' }}>{medical.map(row)}</div>
        </div>
      )}

      <div className="inline-form" style={{ alignItems: 'center', marginBlockStart: '0.8rem' }}>
        <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={save.isPending || !dirty}>
          {t('common.save')}
        </button>
        {msg && <span className="notice" style={{ margin: 0 }}>{msg}</span>}
      </div>
    </>
  );
}
