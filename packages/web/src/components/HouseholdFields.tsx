// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE HOUSEHOLD'S OWN DETAILS — address, languages spoken, nationality (0.52.0-dev.4).
 *
 * They were on the CHILD for one release and moved here on Hasan's correction: a family shares all
 * three, so per-child meant three copies that drift and an office correcting an address had to
 * remember how many children were on the record. Same rule guardians and emergency contacts have
 * always followed (§9) — which is also why linking a sibling is what makes them apply.
 *
 * Rendered in BOTH windows — the household record and a child's record — because an office looking at
 * a child is exactly who needs to correct an address, and making them navigate elsewhere is how a
 * correction does not get made. One component and one mutation (`people.familyUpdate`), so "the same
 * field in two places" is one field shown twice rather than two code paths that can disagree. The
 * panel says the value applies to every child on the record, because it does.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Home, Save } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { FieldGrid, changedFields, seedDraft, type FieldSpec, type FieldValue } from './RecordFields';

export function HouseholdFields({
  familyId,
  family,
  fields,
  readOnly = false,
  onSaved,
}: {
  familyId: string;
  family: Record<string, unknown> | null | undefined;
  fields: FieldSpec[];
  readOnly?: boolean;
  onSaved?: () => void | Promise<unknown>;
}) {
  const { t } = useTranslation();
  const save = trpc.people.familyUpdate.useMutation();
  const [draft, setDraft] = useState<Record<string, FieldValue>>({});
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  // Re-seeded when the server's copy changes, keyed on `updated_at` rather than the object, so a
  // refetch returning the same record does not discard what the office is halfway through typing.
  const stamp = family?.updatedAt;
  useEffect(() => {
    setDraft(seedDraft(family, fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fields` is server-owned and stable per render
  }, [stamp, family]);

  if (fields.length === 0) return null;

  const changes = changedFields(family, fields, draft);

  async function submit() {
    setErr('');
    setSaved(false);
    if (Object.keys(changes).length === 0) return;
    try {
      await save.mutateAsync({ id: familyId, fields: changes });
      await onSaved?.();
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
      <div className="section-head">
        <h2><Home size={15} /> {t('record.household')}</h2>
      </div>
      <p className="hint">{t('record.householdHint')}</p>
      <FieldGrid specs={fields} draft={draft} setDraft={setDraft} readOnly={readOnly} idPrefix="hh" t={t} />
      {!readOnly && (
        <div className="inline-form" style={{ alignItems: 'center', marginBlockStart: '0.6rem' }}>
          <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={save.isPending || Object.keys(changes).length === 0}>
            <Save size={14} /> {t('common.save')}
          </button>
          {saved && <span className="notice notice--ok" style={{ margin: 0 }}>{t('record.saved')}</span>}
        </div>
      )}
      {err && <p className="form-error">{err}</p>}
    </section>
  );
}
