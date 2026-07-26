// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Admin settings — school name + currency, parent self-registration, email (SMTP), and the
 *  Stripe account tuition is collected into (+ the donation-site/kiosk tuition toggle). */
import { useState } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { fadeRise } from '../../lib/motion';
import { trpc } from '../../lib/trpc';

export function Settings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  // Can this install actually reach a parent? Shown first, because every "the invite never arrived"
  // report resolves to one of these three and all three used to fail silently.
  const link = trpc.settings.linkStatus.useQuery();

  // App settings (school name, currency, self-registration, external tuition)
  const appSettings = trpc.settings.get.useQuery();
  const saveSettings = trpc.settings.set.useMutation();
  const [school, setSchool] = useState<{ schoolName: string; currency: string } | null>(null);
  const eff = school ?? (appSettings.data ? { schoolName: appSettings.data.schoolName, currency: appSettings.data.currency } : { schoolName: '', currency: 'usd' });

  async function saveSchool() {
    await saveSettings.mutateAsync({ schoolName: eff.schoolName.trim(), currency: eff.currency as 'usd' | 'cad' | 'gbp' | 'eur' });
    await utils.settings.get.invalidate();
    setSchool(null);
  }
  async function toggleSelfReg() {
    await saveSettings.mutateAsync({ selfRegistration: !appSettings.data?.selfRegistration });
    await utils.settings.get.invalidate();
  }
  async function toggleExternalPayments() {
    await saveSettings.mutateAsync({ externalPayments: !appSettings.data?.externalPayments });
    await utils.settings.get.invalidate();
  }

  // Email (SMTP) — the password is write-only: never returned by smtpGet; only sent when re-typed.
  const smtp = trpc.settings.smtpGet.useQuery();
  const saveSmtp = trpc.settings.smtpSet.useMutation();
  const testSmtp = trpc.settings.smtpTest.useMutation();
  const [smtpForm, setSmtpForm] = useState<{ host: string; port: string; secure: boolean; user: string; from: string; password: string } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [smtpMsg, setSmtpMsg] = useState<string | null>(null);
  const se = smtpForm ?? (smtp.data ? { host: smtp.data.host, port: String(smtp.data.port), secure: smtp.data.secure, user: smtp.data.user, from: smtp.data.from, password: '' } : { host: '', port: '587', secure: false, user: '', from: '', password: '' });

  async function saveSmtpSettings() {
    const port = parseInt(se.port, 10);
    if (!se.host.trim() || !se.from.trim() || Number.isNaN(port)) return;
    await saveSmtp.mutateAsync({ host: se.host.trim(), port, secure: se.secure, user: se.user.trim(), from: se.from.trim(), password: se.password || undefined });
    await utils.settings.smtpGet.invalidate();
    setSmtpForm(null);
    setSmtpMsg(t('settings.smtpSaved'));
  }
  async function runSmtpTest() {
    setSmtpMsg(null);
    try {
      await testSmtp.mutateAsync({ to: testTo.trim() });
      setSmtpMsg(t('settings.smtpTestOk'));
    } catch (e) {
      setSmtpMsg((e as Error).message);
    }
  }

  // Payments — pick which OpenMasjidOS Stripe account tuition charges go through (§10).
  const stripeAccounts = trpc.settings.stripeAccountsGet.useQuery();
  const saveStripeAccount = trpc.settings.stripeAccountSet.useMutation();
  const [acctId, setAcctId] = useState<string | null>(null);
  const [acctMsg, setAcctMsg] = useState<string | null>(null);
  const chosenAcct = acctId ?? stripeAccounts.data?.chosenId ?? '';
  async function saveTuitionAccount() {
    setAcctMsg(null);
    try {
      const r = await saveStripeAccount.mutateAsync({ accountId: chosenAcct });
      setAcctMsg(r.ready ? t('settings.paymentsReady') : t('settings.paymentsNotReady'));
      setAcctId(null);
      await utils.settings.stripeAccountsGet.invalidate();
    } catch (e) {
      setAcctMsg((e as Error).message);
    }
  }

  return (
    <motion.div className="page" variants={fadeRise} initial="initial" animate="animate">
      <div className="admin-header">
        <h1 className="page-title" style={{ fontSize: '1.5rem' }}>{t('settings.title')}</h1>
      </div>

      {/* Reaching parents — shown first because it silently blocks invites and resets. */}
      {link.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('settings.reach')}</h2></div>
          <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.reachHint')}</p>
          <table className="data-table">
            <tbody>
              <tr>
                <td>{t('settings.reachUrl')}</td>
                <td>
                  {link.data.publicUrl ? (
                    <>
                      <span className="chip">{t('settings.reachOk')}</span>
                      <code style={{ marginInlineStart: '0.5rem', fontSize: '0.82rem' }}>{link.data.publicUrl}</code>
                    </>
                  ) : (
                    <span className="chip is-muted">{t('settings.reachMissing')}</span>
                  )}
                  <p className="hint">{link.data.publicUrl ? t(`settings.reachUrlFrom_${link.data.publicUrlSource}`) : t('settings.reachUrlFix')}</p>
                </td>
              </tr>
              <tr>
                <td>{t('settings.reachMail')}</td>
                <td>
                  <span className={`chip ${link.data.mailAvailable ? '' : 'is-muted'}`}>
                    {link.data.mailAvailable ? t('settings.reachOk') : t('settings.reachMissing')}
                  </span>
                  <p className="hint">
                    {link.data.smtp
                      ? t('settings.reachMailSmtp')
                      : link.data.platformMail
                        ? t('settings.reachMailPlatform')
                        : t('settings.reachMailFix')}
                  </p>
                </td>
              </tr>
              <tr>
                <td>{t('settings.reachSelfReg')}</td>
                <td>
                  <span className={`chip ${link.data.selfRegistrationAvailable ? '' : 'is-muted'}`}>
                    {link.data.selfRegistrationAvailable ? t('settings.reachOk') : t('settings.reachMissing')}
                  </span>
                  {!link.data.selfRegistrationAvailable && link.data.selfRegistrationOn && <p className="hint">{t('settings.reachSelfRegBlocked')}</p>}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {/* School */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('settings.school')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.schoolHint')}</p>
        {!appSettings.data ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('common.loading')}</p>
        ) : (
          <>
            <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
              <div className="field" style={{ flex: '2 1 16rem' }}><label className="label">{t('settings.schoolName')}</label><input className="input glass-inset" value={eff.schoolName} onChange={(e) => setSchool({ ...eff, schoolName: e.target.value })} /></div>
              <div className="field" style={{ flex: '0 1 8rem' }}><label className="label">{t('settings.currency')}</label>
                <select className="input glass-inset" value={eff.currency} onChange={(e) => setSchool({ ...eff, currency: e.target.value })}>
                  {['usd', 'cad', 'gbp', 'eur'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
              <button type="button" className="btn btn--primary" onClick={saveSchool} disabled={saveSettings.isPending || !eff.schoolName.trim()}>{t('common.save')}</button>
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockStart: '0.75rem', cursor: 'pointer' }}>
              <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={!!appSettings.data.selfRegistration} onChange={toggleSelfReg} />
              <span>{t('settings.selfRegistration')}<br /><span className="hint">{t('settings.selfRegistrationHint')}</span></span>
            </label>
          </>
        )}
      </section>

      {/* Email (SMTP) — optional but recommended: powers parent invites, receipts, and autopay notices. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('settings.smtp')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.smtpHint')}</p>
        {smtpMsg && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{smtpMsg}</div>}
        <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
          <div className="field" style={{ flex: '2 1 14rem' }}><label className="label">{t('settings.smtpHost')}</label><input className="input glass-inset" value={se.host} onChange={(e) => setSmtpForm({ ...se, host: e.target.value })} placeholder="smtp.example.org" /></div>
          <div className="field" style={{ flex: '0 1 6rem' }}><label className="label">{t('settings.smtpPort')}</label><input type="number" className="input glass-inset" value={se.port} onChange={(e) => setSmtpForm({ ...se, port: e.target.value })} /></div>
          <div className="field" style={{ flex: '1 1 15rem' }}><label className="label">{t('settings.smtpFrom')}</label><input className="input glass-inset" value={se.from} onChange={(e) => setSmtpForm({ ...se, from: e.target.value })} placeholder="School <office@example.org>" /></div>
          <div className="field" style={{ flex: '1 1 10rem' }}><label className="label">{t('settings.smtpUser')}</label><input className="input glass-inset" value={se.user} onChange={(e) => setSmtpForm({ ...se, user: e.target.value })} autoComplete="off" /></div>
          <div className="field" style={{ flex: '1 1 10rem' }}><label className="label">{t('settings.smtpPassword')}</label><input type="password" className="input glass-inset" value={se.password} onChange={(e) => setSmtpForm({ ...se, password: e.target.value })} placeholder={smtp.data?.hasPassword ? t('settings.smtpPasswordSet') : ''} autoComplete="new-password" /></div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', alignSelf: 'center' }}>
            <input type="checkbox" checked={se.secure} onChange={(e) => setSmtpForm({ ...se, secure: e.target.checked })} />
            <span>{t('settings.smtpSecure')}</span>
          </label>
          <button type="button" className="btn btn--primary" onClick={saveSmtpSettings} disabled={saveSmtp.isPending || !se.host.trim() || !se.from.trim()}>{t('common.save')}</button>
        </div>
        <div className="inline-form glass-inset" style={{ marginBlockStart: '0.6rem' }}>
          <div className="field" style={{ flex: '1 1 14rem' }}><label className="label">{t('settings.smtpTestTo')}</label><input className="input glass-inset" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.org" /></div>
          <button type="button" className="btn btn--ghost" onClick={runSmtpTest} disabled={testSmtp.isPending || !testTo.trim() || !smtp.data?.configured}>{testSmtp.isPending ? t('settings.smtpTesting') : t('settings.smtpSendTest')}</button>
        </div>
      </section>

      {/* Payments — choose which OpenMasjidOS Stripe account tuition (portal, donations, kiosk) uses. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('settings.payments')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.paymentsHint')}</p>

        {/* Accept tuition via the masjid's donation site + kiosk (drives info.enabled over the Fabric). Charges
            there use those apps' own Stripe account — independent of the portal account chosen below. */}
        {appSettings.data && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockEnd: '0.9rem', cursor: 'pointer' }}>
            <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={!!appSettings.data.externalPayments} onChange={toggleExternalPayments} disabled={saveSettings.isPending} />
            <span>{t('settings.externalPayments')}<br /><span className="hint">{t('settings.externalPaymentsHint')}</span></span>
          </label>
        )}

        {acctMsg && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{acctMsg}</div>}
        {(stripeAccounts.data?.accounts.length ?? 0) === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.paymentsNoAccounts')}</p>
        ) : (
          <>
            <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
              <div className="field" style={{ flex: '1 1 18rem' }}>
                <label className="label">{t('settings.paymentsAccount')}</label>
                <select className="input glass-inset" value={chosenAcct} onChange={(e) => setAcctId(e.target.value)}>
                  <option value="">{t('settings.paymentsChoose')}</option>
                  {stripeAccounts.data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
              <button type="button" className="btn btn--primary" onClick={saveTuitionAccount} disabled={saveStripeAccount.isPending || !chosenAcct}>{t('common.save')}</button>
            </div>
            <p className="muted" style={{ fontSize: '0.85rem', marginBlockStart: '0.5rem' }}>
              {stripeAccounts.data?.ready ? t('settings.paymentsReady') : t('settings.paymentsNotReady')}
            </p>
          </>
        )}
      </section>
    </motion.div>
  );
}
