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
  // School logo. Read in the browser as a data URI and sent as one — the server re-checks the magic
  // bytes, so nothing here is trusted; this is just the least fiddly way to move a small image
  // through tRPC without adding a multipart route for one field.
  const logoSet = trpc.settings.logoSet.useMutation();
  const [logoMsg, setLogoMsg] = useState<string | null>(null);
  const LOGO_MAX_BYTES = 512 * 1024;

  async function pickLogo(file: File | null) {
    setLogoMsg(null);
    if (!file) return;
    // Checked here too so an oversized file fails instantly and locally, rather than after the
    // browser has base64'd a 10 MB photo and pushed it at the server.
    if (file.size > LOGO_MAX_BYTES) return setLogoMsg(t('settings.logoTooBig'));
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('read_failed'));
        r.readAsDataURL(file);
      });
      await logoSet.mutateAsync({ dataUri });
      await utils.settings.get.invalidate();
    } catch (e) {
      setLogoMsg((e as Error).message);
    }
  }

  async function clearLogo() {
    setLogoMsg(null);
    try {
      await logoSet.mutateAsync({ dataUri: null });
      await utils.settings.get.invalidate();
    } catch (e) {
      setLogoMsg((e as Error).message);
    }
  }

  async function toggleSelfReg() {
    await saveSettings.mutateAsync({ selfRegistration: !appSettings.data?.selfRegistration });
    await utils.settings.get.invalidate();
  }
  async function toggleExternalPayments() {
    await saveSettings.mutateAsync({ externalPayments: !appSettings.data?.externalPayments });
    await utils.settings.get.invalidate();
  }

  // No SMTP settings: OpenMasjidOS owns the mail provider and the From address (POST
  // /api/fabric/email), so a masjid configures email once, in the OS, not again here. What remains is
  // a way to prove it actually reaches somebody.
  const mailTest = trpc.settings.mailTest.useMutation();
  const [testTo, setTestTo] = useState('');
  const [mailMsg, setMailMsg] = useState<string | null>(null);

  async function runMailTest() {
    setMailMsg(null);
    try {
      await mailTest.mutateAsync({ to: testTo.trim() });
      setMailMsg(t('settings.mailTestOk'));
    } catch (e) {
      setMailMsg((e as Error).message);
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
                  <p className="hint">{link.data.platformMail ? t('settings.reachMailPlatform') : t('settings.reachMailFix')}</p>
                  {/* "Connected" only means the Fabric is wired up — the OS can still have no mail
                      provider configured. This is the only way to know for certain. */}
                  {link.data.platformMail && (
                    <div className="inline-form" style={{ marginBlockStart: '0.4rem' }}>
                      <div className="field" style={{ flex: '1 1 12rem' }}>
                        <input className="input glass-inset" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.org" aria-label={t('settings.mailTestTo')} />
                      </div>
                      <button type="button" className="btn btn--ghost" onClick={runMailTest} disabled={mailTest.isPending || !testTo.trim()}>
                        {mailTest.isPending ? t('settings.mailTesting') : t('settings.mailSendTest')}
                      </button>
                      {mailMsg && <p className="hint" style={{ flexBasis: '100%' }}>{mailMsg}</p>}
                    </div>
                  )}
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

            {/* Logo — goes on printed statements and outgoing email. */}
            <div className="inline-form glass-inset" style={{ alignItems: 'center' }}>
              <div className="field" style={{ flex: '0 0 auto' }}>
                <span className="label">{t('settings.logo')}</span>
                {appSettings.data.logo ? (
                  // `alignSelf` is the fix, not decoration: `.field` is a flex COLUMN, so the default
                  // `stretch` was setting the image's width to the field's while `max-height` held the
                  // height down — which is exactly what squashed a wide logo. `object-fit` keeps it
                  // honest if a future layout constrains both axes.
                  <img
                    src={appSettings.data.logo}
                    alt=""
                    style={{ maxHeight: '3rem', maxWidth: '10rem', width: 'auto', height: 'auto', display: 'block', alignSelf: 'flex-start', objectFit: 'contain' }}
                  />
                ) : (
                  <span className="muted" style={{ fontSize: '0.88rem' }}>{t('settings.logoNone')}</span>
                )}
              </div>
              <div className="field" style={{ flex: '1 1 14rem' }}>
                <label className="label" htmlFor="logo-file">{t('settings.logoUpload')}</label>
                <input id="logo-file" className="input glass-inset" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void pickLogo(e.target.files?.[0] ?? null)} disabled={logoSet.isPending} />
                <span className="hint">{t('settings.logoHint')}</span>
              </div>
              {appSettings.data.logo && (
                <button type="button" className="btn btn--ghost" onClick={() => void clearLogo()} disabled={logoSet.isPending}>{t('common.remove')}</button>
              )}
            </div>
            {logoMsg && <p className="form-error">{logoMsg}</p>}
            {/* The one case where an uploaded logo genuinely won't appear: an email has to LOAD the
                image from a web address, and there isn't one until Remote access is on. Said here
                rather than left to be discovered as "the logo is broken in email". */}
            {appSettings.data.logo && !link.data?.publicUrl && <p className="hint">{t('settings.logoEmailNeedsUrl')}</p>}
          </>
        )}
      </section>

      {/* No email settings here on purpose — OpenMasjidOS owns the mail provider and the From address,
          so there is nothing for a masjid to configure twice. The "Reaching parents" panel above says
          whether it is actually working. */}

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
