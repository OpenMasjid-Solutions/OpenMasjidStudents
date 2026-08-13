// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The auth gate. Reads `auth.session` and routes to first-run setup, login, or the
 * signed-in home. The origin policy (admin = LAN only) is enforced server-side; the
 * UI just reflects it (setup blocked over the tunnel; admin cookie inert over tunnel).
 * Per-role dashboards land in later slices (CLAUDE.md §20).
 */
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { SceneBackground } from './components/SceneBackground';
import { ShellControls } from './components/ShellControls';
import { MasjidMark } from './components/Glyphs';
import { InstallPrompt } from './components/InstallPrompt';
import { fadeRise } from './lib/motion';
import { Setup } from './routes/Setup';
import { Login } from './routes/Login';
import { Home } from './routes/Home';
import { ChangePassword } from './routes/ChangePassword';
import { AdminApp } from './routes/admin/AdminApp';
import { FinanceApp } from './routes/finance/FinanceApp';
import { FamilyApp } from './routes/family/FamilyApp';
import { InviteAccept } from './routes/InviteAccept';
import { ResetPassword } from './routes/ResetPassword';
import { SelfRegister } from './routes/SelfRegister';
import { trpc } from './lib/trpc';
import { stripBase } from './lib/base';
import { useOmosAppearanceSync } from './lib/appearance';

function SetupOnLanNotice() {
  const { t } = useTranslation();
  return (
    <motion.div className="auth-card glass-raised" variants={fadeRise} initial="initial" animate="animate">
      <div className="auth-logo" style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-gold)' }}>
        <MasjidMark size={48} />
      </div>
      <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.4rem' }}>{t('auth.setupOnLanTitle')}</h1>
      <p className="page-sub" style={{ textAlign: 'center' }}>{t('auth.setupOnLanBody')}</p>
    </motion.div>
  );
}

/** A short notice card (used for the self-registration-unavailable + missing-token cases). */
function NoticeCard({ title, body }: { title: string; body: string }) {
  return (
    <motion.div className="auth-card glass-raised" variants={fadeRise} initial="initial" animate="animate">
      <div className="auth-logo" style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-gold)' }}>
        <MasjidMark size={48} />
      </div>
      <h1 className="page-title" style={{ textAlign: 'center', fontSize: '1.4rem' }}>{title}</h1>
      <p className="page-sub" style={{ textAlign: 'center' }}>{body}</p>
    </motion.div>
  );
}

export function App() {
  const { t } = useTranslation();
  const session = trpc.auth.session.useQuery(undefined, { retry: false });
  const health = trpc.health.useQuery(undefined, { retry: false });
  // Live-inherit the OS dashboard's wallpaper + light/dark when embedded (linked to the platform).
  useOmosAppearanceSync(health.data ? !health.data.standalone : false);
  const s = session.data;

  // Anonymous portal entry points reached via the emailed invite link / statement QR. These take
  // precedence over the session gate (a parent sets a password here before they have an account).
  // stripBase drops the tunnel prefix so "/students/family/reset" matches "/family/reset" (§12/§15).
  const path = stripBase(typeof window !== 'undefined' ? window.location.pathname : '/');
  // Password reset (§12): /family/reset — request a link (no token) or set a new password (with ?token=).
  if (path === '/family/reset') {
    const token = new URLSearchParams(window.location.search).get('token');
    return (
      <>
        <SceneBackground />
        <ShellControls />
        <div className="auth-wrap"><ResetPassword token={token} /></div>
      </>
    );
  }
  if (path === '/family/invite' || path === '/family/register') {
    const token = path === '/family/invite' ? new URLSearchParams(window.location.search).get('token') : null;
    let card: React.ReactNode;
    if (path === '/family/register') card = <SelfRegister />;
    else if (token) card = <InviteAccept token={token} />;
    else card = <NoticeCard title={t('family.acceptTitle')} body={t('family.inviteInvalid')} />;
    return (
      <>
        <SceneBackground />
        <ShellControls />
        <div className="auth-wrap">{card}</div>
      </>
    );
  }

  // Forced password change (staff temp password / after an admin reset) blocks everything.
  if (!session.isLoading && !session.isError && s?.authenticated && s.user?.mustChangePassword) {
    return (
      <>
        <SceneBackground />
        <ShellControls />
        <div className="auth-wrap">
          <ChangePassword />
        </div>
      </>
    );
  }

  // Admin + finance run as full-screen desktop apps (their own topbar + dock + windows);
  // parents get the phone-first portal.
  //
  // `InstallPrompt` rides along with all three (0.48.0): a finance manager recording cash on their phone at
  // the desk wants this on their home screen as much as a parent does, so it is mounted here rather than
  // inside one shell. It is a pop-up that decides for itself whether to appear — installed already, not a
  // phone, or dismissed, and it renders nothing — so mounting it three times costs nothing. Signed-in only:
  // offering to install before somebody has an account to sign into is premature.
  if (!session.isLoading && !session.isError && s?.authenticated) {
    if (s.user?.role === 'admin') return <><AdminApp /><InstallPrompt /></>;
    if (s.user?.role === 'finance') return <><FinanceApp /><InstallPrompt /></>;
    if (s.user?.role === 'parent') return <><FamilyApp /><InstallPrompt /></>;
  }

  let screen: React.ReactNode;
  if (session.isLoading) {
    screen = (
      <div className="auth-card glass-raised" style={{ textAlign: 'center' }}>
        <p className="page-sub">{t('status.connecting')}</p>
      </div>
    );
  } else if (session.isError || !s) {
    screen = <Login />;
  } else if (s.authenticated && s.user) {
    screen = <Home user={s.user} />;
  } else if (s.setupRequired) {
    screen = s.origin === 'tunnel' ? <SetupOnLanNotice /> : <Setup />;
  } else {
    screen = <Login tunnel={s.origin === 'tunnel'} />;
  }

  const statusClass = health.isSuccess ? 'is-ok' : health.isError ? 'is-off' : '';
  const statusText = health.isLoading
    ? t('status.connecting')
    : health.isError
      ? t('status.offline')
      : `${t('status.connected')} · ${health.data?.standalone ? t('status.standalone') : t('status.linked')}`;

  return (
    <>
      <SceneBackground />
      <ShellControls />
      <div className="auth-wrap">
        {screen}
        <p className="hint" style={{ textAlign: 'center', marginBlockStart: '1rem' }}>
          <span className={`shell-status ${statusClass}`}>
            <span className="dot" aria-hidden="true" />
            {statusText}
          </span>
        </p>
      </div>
    </>
  );
}
