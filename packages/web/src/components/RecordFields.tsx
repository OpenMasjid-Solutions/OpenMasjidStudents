// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ONE renderer for a record field, shared by the child's record and the household's (0.52.0-dev.4).
 *
 * The server decides what a field IS (`people/fields.ts` — whether it exists, whether the office
 * switched it off, which role may see it, and now whether it belongs to the child or the household).
 * This decides how one looks, once, so the two panels cannot drift into rendering a date differently
 * or disagreeing about what an empty flag means.
 */
import type { TFunction } from 'i18next';

export type FieldKind = 'text' | 'longtext' | 'date' | 'flag';
export interface FieldSpec {
  key: string;
  kind: FieldKind;
  sensitivity: 'ordinary' | 'medical';
}

/** A form value. `null` is a flag's third state — nobody has asked yet — and is not the same as "no". */
export type FieldValue = string | boolean | null;

/** The draft a panel edits, seeded from a row the server sent. */
export function seedDraft(row: Record<string, unknown> | null | undefined, specs: FieldSpec[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of specs) {
    const v = row?.[f.key];
    out[f.key] = f.kind === 'flag' ? (typeof v === 'boolean' ? v : null) : ((v as string | null) ?? '');
  }
  return out;
}

/** Only what differs from the server's row — so an untouched panel produces no write and no audit row. */
export function changedFields(row: Record<string, unknown> | null | undefined, specs: FieldSpec[], draft: Record<string, FieldValue>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of specs) {
    const was = row?.[f.key];
    const now = draft[f.key];
    const same = f.kind === 'flag' ? (typeof was === 'boolean' ? was : null) === now : ((was as string | null) ?? '') === now;
    if (!same) out[f.key] = now;
  }
  return out;
}

export function FieldInput({
  spec,
  value,
  onChange,
  readOnly,
  idPrefix,
  t,
}: {
  spec: FieldSpec;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  readOnly: boolean;
  idPrefix: string;
  t: TFunction;
}) {
  const id = `${idPrefix}-${spec.key}`;
  if (spec.kind === 'flag') {
    return (
      <select
        id={id}
        className="input glass-inset"
        disabled={readOnly}
        value={value === true ? 'yes' : value === false ? 'no' : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}
      >
        {/* Blank is listed first and it is the honest default: "not recorded" is a real answer, and
            defaulting a consent question to No would be a claim nobody made. */}
        <option value="">{t('record.notRecorded')}</option>
        <option value="yes">{t('common.yes')}</option>
        <option value="no">{t('common.no')}</option>
      </select>
    );
  }
  if (spec.kind === 'longtext') {
    return <textarea id={id} className="input glass-inset" rows={3} disabled={readOnly} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  // A date input always speaks ISO on the wire whatever the browser shows, which is what the server
  // wants (§9: stored ISO, displayed otherwise).
  return (
    <input
      id={id}
      type={spec.kind === 'date' ? 'date' : 'text'}
      className="input glass-inset"
      disabled={readOnly}
      value={(value as string) ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The fields of one group, laid out — long text takes a full row, everything else shares one. */
export function FieldGrid({
  specs,
  draft,
  setDraft,
  readOnly,
  idPrefix,
  t,
}: {
  specs: FieldSpec[];
  draft: Record<string, FieldValue>;
  setDraft: (d: Record<string, FieldValue>) => void;
  readOnly: boolean;
  idPrefix: string;
  t: TFunction;
}) {
  return (
    <div className="inline-form">
      {specs.map((f) => (
        <div className="field" key={f.key} style={{ flex: f.kind === 'longtext' ? '1 1 100%' : '1 1 14rem' }}>
          <label className="label" htmlFor={`${idPrefix}-${f.key}`}>{t(`record.field.${f.key}`)}</label>
          <FieldInput spec={f} value={draft[f.key]} onChange={(v) => setDraft({ ...draft, [f.key]: v })} readOnly={readOnly} idPrefix={idPrefix} t={t} />
        </div>
      ))}
    </div>
  );
}
