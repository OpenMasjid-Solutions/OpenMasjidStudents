// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * RE-ADMISSION — who is coming back (0.52.0-dev.9, docs/ADMISSIONS.md §5).
 *
 * This happens to a whole school in one fortnight, so the screen that matters is the one saying **who
 * has answered and who has not**. That is what this is: a board per school year, with the office's
 * two actions on each row — send them a link, and approve what came back.
 *
 * What comes back is a DIFF, never a blind overwrite. The office sees before → after per field and
 * only the changes they accept are written, which is why a row shows its change count rather than a
 * tick: "confirmed, nothing changed" and "confirmed, they have moved house" are different pieces of
 * news and an office needs to tell them apart at a glance.
 *
 * `lapsed` is a BUTTON, not an inference. A family that never answers becomes lapsed because
 * somebody decided so — deriving it from "pending and old" would make this screen disagree with
 * itself between two refreshes.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Link2, Send } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatMoney } from '../lib/money';
import { cn } from '../lib/cn';

export function Readmissions() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const years = trpc.structure.schoolYearList.useQuery({});
  const [yearId, setYearId] = useState('');
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; token: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const effectiveYear = yearId || years.data?.find((y) => y.isCurrent)?.id || years.data?.[0]?.id || '';
  const board = trpc.admissions.readmissionBoard.useQuery({ schoolYearId: effectiveYear }, { enabled: !!effectiveYear });
  const openRows = trpc.admissions.readmissionOpen.useMutation();
  const mintLink = trpc.admissions.readmissionLink.useMutation();
  const approve = trpc.admissions.readmissionApprove.useMutation();
  const setState = trpc.admissions.readmissionState.useMutation();
  const review = trpc.admissions.readmissionReview.useQuery({ id: openFor ?? '' }, { enabled: !!openFor });

  async function refresh() {
    await utils.admissions.readmissionBoard.invalidate({ schoolYearId: effectiveYear });
    if (openFor) await utils.admissions.readmissionReview.invalidate({ id: openFor });
  }

  async function run(fn: () => Promise<unknown>, done?: string) {
    setErr('');
    setMsg('');
    try {
      await fn();
      await refresh();
      if (done) setMsg(done);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (years.isLoading) return <p className="empty">{t('common.loading')}</p>;
  if (!effectiveYear) return <p className="empty">{t('readmission.noYears')}</p>;

  const rows = board.data?.rows ?? [];
  const counts = board.data?.counts ?? {};
  const currency = board.data?.currency ?? 'usd';

  return (
    <>
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('readmission.title')}</h2>
          <span className="spacer" />
          <div className="field" style={{ flex: '0 1 14rem', margin: 0 }}>
            <label className="label" htmlFor="rdm-year">{t('readmission.year')}</label>
            <select id="rdm-year" className="input glass-inset" value={effectiveYear} onChange={(e) => setYearId(e.target.value)}>
              {(years.data ?? []).map((y) => (
                <option key={y.id} value={y.id}>{y.label}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="hint">{t('readmission.hint')}</p>
        <div className="inline-form" style={{ alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={openRows.isPending}
            onClick={() =>
              void run(async () => {
                const r = await openRows.mutateAsync({ schoolYearId: effectiveYear, target: { kind: 'all' } });
                setMsg(t('readmission.opened', { created: r.created, existing: r.existing }));
              })
            }
          >
            <Send size={14} /> {t('readmission.openAll')}
          </button>
          {msg && <span className="notice notice--ok" style={{ margin: 0 }}>{msg}</span>}
        </div>
        {err && <p className="form-error">{err}</p>}
        <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{t('readmission.openHint')}</p>
      </section>

      {rows.length === 0 ? (
        <p className="empty">{t('readmission.empty')}</p>
      ) : (
        <section className="section glass">
          <div className="section-head">
            <h2>{t('readmission.board')}</h2>
            {(['pending', 'submitted', 'approved', 'not_returning', 'lapsed'] as const).map((s) =>
              counts[s] ? (
                <span key={s} className="chip is-muted">
                  {t(`readmission.state.${s}`)} {counts[s]}
                </span>
              ) : null,
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('readmission.child')}</th>
                  <th>{t('readmission.stateColumn')}</th>
                  <th>{t('readmission.changes')}</th>
                  <th>{t('readmission.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpenFor(openFor === r.id ? null : r.id)}>
                        {r.fullName}
                      </button>
                      {r.studentCode && <span className="code">{r.studentCode}</span>}
                    </td>
                    <td>
                      <span className={cn('chip', (r.state === 'not_returning' || r.state === 'lapsed') && 'is-muted')}>{t(`readmission.state.${r.state}`)}</span>
                    </td>
                    <td>{r.state === 'submitted' || r.state === 'approved' ? t('readmission.changedCount', { count: r.changed }) : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={mintLink.isPending}
                        onClick={() =>
                          void run(async () => {
                            const l = await mintLink.mutateAsync({ id: r.id });
                            setLink({ id: r.id, url: l.url, token: l.token });
                          })
                        }
                      >
                        <Link2 size={13} /> {t('readmission.link')}
                      </button>
                      {r.state === 'submitted' && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={approve.isPending} onClick={() => void run(() => approve.mutateAsync({ id: r.id }), t('readmission.approved'))}>
                          <Check size={13} /> {t('readmission.approve')}
                        </button>
                      )}
                      {r.state === 'pending' && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={setState.isPending} onClick={() => void run(() => setState.mutateAsync({ id: r.id, state: 'lapsed' }))}>
                          {t('readmission.lapse')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* The link, shown ONCE. It is not stored in the clear anywhere, so closing this box without
          copying it means minting a new one — which the copy says, because a family waiting on a link
          that was never sent is the failure this screen would otherwise cause. */}
      {link && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('readmission.linkTitle')}</h2>
            <span className="spacer" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLink(null)}>{t('common.close')}</button>
          </div>
          <p className="hint">{t('readmission.linkHint')}</p>
          <div className="inline-form" style={{ alignItems: 'center' }}>
            <input className="input glass-inset" readOnly value={link.url || link.token} style={{ flex: '2 1 20rem' }} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard?.writeText(link.url || link.token)}>
              <Copy size={13} /> {t('common.copy')}
            </button>
          </div>
          {!link.url && <p className="notice">{t('readmission.linkNoUrl')}</p>}
        </section>
      )}

      {openFor && review.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('readmission.whatChanged', { name: review.data.current.fullName })}</h2>
            <span className="spacer" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpenFor(null)}>{t('common.close')}</button>
          </div>
          {review.data.changes.length === 0 ? (
            <p className="muted" style={{ fontSize: '0.9rem' }}>{t('readmission.noChanges')}</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('readmission.field')}</th>
                  <th>{t('readmission.from')}</th>
                  <th>{t('readmission.to')}</th>
                </tr>
              </thead>
              <tbody>
                {review.data.changes.map((c) => (
                  <tr key={c.field}>
                    <td>{t(`readmission.field_${c.field}`)}</td>
                    <td className="muted">{c.from || '—'}</td>
                    <td>{c.to || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>
            {t('readmission.feeNote', {
              amount: board.data?.year?.readmissionFeeCents ? formatMoney(board.data.year.readmissionFeeCents, currency) : t('readmission.noFee'),
            })}
          </p>
        </section>
      )}
    </>
  );
}
