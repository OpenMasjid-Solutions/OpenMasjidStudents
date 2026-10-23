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
 * `people.studentGet` returns `fields`: what THIS caller may see of the child, already filtered for
 * what the office switched off and for the role's own allow-list (`people/fields.ts`, §5's medical
 * wall). This component holds no list of fields and never decides who may see one — it renders what
 * came back. Two consequences worth keeping:
 *
 *   - a field added to the registry appears here with no change to this file, and
 *   - finance is not shown a medical box it would be refused on saving, because finance was not told
 *     the field exists. The old failure mode was the opposite: the finance shell renders the SAME
 *     household component the admin shell does, with a `readOnly` prop that only ever wrapped buttons.
 *
 * **The household's own details are NOT here** (0.52.0-dev.5). Address, languages and nationality live
 * on the household record and only there — Hasan's correction after they were briefly shown on both.
 * Putting a household value on the child's screen puts it on three screens for a family of three,
 * which is the shape of the problem that moved those columns off the student to begin with. The line
 * at the top names the household; the household's record is where its details are kept.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotebookPen, Save, Stethoscope, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatDate } from '../lib/dates';
import { FieldGrid, changedFields, seedDraft, type FieldSpec, type FieldValue } from './RecordFields';

export function StudentRecord({ studentId, readOnly = false }: { studentId: string; readOnly?: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.people.studentGet.useQuery({ id: studentId });
  const display = trpc.settings.display.useQuery();
  const save = trpc.people.studentUpdate.useMutation();
  const addNote = trpc.people.studentNoteAdd.useMutation();
  const removeNote = trpc.people.studentNoteDelete.useMutation();

  const [draft, setDraft] = useState<Record<string, FieldValue>>({});
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState('');

  /**
   * Seed the form from the server's answer, once it arrives and whenever it changes underneath us.
   *
   * Keyed on `updatedAt` rather than on the query object: a refetch that returns the same record must
   * not throw away what the office is halfway through typing.
   */
  const row = q.data?.student as Record<string, unknown> | undefined;
  const stamp = row?.updatedAt;
  useEffect(() => {
    if (q.data) setDraft(seedDraft(q.data.student as Record<string, unknown>, q.data.fields as FieldSpec[]));
  }, [q.data, stamp]);

  if (q.isLoading || !q.data || !row) return <p className="empty">{t('common.loading')}</p>;

  const fields = q.data.fields as FieldSpec[];
  const dateFmt = display.data?.dateFormat ?? 'iso';
  const changes = changedFields(row, fields, draft);

  async function submit() {
    setErr('');
    setSaved(false);
    if (Object.keys(changes).length === 0) return;
    try {
      await save.mutateAsync({ id: studentId, fields: changes });
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

  /**
   * Delete one note.
   *
   * Notes still cannot be EDITED — a correction is another note — and this is the way out of a mistake
   * the first cut did not have: a note typed onto the wrong child, or one carrying something that
   * should never have been written down. It asks first, because it cannot be undone and the note is
   * somebody's record of a conversation.
   */
  async function deleteNote(id: string) {
    if (!window.confirm(t('record.confirmDeleteNote'))) return;
    setErr('');
    try {
      await removeNote.mutateAsync({ id });
      await utils.people.studentGet.invalidate({ id: studentId });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const medical = fields.filter((f) => f.sensitivity === 'medical');
  const ordinary = fields.filter((f) => f.sensitivity === 'ordinary');

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

      {ordinary.length > 0 && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('record.details')}</h2></div>
          <FieldGrid specs={ordinary} draft={draft} setDraft={setDraft} readOnly={readOnly} idPrefix="sr" t={t} />
        </section>
      )}

      {/* Medical is its own panel and says so, rather than being boxes down a long form. §14 amended
          "no medical fields" on the condition that this is admin-only and off until an office asks for
          it — a reader who lands here should be able to see that it is a different kind of thing.
          Finance is never TOLD these fields exist, so this renders for nobody else. */}
      {medical.length > 0 && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><Stethoscope size={15} /> {t('record.medical')}</h2>
          </div>
          <p className="hint">{t('record.medicalHint')}</p>
          <FieldGrid specs={medical} draft={draft} setDraft={setDraft} readOnly={readOnly} idPrefix="sr" t={t} />
        </section>
      )}

      {fields.length === 0 && <p className="empty">{t('record.noFields')}</p>}

      {!readOnly && fields.length > 0 && (
        <div className="inline-form" style={{ alignItems: 'center' }}>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={save.isPending || Object.keys(changes).length === 0}>
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
            <ul className="data-list">
              {q.data.notes.map((n) => (
                <li key={n.id} style={{ display: 'block' }}>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{n.body}</p>
                  <p className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span>{n.authorName} · {formatDate(new Date(n.createdAt).toISOString().slice(0, 10), dateFmt)}</span>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => deleteNote(n.id)} disabled={removeNote.isPending} title={t('common.delete')}>
                      <Trash2 size={13} />
                    </button>
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
