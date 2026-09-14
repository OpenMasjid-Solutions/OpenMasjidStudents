// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ONE CHILD'S RECORD — the screen that did not exist (0.52.0, CLAUDE.md §4a Phase 1).
 *
 * Until now `studentUpdate` had exactly ONE call site in the whole web app — the withdraw toggle on the
 * household window — and `students.notes` was written by two paths and rendered by none. A column with
 * no read surface is what twelve more of them would have become, so the screen is the work; the fields
 * are the easy half.
 *
 * ── The server decides what this renders, and that is the point ──────────────
 *
 * `people.studentGet` returns `fields`: the fields THIS caller may see, already filtered for what the
 * office switched off and for the role's own allow-list (`people/fields.ts`, §5's medical wall). This
 * component never holds its own list of fields and never decides who may see one — it renders what came
 * back. Two consequences worth keeping:
 *
 *   - a field added to the registry appears here with no change to this file, and
 *   - finance is not shown a medical box it would be refused on saving, because finance was not told
 *     the field exists. The old failure mode was the opposite: the finance shell renders the SAME
 *     household component the admin shell does, with a `readOnly` prop that only ever wrapped buttons.
 *
 * Notes are admin-only and APPEND-ONLY (`people/notes.ts`): there is no edit and no delete, because a
 * note is often the record of what somebody was told. A correction is another note.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotebookPen, Save, Stethoscope } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatDate } from '../lib/dates';

/** What the server says a field is. Mirrors `people/fields.ts`; the values come from it at runtime. */
type FieldKind = 'text' | 'longtext' | 'date' | 'flag';
type FieldSpec = { key: string; kind: FieldKind; sensitivity: 'ordinary' | 'medical' };

/** A form value. `null` is a flag's third state — nobody has asked yet — and is not the same as "no". */
type Value = string | boolean | null;

export function StudentRecord({ studentId, readOnly = false }: { studentId: string; readOnly?: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.people.studentGet.useQuery({ id: studentId });
  const display = trpc.settings.display.useQuery();
  const save = trpc.people.studentUpdate.useMutation();
  const addNote = trpc.people.studentNoteAdd.useMutation();

  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState('');

  /**
   * Seed the form from the server's answer, once it arrives and whenever it changes underneath us.
   *
   * Keyed on `updatedAt` rather than on the query object: a refetch that returns the same record must
   * not throw away what the office is halfway through typing.
   */
  const stamp = (q.data?.student as Record<string, unknown> | undefined)?.updatedAt;
  useEffect(() => {
    if (!q.data) return;
    const row = q.data.student as Record<string, unknown>;
    const next: Record<string, Value> = {};
    for (const f of q.data.fields as FieldSpec[]) {
      const v = row[f.key];
      next[f.key] = f.kind === 'flag' ? (typeof v === 'boolean' ? v : null) : ((v as string | null) ?? '');
    }
    setDraft(next);
  }, [q.data, stamp]);

  if (q.isLoading || !q.data) return <p className="empty">{t('common.loading')}</p>;

  const row = q.data.student as Record<string, unknown>;
  const fields = q.data.fields as FieldSpec[];
  const dateFmt = display.data?.dateFormat ?? 'iso';

  /** Only what actually changed, so an untouched record produces no write and no audit row. */
  function changed(): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const f of fields) {
      const was = row[f.key];
      const now = draft[f.key];
      const same = f.kind === 'flag' ? (typeof was === 'boolean' ? was : null) === now : ((was as string | null) ?? '') === now;
      if (!same) out[f.key] = now;
    }
    return out;
  }

  async function submit() {
    setErr('');
    setSaved(false);
    const fieldsChanged = changed();
    if (Object.keys(fieldsChanged).length === 0) return;
    try {
      await save.mutateAsync({ id: studentId, fields: fieldsChanged });
      await Promise.all([utils.people.studentGet.invalidate({ id: studentId }), utils.people.familyGet.invalidate()]);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function submitNote() {
    const body = note.trim();
    if (!body) return;
    setErr('');
    try {
      await addNote.mutateAsync({ studentId, body });
      setNote('');
      await utils.people.studentGet.invalidate({ id: studentId });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const medical = fields.filter((f) => f.sensitivity === 'medical');
  const ordinary = fields.filter((f) => f.sensitivity === 'ordinary');

  const input = (f: FieldSpec) => {
    const id = `sr-${f.key}`;
    const v = draft[f.key];
    if (f.kind === 'flag') {
      return (
        <select
          id={id}
          className="input glass-inset"
          disabled={readOnly}
          value={v === true ? 'yes' : v === false ? 'no' : ''}
          onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value === '' ? null : e.target.value === 'yes' })}
        >
          {/* Blank is the honest default and it is listed first: "not recorded" is a real answer, and
              defaulting a consent question to No would be a claim nobody made. */}
          <option value="">{t('record.notRecorded')}</option>
          <option value="yes">{t('common.yes')}</option>
          <option value="no">{t('common.no')}</option>
        </select>
      );
    }
    if (f.kind === 'longtext') {
      return <textarea id={id} className="input glass-inset" rows={3} disabled={readOnly} value={(v as string) ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />;
    }
    // A date input always speaks ISO on the wire whatever the browser shows, which is exactly what the
    // server wants (§9: stored ISO, displayed otherwise).
    return (
      <input
        id={id}
        type={f.kind === 'date' ? 'date' : 'text'}
        className="input glass-inset"
        disabled={readOnly}
        value={(v as string) ?? ''}
        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
      />
    );
  };

  const group = (title: string, list: FieldSpec[], note?: string) =>
    list.length === 0 ? null : (
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{title}</h2>
        </div>
        {note && <p className="hint">{note}</p>}
        <div className="inline-form">
          {list.map((f) => (
            <div className="field" key={f.key} style={{ flex: f.kind === 'longtext' ? '1 1 100%' : '1 1 14rem' }}>
              <label className="label" htmlFor={`sr-${f.key}`}>{t(`record.field.${f.key}`)}</label>
              {input(f)}
            </div>
          ))}
        </div>
      </section>
    );

  return (
    <div className="win-content">
      {/* The identity line: what this child IS, above anything editable. The Student ID is here because
          it is the thing an office is most often asked to read out, and it is not a secret (§14). */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{String(row.fullName ?? '')}</h2>
          <span className="spacer" />
          {row.status === 'withdrawn' ? <span className="chip is-muted">{t('directory.withdrawn')}</span> : <span className="chip">{t('directory.active')}</span>}
        </div>
        <p className="muted" style={{ fontSize: '0.9rem', margin: 0 }}>
          <span className="code">{(row.studentCode as string) ?? '—'}</span>
          {row.dob ? <> · {t('directory.dob')}: {formatDate(row.dob as string, dateFmt)}</> : null}
          {q.data.family ? <> · {q.data.family.name}</> : null}
        </p>
      </section>

      {group(t('record.details'), ordinary)}

      {/* Medical is its own panel and says so, rather than being eight boxes down a long form. §14
          amended "no medical fields" on the condition that this is admin-only and off until an office
          asks for it — a reader who lands here should be able to see that it is a different kind of
          thing. Finance is never TOLD these fields exist, so this renders for nobody else. */}
      {medical.length > 0 && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><Stethoscope size={15} /> {t('record.medical')}</h2>
          </div>
          <p className="hint">{t('record.medicalHint')}</p>
          <div className="inline-form">
            {medical.map((f) => (
              <div className="field" key={f.key} style={{ flex: f.kind === 'longtext' ? '1 1 100%' : '1 1 14rem' }}>
                <label className="label" htmlFor={`sr-${f.key}`}>{t(`record.field.${f.key}`)}</label>
                {input(f)}
              </div>
            ))}
          </div>
        </section>
      )}

      {fields.length === 0 && <p className="empty">{t('record.noFields')}</p>}

      {!readOnly && fields.length > 0 && (
        <div className="inline-form" style={{ alignItems: 'center' }}>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={save.isPending || Object.keys(changed()).length === 0}>
            <Save size={14} /> {t('common.save')}
          </button>
          {saved && <span className="notice notice--ok" style={{ margin: 0 }}>{t('record.saved')}</span>}
        </div>
      )}
      {err && <p className="form-error">{err}</p>}

      {/* Notes. Admin only — the server returns an empty list to finance, so this whole panel is absent
          for them rather than empty. */}
      {!readOnly && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><NotebookPen size={15} /> {t('record.notes')}</h2>
          </div>
          <p className="hint">{t('record.notesHint')}</p>
          <div className="inline-form">
            <div className="field" style={{ flex: '1 1 100%' }}>
              <label className="label" htmlFor="sr-note">{t('record.addNote')}</label>
              <textarea id="sr-note" className="input glass-inset" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button type="button" className="btn btn--ghost" onClick={submitNote} disabled={addNote.isPending || !note.trim()}>
              {t('record.saveNote')}
            </button>
          </div>
          {q.data.notes.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.9rem' }}>{t('record.noNotes')}</p>
          ) : (
            <ul className="picker-list">
              {q.data.notes.map((n) => (
                <li key={n.id} style={{ display: 'block', padding: '0.5rem 0.6rem' }}>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.body}</p>
                  <p className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0' }}>
                    {n.authorName} · {formatDate(new Date(n.createdAt).toISOString().slice(0, 10), dateFmt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
