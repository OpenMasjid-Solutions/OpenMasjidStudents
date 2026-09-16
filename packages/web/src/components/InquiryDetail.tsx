// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ONE INQUIRY, in a window (0.52.0, CLAUDE.md §4a Phase 2).
 *
 * What the family wrote, where the conversation has got to, and the trail of who moved it and why.
 *
 * EVERYTHING ON THIS SCREEN WAS TYPED BY A STRANGER. React escapes text nodes, which is what makes
 * rendering it safe — and the rule worth carrying forward rather than relying on by accident is that
 * none of it may ever reach `dangerouslySetInnerHTML`, a printed document without escaping, or a
 * `title`/`href` attribute built by hand. The office's own reason on a move is the same kind of text
 * and gets the same treatment.
 *
 * The trail is read from `inquiry_events` rather than from the audit log, and §9 records why that
 * duplication exists: nothing in this app reads `audit_log`, so a history an office actually opens
 * needs a table with a reader. One function writes both, so they cannot disagree.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ClipboardList, Copy, GraduationCap, Mail, MessageSquare, Phone, School, Trash2, User } from 'lucide-react';
import { trpc, type RouterOutputs } from '../lib/trpc';
import { formatDate } from '../lib/dates';
import { AdmitInquiry } from './AdmitInquiry';
import { useWindows } from './Windows';

type NextState = RouterOutputs['admissions']['get']['next'][number];

export function InquiryDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.admissions.get.useQuery({ id });
  const display = trpc.settings.display.useQuery();
  const schools = trpc.structure.schoolList.useQuery();
  const years = trpc.structure.schoolYearList.useQuery({});
  const move = trpc.admissions.transition.useMutation();
  const assign = trpc.admissions.assign.useMutation();
  const remove = trpc.admissions.remove.useMutation();
  const startAdmission = trpc.admissions.admissionStart.useMutation();
  const proposal = trpc.admissions.admissionProposal.useQuery({ id });
  const { closeByKey } = useWindows();

  const [reason, setReason] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [link, setLink] = useState<{ token: string; url: string } | null>(null);
  /** Field keys the office has struck off the family's form. Rejecting is the exception, so the set
   *  holds what is REFUSED rather than what is kept — an empty set means "approve what they sent". */
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');

  if (q.isLoading || !q.data) return <p className="empty">{t('common.loading')}</p>;
  const { inquiry, events, next } = q.data;
  const dateFmt = display.data?.dateFormat ?? 'iso';

  async function go(to: NextState) {
    setErr('');
    try {
      // The office's own words travel with the move, which is what makes the trail worth reading —
      // "declined" on its own answers nobody's question three months later.
      await move.mutateAsync({ id, to, reason: reason.trim() || undefined, waitlistReason: to === 'waitlisted' ? reason.trim() || undefined : undefined });
      setReason('');
      await Promise.all([utils.admissions.get.invalidate({ id }), utils.admissions.list.invalidate()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function issueLink() {
    setErr('');
    try {
      const r = await startAdmission.mutateAsync({ id });
      setLink({ token: r.token, url: r.url });
      await Promise.all([utils.admissions.get.invalidate({ id }), utils.admissions.list.invalidate()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function toggleReject(key: string) {
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function erase() {
    setErr('');
    try {
      await remove.mutateAsync({ id });
      await utils.admissions.list.invalidate();
      // The record it was showing no longer exists, so the window goes with it rather than sitting
      // there rendering a stale copy of something an office just deleted.
      closeByKey(`inquiry:${id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function setScope(patch: { schoolId?: string | null; schoolYearId?: string | null }) {
    setErr('');
    try {
      await assign.mutateAsync({ id, ...patch });
      await Promise.all([utils.admissions.get.invalidate({ id }), utils.admissions.list.invalidate()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="win-content">
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{inquiry.childName}</h2>
          <span className="spacer" />
          {/* `new` draws no tag — see db/schema.ts's InquiryState. An inquiry nobody has touched yet is
              the ordinary case and labelling it is what made this screen noisy. */}
          {inquiry.state !== 'new' && <span className="chip">{t(`admissions.state.${inquiry.state}`)}</span>}
          {inquiry.waitlistPosition != null && <span className="chip is-muted">#{inquiry.waitlistPosition}</span>}
        </div>
        <p className="muted" style={{ fontSize: '0.9rem', margin: 0 }}>
          {t(`admissions.source.${inquiry.source}`)} · {formatDate(new Date(inquiry.createdAt).toISOString().slice(0, 10), dateFmt)}
          {inquiry.childDob ? <> · {t('directory.dob')}: {formatDate(inquiry.childDob, dateFmt)}</> : null}
        </p>
      </section>

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('admissions.whatTheyWrote')}</h2>
        </div>
        {/* `data-list`, never `picker-list`: the latter is `position: absolute` and painted this list
            on top of the section below it (admin.css, and 0.52.0-dev.11's changelog entry). */}
        <ul className="data-list">
          <li>
            <User size={13} /> <span className="muted">{t('admissions.parentName')}</span> <span className="spacer" /> <span className="data-value">{inquiry.parentName}</span>
          </li>
          {inquiry.email && (
            <li>
              <Mail size={13} /> <span className="muted">{t('admissions.email')}</span> <span className="spacer" /> <span className="data-value">{inquiry.email}</span>
            </li>
          )}
          {inquiry.phone && (
            <li>
              <Phone size={13} /> <span className="muted">{t('admissions.phone')}</span> <span className="spacer" /> <span className="data-value">{inquiry.phone}</span>
            </li>
          )}
          {inquiry.askedAbout && (
            <li>
              <School size={13} /> <span className="muted">{t('admissions.askedAbout')}</span> <span className="spacer" /> <span className="data-value">{inquiry.askedAbout}</span>
            </li>
          )}
        </ul>
        {inquiry.message && (
          <>
            <p className="label" style={{ marginBlockStart: '0.8rem' }}>
              <MessageSquare size={13} /> {t('admissions.message')}
            </p>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{inquiry.message}</p>
          </>
        )}
      </section>

      {/* Which program and which year — the office's judgement, made here. The public form never sets
          either: a stranger choosing a school by id would be a way to learn which ids are real. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('admissions.scope')}</h2>
        </div>
        <p className="hint">{t('admissions.scopeHint')}</p>
        <div className="inline-form">
          <div className="field" style={{ flex: '1 1 12rem' }}>
            <label className="label" htmlFor="inq-school">{t('admissions.school')}</label>
            <select id="inq-school" className="input glass-inset" value={inquiry.schoolId ?? ''} onChange={(e) => void setScope({ schoolId: e.target.value || null })}>
              <option value="">{t('admissions.notSet')}</option>
              {(schools.data?.schools ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 12rem' }}>
            <label className="label" htmlFor="inq-year">{t('admissions.year')}</label>
            <select id="inq-year" className="input glass-inset" value={inquiry.schoolYearId ?? ''} onChange={(e) => void setScope({ schoolYearId: e.target.value || null })}>
              <option value="">{t('admissions.notSet')}</option>
              {(years.data ?? []).map((y) => (
                <option key={y.id} value={y.id}>{y.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('admissions.move')}</h2>
        </div>
        {next.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('admissions.terminal')}</p>
        ) : (
          <>
            <div className="field">
              <label className="label" htmlFor="inq-reason">{t('admissions.reason')}</label>
              <input id="inq-reason" className="input glass-inset" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('admissions.reasonHint')} />
            </div>
            <div className="inline-form" style={{ marginBlockStart: '0.6rem' }}>
              {next.map((s) => (
                <button key={s} type="button" className="btn btn--ghost btn--sm" disabled={move.isPending} onClick={() => void go(s)}>
                  {t(`admissions.moveTo.${s}`)}
                </button>
              ))}
            </div>
          </>
        )}
        {err && <p className="form-error">{err}</p>}
      </section>

      {/* ── THE ADMISSION FORM: issue it, then read back what the family sent ──────────────────
          Sits ABOVE the admit panel because that is the order it happens in: send the form, read the
          answers, then admit. An office that would rather type everything in themselves can still
          skip straight to the panel below — the form is an offer, not a gate. */}
      {next.length > 0 && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><ClipboardList size={15} /> {t('admissions.formTitle')}</h2>
          </div>
          <p className="hint">{t('admissions.formHint')}</p>
          <button type="button" className="btn btn--ghost btn--sm" disabled={startAdmission.isPending} onClick={() => void issueLink()}>
            {inquiry.state === 'admission' ? t('admissions.formNewLink') : t('admissions.formSend')}
          </button>

          {/* Shown ONCE — the token is stored hashed, so closing this without copying means minting a
              new one. Same rule, and the same sentence, as the re-admission link box. */}
          {link && (
            <>
              <div className="inline-form" style={{ alignItems: 'center', marginBlockStart: '0.7rem' }}>
                <input className="input glass-inset" readOnly value={link.url || link.token} style={{ flex: '2 1 20rem' }} />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard?.writeText(link.url || link.token)}>
                  <Copy size={13} /> {t('common.copy')}
                </button>
              </div>
              {!link.url && <p className="notice">{t('admissions.formNoUrl')}</p>}
              <p className="hint">{t('admissions.formLinkHint')}</p>
            </>
          )}

          {/* What came back. It has changed nothing yet — it is a proposal sitting on the inquiry
              until the admit button below writes it. */}
          {proposal.data?.submitted && (
            <>
              <p className="label" style={{ marginBlockStart: '1rem' }}>{t('admissions.formAnswers')}</p>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('admissions.formField')}</th>
                      <th>{t('admissions.formAnswer')}</th>
                      <th>{t('admissions.formUse')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.data.fields
                      .filter((f) => (proposal.data!.answers[f.key] ?? '').length > 0)
                      .map((f) => (
                        <tr key={f.key}>
                          <td>
                            {f.label}
                            {/* A note about a child's allergy should not look like a note about their
                                previous school. */}
                            {f.medical && <> <span className="chip is-muted">{t('admissions.formMedical')}</span></>}
                          </td>
                          <td style={{ whiteSpace: 'pre-wrap' }}>{proposal.data!.answers[f.key]}</td>
                          <td>
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                              <input type="checkbox" checked={!rejected.has(f.key)} onChange={() => toggleReject(f.key)} />
                              <span className="muted">{rejected.has(f.key) ? t('admissions.formSkip') : t('admissions.formKeep')}</span>
                            </label>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">{t('admissions.formApplyHint')}</p>
            </>
          )}
        </section>
      )}

      {/* Admitting is its own panel rather than another button in the row above, because it is the one
          action here that CREATES something — a household, a child, a Student ID and a charge — and
          the others only move a record along. It is hidden once the state is terminal. */}
      {next.length > 0 && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><GraduationCap size={15} /> {t('admissions.admitTitle')}</h2>
          </div>
          <p className="hint">{t('admissions.admitHint')}</p>
          <AdmitInquiry
            id={id}
            rejectFields={[...rejected]}
            onAdmitted={() => {
              void utils.admissions.get.invalidate({ id });
              void utils.admissions.admissionProposal.invalidate({ id });
            }}
          />
        </section>
      )}

      {/* DELETING IS NOT A MOVE, so it is not a fifth button in the row above. It destroys the record
          and its trail, and the confirmation is a step rather than a dialog because a dialog on a
          destructive action in a window that can be behind another window is a dialog people dismiss
          without reading (§15). An admitted inquiry has no delete at all — the server refuses it, and
          offering a button that always fails is worse than not offering one. */}
      {inquiry.state !== 'admitted' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2><Trash2 size={15} /> {t('admissions.deleteTitle')}</h2>
          </div>
          {!confirmDelete ? (
            <>
              <p className="hint">{t('admissions.deleteHint')}</p>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(true)}>
                {t('admissions.delete')}
              </button>
            </>
          ) : (
            <>
              <p className="hint">{t('admissions.deleteConfirm', { name: inquiry.childName })}</p>
              <div className="inline-form">
                <button type="button" className="btn btn--danger btn--sm" disabled={remove.isPending} onClick={() => void erase()}>
                  {t('admissions.deleteYes')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={remove.isPending} onClick={() => setConfirmDelete(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><CalendarDays size={15} /> {t('admissions.trail')}</h2>
        </div>
        <ul className="data-list">
          {events.map((e) => (
            <li key={e.id} style={{ display: 'block' }}>
              <p style={{ margin: 0 }}>
                {e.fromState ? t('admissions.movedFromTo', { from: t(`admissions.state.${e.fromState}`), to: t(`admissions.state.${e.toState}`) }) : t('admissions.arrived')}
              </p>
              {e.reason && <p style={{ margin: '0.2rem 0 0', whiteSpace: 'pre-wrap' }}>{e.reason}</p>}
              <p className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0' }}>
                {e.actorName ?? t('admissions.someone')} · {formatDate(new Date(e.createdAt).toISOString().slice(0, 10), dateFmt)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
