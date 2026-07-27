// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Parent self-registration (CLAUDE.md §12 door 2). Anonymous /family/register: a parent proves they
 *  belong with a child's Student ID + a guardian email already on file; on a match the server emails a
 *  portal-setup link to THAT address, which is why an on-file email is required and not just the ID.
 *  The response is always the same generic "check your email" — it never reveals whether the details
 *  matched (§14). Shown only when the door is open (admin toggle + email set up). */
import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { MasjidMark } from '../components/Glyphs';
import { fadeRise } from '../lib/motion';
import { trpc } from '../lib/trpc';
import { withBase } from '../lib/base';

export function SelfRegister() {
  const { t } = useTranslation();
  const config = trpc.auth.registerConfig.useQuery(undefined, { retry: false });
  const register = trpc.auth.register.useMutation();
  const [studentCode, setStudentCode] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await register.mutateAsync({ studentCode: studentCode.trim(), email: email.trim() });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const closed = config.isSuccess && !config.data.available;

  return (
    <motion.div className="auth-card glass-raised fx-glint" variants={fadeRise} initial="initial" animate="animate">
      <div className="auth-logo" style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-gold)' }}><MasjidMark size={48} /></div>
      <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.4rem' }}>{t('family.registerTitle')}</h1>
      {closed ? (
        <p className="page-sub" style={{ textAlign: 'center', marginBlockStart: '0.5rem' }}>{t('family.registerUnavailable')}</p>
      ) : sent ? (
        <p className="page-sub" style={{ textAlign: 'center', marginBlockStart: '0.5rem' }}>{t('family.registerSent')}</p>
      ) : (
        <>
          <p className="page-sub" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>{t('family.registerSubtitle')}</p>
          <form onSubmit={submit}>
            <div className="field">
              <label className="label" htmlFor="sr-code">{t('family.registerStudentId')}</label>
              {/* Uppercased as they type: the ID is stored uppercase and the server normalises anyway,
                  but seeing it match the statement removes the "did I type it right?" doubt. */}
              <input
                id="sr-code"
                className="input glass-inset"
                value={studentCode}
                onChange={(e) => setStudentCode(e.target.value.toUpperCase())}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="YUS1234"
                required
              />
              <span className="hint">{t('family.registerStudentIdHint')}</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="sr-email">{t('family.registerEmail')}</label>
              <input id="sr-email" type="email" className="input glass-inset" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
              <span className="hint">{t('family.registerEmailHint')}</span>
            </div>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="btn btn--primary btn--block" disabled={register.isPending}>{register.isPending ? t('auth.working') : t('family.registerSubmit')}</button>
          </form>
        </>
      )}
      <p className="hint" style={{ textAlign: 'center', marginBlockStart: '1rem' }}><a href={withBase('/')}>{t('auth.backToLogin')}</a></p>
    </motion.div>
  );
}
