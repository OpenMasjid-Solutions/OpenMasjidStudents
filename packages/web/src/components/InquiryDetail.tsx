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
import { CalendarDays, Mail, MessageSquare, Phone, School, User } from 'lucide-react';
import { trpc, type RouterOutputs } from '../lib/trpc';
import { formatDate } from '../lib/dates';

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

  const [reason, setReason] = useState('');
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
          <span className="chip">{t(`admissions.state.${inquiry.state}`)}</span>
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
        <ul className="picker-list">
          <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0.6rem' }}>
            <User size={13} /> <span className="muted">{t('admissions.parentName')}</span> <span className="spacer" /> {inquiry.parentName}
          </li>
          {inquiry.email && (
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0.6rem' }}>
              <Mail size={13} /> <span className="muted">{t('admissions.email')}</span> <span className="spacer" /> {inquiry.email}
            </li>
          )}
          {inquiry.phone && (
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0.6rem' }}>
              <Phone size={13} /> <span className="muted">{t('admissions.phone')}</span> <span className="spacer" /> {inquiry.phone}
            </li>
          )}
          {inquiry.askedAbout && (
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.4rem 0.6rem' }}>
              <School size={13} /> <span className="muted">{t('admissions.askedAbout')}</span> <span className="spacer" /> {inquiry.askedAbout}
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

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><CalendarDays size={15} /> {t('admissions.trail')}</h2>
        </div>
        <ul className="picker-list">
          {events.map((e) => (
            <li key={e.id} style={{ display: 'block', padding: '0.5rem 0.6rem' }}>
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
