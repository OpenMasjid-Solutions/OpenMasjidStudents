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
import { trpc } from '../../lib/trpc';

const MIN_PW = 12;
type StaffRole = 'admin' | 'finance';

export function Staff() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const list = trpc.staff.list.useQuery();
  const create = trpc.staff.create.useMutation();
  const setStatus = trpc.staff.setStatus.useMutation();
  const setRole = trpc.staff.setRole.useMutation();
  const resetPw = trpc.staff.resetPassword.useMutation();
  const [f, setF] = useState<{ username: string; displayName: string; phone: string; tempPassword: string; role: StaffRole }>({ username: '', displayName: '', phone: '', tempPassword: '', role: 'finance' });
  const [err, setErr] = useState('');
  /** The account having its password reset, with the new temporary one. */
  const [pwFor, setPwFor] = useState<{ id: string; username: string; tempPassword: string } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!f.username.trim() || f.tempPassword.length < MIN_PW) return setErr(t('staff.formHint'));
    try {
      await create.mutateAsync({ username: f.username.trim(), displayName: f.displayName.trim() || undefined, role: f.role, phone: f.phone.trim() || undefined, tempPassword: f.tempPassword });
      setF({ username: '', displayName: '', phone: '', tempPassword: '', role: 'finance' });
      await utils.staff.list.invalidate();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function toggle(id: string, status: 'active' | 'disabled') {
    setErr('');
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
              <thead><tr><th>{t('staff.username')}</th><th>{t('staff.name')}</th><th>{t('staff.role')}</th><th>{t('directory.status')}</th><th className="actions" /></tr></thead>
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
                    <td>{u.status === 'active' ? <span className="chip">{t('directory.active')}</span> : <span className="chip is-muted">{t('staff.disabled')}</span>}</td>
                    <td className="actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => toggle(u.id, u.status)} disabled={setStatus.isPending}>{u.status === 'active' ? t('staff.disable') : t('staff.enable')}</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPwFor({ id: u.id, username: u.username, tempPassword: '' })}>{t('staff.resetPw')}</button>
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
          <div className="field"><label className="label">{t('staff.phone')}</label><input className="input glass-inset" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div className="field"><label className="label">{t('staff.tempPassword')}</label><input className="input glass-inset" type="text" value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} placeholder={t('staff.tempHint')} /></div>
          <button type="submit" className="btn btn--primary" disabled={create.isPending}>{t('staff.add')}</button>
          <p className="hint">{t('staff.roleHint')}</p>
        </form>
        {err && <p className="form-error">{err}</p>}
      </section>
    </motion.div>
  );
}
