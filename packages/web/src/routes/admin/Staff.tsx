// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Staff accounts — create admin or finance users (temp password → forced change on first login),
 *  change a colleague's role, enable/disable, and reset a password. Admin-only.
 *
 *  A role change bites immediately: the server reads the live role on every request, so there is no
 *  "log out and back in" step to explain. The server also refuses the two lockout cases (removing the
 *  last admin, or acting on your own account), and this UI surfaces those refusals as plain text
 *  rather than hiding the buttons — an explanation is more use than a mystery. */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { fadeRise } from '../../lib/motion';
import { formatUsPhone } from '../../lib/phone';
import { trpc, type RouterOutputs } from '../../lib/trpc';

const MIN_PW = 12;
type StaffRole = 'admin' | 'finance';
/** The alert catalogue comes from the server (alerts/index.ts owns it), exactly as it does on the
 *  Settings screen — adding an event there adds a tick box here with no change on this side. */
type AlertEvent = RouterOutputs['whatsapp']['get']['staffEvents'][number];

export function Staff() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const list = trpc.staff.list.useQuery();
  const create = trpc.staff.create.useMutation();
  const setStatus = trpc.staff.setStatus.useMutation();
  const setRole = trpc.staff.setRole.useMutation();
  const resetPw = trpc.staff.resetPassword.useMutation();
  // School access (0.47.0). NO rows means ALL schools, which is the default and what every existing
  // account keeps — adding a second school must not silently lock anyone out of it.
  const schools = trpc.structure.schoolList.useQuery();
  const setSchools = trpc.staff.setSchools.useMutation();
  const multiSchool = (schools.data?.schools.length ?? 0) > 1;

  async function toggleSchool(userId: string, current: string[], schoolId: string, on: boolean) {
    setErr('');
    // Unticking the last one clears the restriction rather than leaving an account with access to
    // nothing — "none" is never a state an admin means to create here.
    const next = on ? [...current, schoolId] : current.filter((s) => s !== schoolId);
    try {
      await setSchools.mutateAsync({ userId, schoolIds: next });
      await utils.staff.list.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  const [f, setF] = useState<{ username: string; displayName: string; tempPassword: string; role: StaffRole }>({ username: '', displayName: '', tempPassword: '', role: 'finance' });
  const [err, setErr] = useState('');
  /** The account having its password reset, with the new temporary one. */
  const [pwFor, setPwFor] = useState<{ id: string; username: string; tempPassword: string } | null>(null);

  // ── Alerts to a phone (0.50.0) ──────────────────────────────────────────────
  // Staff carried no phone number until now, and the schema comment said why: nothing contacted them
  // that way, so it would have been personal data held for no purpose. WhatsApp is the purpose — a
  // declined card on a Sunday evening reaches a treasurer's phone and does not reach their inbox.
  //
  // Its own editor rather than more columns: it is four fields and a grid of alert ticks, and the
  // table is already at the width a laptop can hold. Opened per person, from the row.
  const wa = trpc.whatsapp.get.useQuery();
  const setContact = trpc.staff.setContact.useMutation();
  const [waFor, setWaFor] = useState<{ id: string; username: string; phone: string; phoneCountry: string; events: AlertEvent[] } | null>(null);
  /**
   * ALWAYS OFFERED, on every account (0.50.0-dev.4).
   *
   * It was hidden until WhatsApp was switched on, which made it unfindable in the one order an admin
   * naturally works in — set the staff up, then turn the channel on — and looked exactly like the
   * feature not existing. A number is worth recording before the channel is live, and the editor
   * itself says when the ticks will not do anything yet.
   */
  const waLive = !!wa.data?.enabled && wa.data?.status?.available === true;

  async function saveContact() {
    setErr('');
    if (!waFor) return;
    try {
      await setContact.mutateAsync({
        userId: waFor.id,
        phone: waFor.phone.trim(),
        phoneCountry: waFor.phoneCountry,
        waEvents: waFor.events,
      });
      setWaFor(null);
      await utils.staff.list.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!f.username.trim() || f.tempPassword.length < MIN_PW) return setErr(t('staff.formHint'));
    try {
      await create.mutateAsync({ username: f.username.trim(), displayName: f.displayName.trim() || undefined, role: f.role, tempPassword: f.tempPassword });
      setF({ username: '', displayName: '', tempPassword: '', role: 'finance' });
      await utils.staff.list.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function toggle(id: string, status: 'active' | 'disabled', username: string) {
    setErr('');
    // Only DISABLING asks. It takes effect on their very next click — the server re-reads the account on
    // every request — so it is not a change that waits politely for them to sign out. Re-enabling takes
    // nothing away, and a dialog on a harmless action teaches people to click through the ones that matter.
    if (status === 'active' && !window.confirm(t('staff.confirmDisable', { username }))) return;
    try {
      await setStatus.mutateAsync({ userId: id, status: status === 'active' ? 'disabled' : 'active' });
      await utils.staff.list.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function changeRole(id: string, role: StaffRole) {
    setErr('');
    try {
      await setRole.mutateAsync({ userId: id, role });
      await utils.staff.list.invalidate();
    } catch (e2) {
      // e.g. "This is the only admin left" or "you can't change your own role".
      setErr((e2 as Error).message);
    }
  }
  async function submitReset(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!pwFor || pwFor.tempPassword.length < MIN_PW) return setErr(t('staff.formHint'));
    try {
      await resetPw.mutateAsync({ userId: pwFor.id, tempPassword: pwFor.tempPassword });
      setPwFor(null);
      await utils.staff.list.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <motion.div className="page" variants={fadeRise} initial="initial" animate="animate">
      <div className="admin-header"><h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('staff.title')}</h1></div>
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        {(list.data ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('staff.noStaff')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>{t('staff.username')}</th><th>{t('staff.name')}</th><th>{t('staff.role')}</th>{multiSchool && <th>{t('staff.schools')}</th>}<th>{t('staff.waPhone')}</th><th>{t('directory.status')}</th><th className="actions" /></tr></thead>
              <tbody>
                {list.data?.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}{u.mustChangePassword && <span className="chip is-accent" style={{ marginInlineStart: '0.4rem' }}>{t('staff.tempPw')}</span>}</td>
                    <td>{u.displayName ?? '—'}</td>
                    <td>
                      {/* Changing this takes effect on their next request — no re-login needed. */}
                      <select
                        className="input glass-inset"
                        style={{ width: 'auto', minWidth: '8rem', padding: '0.2rem 0.35rem' }}
                        value={u.role}
                        onChange={(e) => void changeRole(u.id, e.target.value as StaffRole)}
                        disabled={setRole.isPending}
                        aria-label={t('staff.role')}
                      >
                        <option value="finance">{t('role.finance')}</option>
                        <option value="admin">{t('role.admin')}</option>
                      </select>
                    </td>
                    {multiSchool && (
                      <td>
                        {/* Nothing ticked = all schools, and the label says so rather than showing an
                            empty set that reads like "no access". */}
                        {u.schoolIds.length === 0 && <span className="chip is-muted" style={{ marginInlineEnd: '0.35rem' }}>{t('staff.allSchools')}</span>}
                        <span className="chip-row" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {(schools.data?.schools ?? []).map((s) => {
                            const on = u.schoolIds.includes(s.id);
                            return (
                              <label key={s.id} className={`chip ${on ? '' : 'is-muted'}`} style={{ cursor: 'pointer', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
                                <input type="checkbox" checked={on} disabled={setSchools.isPending} onChange={(e) => void toggleSchool(u.id, u.schoolIds, s.id, e.target.checked)} />
                                {s.name}
                              </label>
                            );
                          })}
                        </span>
                      </td>
                    )}
                    {/* A column rather than only an editor: "who in this office can be reached on their
                        phone?" is a question an admin asks of the whole list at once. */}
                    <td>
                      {u.phone ? (
                        <>
                          {formatUsPhone(u.phone)}
                          {u.waEvents.length === 0 && <span className="hint" style={{ display: 'block' }}>{t('staff.waNoAlerts')}</span>}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{u.status === 'active' ? <span className="chip">{t('directory.active')}</span> : <span className="chip is-muted">{t('staff.disabled')}</span>}</td>
                    <td className="actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => toggle(u.id, u.status, u.username)} disabled={setStatus.isPending}>{u.status === 'active' ? t('staff.disable') : t('staff.enable')}</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPwFor({ id: u.id, username: u.username, tempPassword: '' })}>{t('staff.resetPw')}</button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setWaFor({ id: u.id, username: u.username, phone: u.phone ?? '', phoneCountry: u.phoneCountry ?? '', events: u.waEvents })}
                      >
                        {/* The count is the state of it at a glance — an admin should not have to open
                            five editors to find who is actually subscribed. */}
                        {t('staff.waEdit')}
                        {u.waEvents.length > 0 && u.phone ? <span className="chip is-accent" style={{ marginInlineStart: '0.35rem' }}>{u.waEvents.length}</span> : null}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pwFor && (
          <form className="inline-form glass-inset" onSubmit={submitReset}>
            <div className="field" style={{ flex: '0 1 12rem' }}>
              <label className="label">{t('staff.resetPwFor', { username: pwFor.username })}</label>
              <input className="input glass-inset" type="text" value={pwFor.tempPassword} onChange={(e) => setPwFor({ ...pwFor, tempPassword: e.target.value })} placeholder={t('staff.tempHint')} autoFocus />
            </div>
            <button type="submit" className="btn btn--primary" disabled={resetPw.isPending}>{t('staff.resetPw')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setPwFor(null)}>{t('common.cancel')}</button>
            <p className="hint">{t('staff.resetPwHint')}</p>
          </form>
        )}

        {/* Alerts to a phone, for one person. Entirely opt-in: no number and no ticks by default, and
            clearing the number is the off switch. */}
        {waFor && wa.data && (
          <div className="inline-form glass-inset" style={{ flexWrap: 'wrap' }}>
            <div className="field" style={{ flexBasis: '100%' }}>
              <span className="label">{t('staff.waFor', { username: waFor.username })}</span>
              <span className="hint">{t('staff.waHint')}</span>
              {/* Says plainly that the ticks will not fire yet, rather than letting an admin set them
                  and wonder why nothing arrives. */}
              {!waLive && <span className="hint">{wa.data.enabled ? t('staff.waNotReady') : t('staff.waOffHint')}</span>}
            </div>
            <div className="field" style={{ flex: '0 1 7rem' }}>
              <label className="label" htmlFor="wa-country">{t('settings.waCountry')}</label>
              <select id="wa-country" className="input glass-inset" value={waFor.phoneCountry} onChange={(e) => setWaFor({ ...waFor, phoneCountry: e.target.value })}>
                {/* '' means "use the install's default", which is what almost every row wants. */}
                <option value="">{t('settings.waCountryDefault', { code: wa.data.defaultCountry })}</option>
                {wa.data.countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '1 1 12rem' }}>
              <label className="label" htmlFor="wa-phone">{t('staff.waPhone')}</label>
              <input id="wa-phone" className="input glass-inset" type="tel" inputMode="tel" value={waFor.phone} onChange={(e) => setWaFor({ ...waFor, phone: e.target.value })} maxLength={40} />
            </div>
            <div className="field" style={{ flexBasis: '100%' }}>
              <span className="label">{t('staff.waEvents')}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {wa.data.staffEvents.map((e) => {
                  const on = waFor.events.includes(e);
                  return (
                    <label key={e} className={`chip ${on ? '' : 'is-muted'}`} style={{ cursor: 'pointer', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(ev) => setWaFor({ ...waFor, events: ev.target.checked ? [...waFor.events, e] : waFor.events.filter((x) => x !== e) })}
                      />
                      {t(`settings.ev_${e}`)}
                    </label>
                  );
                })}
              </div>
            </div>
            <button type="button" className="btn btn--primary" onClick={() => void saveContact()} disabled={setContact.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setWaFor(null)}>{t('common.cancel')}</button>
          </div>
        )}

        <form className="inline-form glass-inset" onSubmit={add}>
          <div className="field"><label className="label">{t('staff.username')}</label><input className="input glass-inset" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></div>
          <div className="field" style={{ flex: '0 1 9rem' }}>
            <label className="label">{t('staff.role')}</label>
            <select className="input glass-inset" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as StaffRole })}>
              <option value="finance">{t('role.finance')}</option>
              <option value="admin">{t('role.admin')}</option>
            </select>
          </div>
          <div className="field"><label className="label">{t('staff.name')}</label><input className="input glass-inset" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></div>
          <div className="field"><label className="label">{t('staff.tempPassword')}</label><input className="input glass-inset" type="text" value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} placeholder={t('staff.tempHint')} /></div>
          <button type="submit" className="btn btn--primary" disabled={create.isPending}>{t('staff.add')}</button>
          <p className="hint">{t('staff.roleHint')}</p>
        </form>
        {err && <p className="form-error">{err}</p>}
      </section>
    </motion.div>
  );
}
