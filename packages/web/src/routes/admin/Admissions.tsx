// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ADMISSIONS DESK (0.52.0, CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md).
 *
 * Who has asked about a place, where each conversation has got to, and the queue. Admin only, and
 * therefore only on the masjid network — `adminProcedure` refuses an admin session presented over
 * the tunnel, so this screen simply is not reachable from home. That is §12.4 and it is not being
 * bent to make admissions more convenient.
 *
 * **An inquiry is not a student.** Nothing on this screen has a Student ID, a balance or a fee plan,
 * and the roster does not know these children exist. That happens at conversion, which is its own
 * slice; until then this is a record of a conversation.
 *
 * The waitlist is MANUALLY ORDERED and has no capacity (decision 7): classes carry no capacity today,
 * and adding one means enforcing it in rollover, bulk class assignment and admission — three paths
 * that currently cannot fail and would all gain a new failure mode. A visible position and a reason
 * is what an office actually works from, so that is what this shows.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { ArrowDown, ArrowUp, Inbox, UserPlus } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/cn';
import { staggerContainer, staggerItem } from '../../lib/motion';
import { formatDate } from '../../lib/dates';
import { useWindows } from '../../components/Windows';
import { InquiryDetail } from '../../components/InquiryDetail';
import { Readmissions } from '../../components/Readmissions';

/** The filters, in the order an office works them: everything live, then one state at a time. */
const FILTERS = ['open', 'new', 'waitlisted', 'admission', 'declined', 'admitted'] as const;
type Filter = (typeof FILTERS)[number];

export function Admissions() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();
  const [view, setView] = useState<'inquiries' | 'readmission'>('inquiries');
  const [filter, setFilter] = useState<Filter>('open');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ childName: '', parentName: '', email: '', phone: '', askedAbout: '', message: '' });

  const list = trpc.admissions.list.useQuery({ state: filter, limit: 200 });
  const display = trpc.settings.display.useQuery();
  const add = trpc.admissions.officeAdd.useMutation();
  const reorder = trpc.admissions.waitlistReorder.useMutation();

  const dateFmt = display.data?.dateFormat ?? 'iso';
  const rows = list.data?.rows ?? [];
  const counts = list.data?.counts ?? {};

  const openInquiry = (id: string, label: string) =>
    open({ title: label, wide: true, dedupeKey: `inquiry:${id}`, icon: <Inbox size={15} />, node: <InquiryDetail id={id} /> });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const r = await add.mutateAsync({
        childName: form.childName.trim(),
        parentName: form.parentName.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        askedAbout: form.askedAbout.trim() || undefined,
        message: form.message.trim() || undefined,
      });
      setForm({ childName: '', parentName: '', email: '', phone: '', askedAbout: '', message: '' });
      setAdding(false);
      await utils.admissions.list.invalidate();
      // Said out loud rather than swallowed: the office is looking at the screen, so "you already
      // have this one" is useful here in a way it could never be on the public form.
      if (r.outcome === 'duplicate') setErr(t('admissions.alreadyHave'));
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  /** Move one place up or down the queue, by sending the whole order back. The server renumbers from
   *  1 and keeps anything this screen did not name after the rows it did. */
  async function nudge(id: string, by: -1 | 1) {
    const queue = rows.filter((r) => r.state === 'waitlisted').map((r) => r.id);
    const i = queue.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= queue.length) return;
    [queue[i], queue[j]] = [queue[j], queue[i]];
    await reorder.mutateAsync({ ids: queue });
    await utils.admissions.list.invalidate();
  }

  return (
    <div className="page">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('admissions.title')}</h1>
        <span className="chip is-muted">{t('admissions.count', { count: rows.length })}</span>
        <span className="spacer" />
        <button type="button" className="btn btn--primary" onClick={() => setAdding((v) => !v)}>
          <UserPlus size={14} /> {t('admissions.addWalkIn')}
        </button>
      </div>

      {/* Two halves of one desk: families asking for the first time, and families being asked to
          confirm another year. Different work, same fortnight, so they are one screen with a switch
          rather than two dock items competing for the same corner of an office's attention. */}
      <div className="filter-bar" role="group" aria-label={t('admissions.title')}>
        <button type="button" className={cn('btn btn--ghost btn--sm', view === 'inquiries' && 'is-active')} aria-pressed={view === 'inquiries'} onClick={() => setView('inquiries')}>
          {t('admissions.viewInquiries')}
        </button>
        <button type="button" className={cn('btn btn--ghost btn--sm', view === 'readmission' && 'is-active')} aria-pressed={view === 'readmission'} onClick={() => setView('readmission')}>
          {t('admissions.viewReadmission')}
        </button>
      </div>

      {view === 'readmission' ? (
        <Readmissions />
      ) : (
        <>
      <p className="hint">{t('admissions.intro')}</p>

      {adding && (
        <form className="inline-form glass-inset" onSubmit={submit}>
          <div className="field" style={{ flex: '2 1 14rem' }}>
            <label className="label" htmlFor="adm-child">{t('admissions.childName')}</label>
            <input id="adm-child" className="input glass-inset" value={form.childName} onChange={(e) => setForm({ ...form, childName: e.target.value })} autoFocus required />
          </div>
          <div className="field" style={{ flex: '2 1 14rem' }}>
            <label className="label" htmlFor="adm-parent">{t('admissions.parentName')}</label>
            <input id="adm-parent" className="input glass-inset" value={form.parentName} onChange={(e) => setForm({ ...form, parentName: e.target.value })} required />
          </div>
          <div className="field" style={{ flex: '1 1 12rem' }}>
            <label className="label" htmlFor="adm-email">{t('admissions.email')}</label>
            <input id="adm-email" type="email" className="input glass-inset" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '1 1 10rem' }}>
            <label className="label" htmlFor="adm-phone">{t('admissions.phone')}</label>
            <input id="adm-phone" className="input glass-inset" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '1 1 12rem' }}>
            <label className="label" htmlFor="adm-about">{t('admissions.askedAbout')}</label>
            <input id="adm-about" className="input glass-inset" value={form.askedAbout} onChange={(e) => setForm({ ...form, askedAbout: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '1 1 100%' }}>
            <label className="label" htmlFor="adm-msg">{t('admissions.message')}</label>
            <textarea id="adm-msg" className="input glass-inset" rows={2} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          </div>
          <button type="submit" className="btn btn--primary" disabled={add.isPending || !form.childName.trim() || !form.parentName.trim()}>
            {t('common.save')}
          </button>
          <p className="hint" style={{ flex: '1 1 100%', margin: 0 }}>{t('admissions.addWalkInHint')}</p>
        </form>
      )}
      {err && <p className="form-error">{err}</p>}

      <div className="filter-bar" role="group" aria-label={t('admissions.filterBy')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className={cn('btn btn--ghost btn--sm', filter === f && 'is-active')} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`admissions.filter.${f}`)}
            {f !== 'open' && counts[f] ? <span className="chip is-muted">{counts[f]}</span> : null}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <p className="empty">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="empty">{t('admissions.empty')}</p>
      ) : (
        <motion.div variants={staggerContainer} initial="initial" animate="animate">
          <motion.section className="section glass" variants={staggerItem}>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('admissions.childName')}</th>
                    <th>{t('admissions.parentName')}</th>
                    <th>{t('admissions.askedAbout')}</th>
                    <th>{t('admissions.received')}</th>
                    <th>{t('admissions.stateColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => openInquiry(r.id, r.childName)}>
                          {r.childName}
                        </button>
                      </td>
                      <td>{r.parentName}</td>
                      <td>{r.askedAbout ?? '—'}</td>
                      <td>{formatDate(new Date(r.createdAt).toISOString().slice(0, 10), dateFmt)}</td>
                      <td>
                        {/* `new` draws NO tag. An inquiry that arrived and has not been touched is the
                            ordinary case, and labelling the ordinary case is what made this board noisy
                            enough to be worth cutting (0.52.0-dev.11). */}
                        {r.state !== 'new' && (
                          <span className={cn('chip', r.state === 'declined' && 'is-muted')}>{t(`admissions.state.${r.state}`)}</span>
                        )}
                        {r.state === 'waitlisted' && (
                          <>
                            <span className="chip is-muted">#{r.waitlistPosition ?? '—'}</span>
                            <button type="button" className="btn btn--ghost btn--sm" aria-label={t('admissions.moveUp')} disabled={reorder.isPending} onClick={() => void nudge(r.id, -1)}>
                              <ArrowUp size={13} />
                            </button>
                            <button type="button" className="btn btn--ghost btn--sm" aria-label={t('admissions.moveDown')} disabled={reorder.isPending} onClick={() => void nudge(r.id, 1)}>
                              <ArrowDown size={13} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.section>
        </motion.div>
      )}
        </>
      )}
    </div>
  );
}
