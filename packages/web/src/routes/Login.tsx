// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Password login. Shows the friendly admin-over-tunnel note when relevant. */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { MasjidMark } from '../components/Glyphs';
import { fadeRise } from '../lib/motion';
import { trpc } from '../lib/trpc';
import { withBase } from '../lib/base';

export function Login({ tunnel }: { tunnel?: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const login = trpc.auth.login.useMutation();
  const reg = trpc.auth.registerConfig.useQuery(undefined, { retry: false });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await login.mutateAsync({ username, password });
      await utils.auth.session.invalidate();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <motion.div className="auth-card glass-raised fx-glint" variants={fadeRise} initial="initial" animate="animate">
      <div className="auth-logo" style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-primary)' }}>
        <MasjidMark size={48} />
      </div>
      <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.5rem' }}>{t('auth.loginTitle')}</h1>
      <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>{t('auth.loginSubtitle')}</p>

      {tunnel && (
        <p className="hint" style={{ textAlign: 'center', marginBottom: '1rem', color: 'var(--color-gold)' }}>
          {t('auth.adminTunnelNote')}
        </p>
      )}

      <form onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="li-username">{t('auth.username')}</label>
          <input id="li-username" className="input glass-inset" autoComplete="username" autoCapitalize="none"
            autoCorrect="off" spellCheck={false} value={username}
            onChange={(e) => setUsername(e.target.value)} required />
          {/* Staff have a username the office chose; a parent's IS their email address (the account is
              created with both set to it). Most people on this page are parents, so say so here rather
              than leaving them to guess what a "username" of theirs would even be. */}
          <span className="hint">{t('auth.parentUsernameIsEmail')}</span>
        </div>

        <div className="field">
          <label className="label" htmlFor="li-password">{t('auth.password')}</label>
          <input id="li-password" type="password" className="input glass-inset" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
        </div>

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn--primary btn--block" disabled={login.isPending}>
          {login.isPending ? t('auth.working') : t('auth.signIn')}
        </button>
      </form>

      <p className="hint" style={{ textAlign: 'center', marginBlockStart: '1rem' }}>
        <a href={withBase('/family/reset')}>{t('auth.forgotPassword')}</a>
        {reg.data?.available && (
          <>
            {' · '}
            <a href={withBase('/family/register')}>{t('auth.createAccount')}</a>
          </>
        )}
      </p>
    </motion.div>
  );
}
