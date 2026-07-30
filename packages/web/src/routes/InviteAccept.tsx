// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Parent portal invite acceptance (CLAUDE.md §12). Anonymous page reached from the invite link
 *  (/family/invite?token=…): greet the guardian, set a password → the server creates the parent
 *  account + guardian link and signs them in, then we reload into the portal. */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { MasjidMark } from '../components/Glyphs';
import { fadeRise } from '../lib/motion';
import { trpc } from '../lib/trpc';

const MIN_PW = 12;

export function InviteAccept({ token }: { token: string }) {
  const { t } = useTranslation();
  const info = trpc.auth.inviteInfo.useQuery({ token }, { retry: false });
  const accept = trpc.auth.inviteAccept.useMutation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PW) return setError(t('auth.passwordHint'));
    if (password !== confirm) return setError(t('family.passwordsDontMatch'));
    try {
      await accept.mutateAsync({ token, password });
      // Signed in — reload to the portal (drops the token from the URL).
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const invalid = info.isSuccess && !info.data.valid;

  return (
    <motion.div className="auth-card glass-raised fx-glint" variants={fadeRise} initial="initial" animate="animate">
      <div className="auth-logo" style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-gold)' }}>
        <MasjidMark size={48} />
      </div>
      <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.4rem' }}>{t('family.acceptTitle')}</h1>

      {info.isLoading && <p className="page-sub" style={{ textAlign: 'center' }}>{t('status.connecting')}</p>}

      {invalid && <p className="page-sub" style={{ textAlign: 'center' }}>{t('family.inviteInvalid')}</p>}

      {info.data?.valid && (
        <>
          <p className="page-sub" style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
            {t('family.acceptGreeting', { name: info.data.guardianName })}
          </p>
          {/* Say the address out loud. There is no separate username for a parent — it IS this email —
              and the sign-in form asks for a "username", which is exactly where that trips people up. */}
          {info.data.email && (
            <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              <strong>{t('family.signInWith', { email: info.data.email })}</strong>
            </p>
          )}
          <form onSubmit={submit}>
            <div className="field">
              <label className="label" htmlFor="ia-pw">{t('family.newPassword')}</label>
              <input id="ia-pw" type="password" className="input glass-inset" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <span className="hint">{t('auth.passwordHint')}</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="ia-conf">{t('family.confirmPassword')}</label>
              <input id="ia-conf" type="password" className="input glass-inset" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="btn btn--primary btn--block" disabled={accept.isPending}>
              {accept.isPending ? t('auth.working') : t('family.createAccount')}
            </button>
          </form>
        </>
      )}
    </motion.div>
  );
}
