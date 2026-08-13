// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Admin settings — school name + currency, parent self-registration, email alerts (who hears what),
 *  and the Stripe account tuition is collected into (+ the donation-site/kiosk tuition toggle). */
import { useState } from 'react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { Trash2, Send } from 'lucide-react';
import { fadeRise } from '../../lib/motion';
import { formatUsPhone, telHref } from '../../lib/phone';
import { formatMoney } from '../../lib/money';
import { trpc, type RouterOutputs } from '../../lib/trpc';

/** The alert catalogue comes from the server (alerts/index.ts owns it), so the UI never hard-codes the
 *  event list — adding an event there makes a new checkbox appear here with no change on this side. */
type AlertEvent = RouterOutputs['settings']['alertsGet']['events'][number];
type AlertRecipient = RouterOutputs['settings']['alertsGet']['recipients'][number];
/** Same idea for the family sheet's wording: people/sheetText.ts owns the list of boxes. */
type SheetTextKey = RouterOutputs['settings']['sheetTextGet']['keys'][number];

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

  // ── How the masjid appears on paper and in email (0.47.0) ───────────────────
  // Contact details, the date format, and the colour printed artifacts are ruled in. Held as one
  // draft object with one Save, because they are edited together and a per-field autosave on a colour
  // picker would fire on every drag.
  type Contact = { address: string; phone: string; email: string; website: string; donatePath: string };
  const [look, setLook] = useState<{ contact: Contact; dateFormat: string; accentColor: string } | null>(null);
  const lookEff = look ?? {
    contact: appSettings.data?.contact ?? { address: '', phone: '', email: '', website: '', donatePath: '' },
    dateFormat: appSettings.data?.dateFormat ?? 'iso',
    accentColor: appSettings.data?.accentColor ?? '#0f766e',
  };
  const setContact = (patch: Partial<Contact>) => setLook({ ...lookEff, contact: { ...lookEff.contact, ...patch } });

  async function saveLook() {
    await saveSettings.mutateAsync({
      contact: lookEff.contact,
      dateFormat: lookEff.dateFormat as 'iso' | 'us' | 'uk' | 'long',
      accentColor: lookEff.accentColor,
    });
    await utils.settings.get.invalidate();
    // Finance screens read the same two values from `settings.display`, so that has to go too or the
    // year view keeps rendering yesterday's date format until something else refetches it.
    await utils.settings.display.invalidate();
    setLook(null);
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

  // ── The wording on the printed family sheet (0.48.0) ────────────────────────
  // The registry (which boxes exist, the shipped sentence for each, the tags) comes from the server, so
  // nothing here hard-codes a sentence: people/sheetText.ts is the one place the copy lives.
  //
  // Each box is pre-filled with the wording IN FORCE rather than left empty behind a placeholder — an
  // office edits real prose, and clearing a box is how they put our sentence back (the server treats an
  // empty string as "use the default").
  const sheetText = trpc.settings.sheetTextGet.useQuery();
  const saveSheetText = trpc.settings.sheetTextSet.useMutation();
  const [wording, setWording] = useState<Record<string, string>>({});
  const [wordingOpen, setWordingOpen] = useState(false);
  const wordingDirty = Object.keys(wording).length > 0;
  const boxValue = (key: SheetTextKey) => wording[key] ?? sheetText.data?.overrides[key] ?? sheetText.data?.defaults[key] ?? '';

  async function saveWording() {
    const boxes = Object.entries(wording).map(([key, text]) => ({ key: key as SheetTextKey, text }));
    await saveSheetText.mutateAsync({ boxes });
    await utils.settings.sheetTextGet.invalidate();
    setWording({});
  }

  async function resetWording() {
    await saveSheetText.mutateAsync({ reset: true });
    await utils.settings.sheetTextGet.invalidate();
    setWording({});
  }

  // Email alerts — who hears what, and which emails parents get.
  const alerts = trpc.settings.alertsGet.useQuery();
  const saveRecipient = trpc.settings.alertRecipientSave.useMutation();
  const removeRecipient = trpc.settings.alertRecipientRemove.useMutation();
  const testAlert = trpc.settings.alertTest.useMutation();
  const saveParentEmails = trpc.settings.parentEmailsSet.useMutation();
  const pauseParentMail = trpc.settings.parentMailPauseSet.useMutation();
  const [newRecipient, setNewRecipient] = useState({ email: '', label: '' });
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  async function addRecipient() {
    setAlertMsg(null);
    try {
      await saveRecipient.mutateAsync({ email: newRecipient.email.trim(), label: newRecipient.label.trim() || undefined });
      setNewRecipient({ email: '', label: '' });
      await utils.settings.alertsGet.invalidate();
    } catch (e) {
      setAlertMsg((e as Error).message);
    }
  }

  /** Tick/untick one alert for one address. The whole list is sent back, so the server stays the only
   *  place that decides what a valid event id is. */
  async function toggleEvent(r: AlertRecipient, event: AlertEvent, on: boolean) {
    setAlertMsg(null);
    const events = on ? [...r.events, event] : r.events.filter((e) => e !== event);
    try {
      await saveRecipient.mutateAsync({ id: r.id, email: r.email, label: r.label ?? undefined, events });
      await utils.settings.alertsGet.invalidate();
    } catch (e) {
      setAlertMsg((e as Error).message);
    }
  }

  async function sendAlertTest(id: string) {
    setAlertMsg(null);
    try {
      await testAlert.mutateAsync({ id });
      setAlertMsg(t('settings.alertTestOk'));
    } catch (e) {
      setAlertMsg((e as Error).message);
    }
  }

  async function togglePause() {
    await pauseParentMail.mutateAsync({ paused: !alerts.data?.parentMailPaused });
    await utils.settings.alertsGet.invalidate();
  }

  // ── Past due (0.48.0) ───────────────────────────────────────────────────────
  // Chasing an overdue balance: whether parents hear about it, after how long, and how often. Kept
  // beside the alert settings because it is the same question — who gets told what — but with numbers.
  const pastDue = trpc.settings.pastDueGet.useQuery();
  const setPastDueCfg = trpc.settings.pastDueSet.useMutation();
  const runPastDue = trpc.settings.pastDueRunNow.useMutation();
  const [pastDueMsg, setPastDueMsg] = useState<string | null>(null);
  /** Students nobody can email — every message above depends on an address existing. */
  const noEmail = trpc.settings.noEmailStudents.useQuery();

  async function savePastDue(patch: { parentEmails?: boolean; graceDays?: number; everyDays?: number }) {
    setPastDueMsg(null);
    // The number inputs fire on every keystroke, and an empty box reads as NaN — the server would refuse
    // it, so drop it here rather than showing a validation error for a field mid-edit.
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v !== 'number' || Number.isFinite(v)));
    if (!Object.keys(clean).length) return;
    await setPastDueCfg.mutateAsync(clean);
    await utils.settings.pastDueGet.invalidate();
  }

  async function runPastDueNow() {
    setPastDueMsg(null);
    try {
      const r = await runPastDue.mutateAsync();
      setPastDueMsg(t('settings.pastDueRan', { emailed: r.emailed, overdue: r.overdue, unreachable: r.unreachable }));
      await utils.settings.pastDueGet.invalidate();
    } catch (e) {
      setPastDueMsg((e as Error).message);
    }
  }

  async function toggleParentEmail(key: 'receipt' | 'autopayFailure') {
    const cur = alerts.data?.parentEmails;
    if (!cur) return;
    await saveParentEmails.mutateAsync({ [key]: !cur[key] });
    await utils.settings.alertsGet.invalidate();
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

      {/* ── How the masjid appears on paper and in email (0.47.0) ───────────────
          The contact details close a real gap: the family sheet, the statement and every parent email
          end by asking the parent to "tell the office", and until now none of them said how. */}
      {appSettings.data && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('settings.appearance')}</h2></div>
          <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.appearanceHint')}</p>

          <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
            <div className="field" style={{ flex: '2 1 18rem' }}>
              <label className="label">{t('settings.contactAddress')}</label>
              <input className="input glass-inset" value={lookEff.contact.address} onChange={(e) => setContact({ address: e.target.value })} maxLength={240} />
            </div>
            <div className="field" style={{ flex: '1 1 10rem' }}>
              <label className="label">{t('settings.contactPhone')}</label>
              {/* The same as-you-type mask as every guardian number (lib/phone.ts), so the masjid's own
                  number is written the way the rest of the app writes numbers — including on the
                  printed sheet, the invoice and the statement, which is where it is read. It leaves a
                  non-US number alone rather than mangling it. */}
              <input
                className="input glass-inset"
                type="tel"
                inputMode="tel"
                value={formatUsPhone(lookEff.contact.phone)}
                onChange={(e) => setContact({ phone: formatUsPhone(e.target.value) })}
                maxLength={60}
              />
            </div>
          </div>
          <div className="inline-form glass-inset">
            <div className="field" style={{ flex: '1 1 14rem' }}>
              <label className="label">{t('settings.contactEmail')}</label>
              <input className="input glass-inset" value={lookEff.contact.email} onChange={(e) => setContact({ email: e.target.value })} maxLength={200} />
            </div>
            <div className="field" style={{ flex: '1 1 14rem' }}>
              <label className="label">{t('settings.contactWebsite')}</label>
              <input className="input glass-inset" value={lookEff.contact.website} onChange={(e) => setContact({ website: e.target.value })} maxLength={200} />
            </div>
          </div>
          {/* Where tuition is paid online. The sheet and the statement both tell a parent to pay "on the
              madrasah's website" — only the masjid knows which page that is, since the Donations app sits
              on their own domain under a path they chose. */}
          <div className="inline-form glass-inset">
            <div className="field" style={{ flex: '1 1 14rem' }}>
              <label className="label">{t('settings.donatePath')}</label>
              <input className="input glass-inset" value={lookEff.contact.donatePath} onChange={(e) => setContact({ donatePath: e.target.value })} maxLength={200} placeholder="/donate" />
              <span className="hint">{t('settings.donatePathHint')}</span>
            </div>
            {/* What the two fields actually resolve to, so nobody has to assemble it in their head. Read
                from the saved settings, so it updates on Save rather than mid-typing. */}
            <div className="field" style={{ flex: '1 1 14rem' }}>
              <label className="label">{t('settings.donateUrlPreview')}</label>
              <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.9rem', wordBreak: 'break-all' }}>
                {appSettings.data?.donateUrl ? `(${appSettings.data.donateUrl})` : t('settings.donateUrlNone')}
              </p>
            </div>
          </div>

          <div className="inline-form glass-inset">
            <div className="field" style={{ flex: '1 1 12rem' }}>
              <label className="label">{t('settings.dateFormat')}</label>
              {/* The options SHOW their own output rather than naming a pattern — "DD/MM/YYYY" is
                  jargon, and the whole point of the setting is what the office will actually read. */}
              <select className="input glass-inset" value={lookEff.dateFormat} onChange={(e) => setLook({ ...lookEff, dateFormat: e.target.value })}>
                {(appSettings.data.dateFormats ?? []).map((f) => (
                  <option key={f.value} value={f.value}>{f.sample}</option>
                ))}
              </select>
              <span className="hint">{t('settings.dateFormatHint')}</span>
            </div>
            <div className="field" style={{ flex: '0 1 10rem' }}>
              <label className="label" htmlFor="accent">{t('settings.accent')}</label>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input id="accent" type="color" value={lookEff.accentColor} onChange={(e) => setLook({ ...lookEff, accentColor: e.target.value })} style={{ inlineSize: '2.6rem', blockSize: '2.1rem', padding: 0, border: 0, background: 'none', cursor: 'pointer' }} />
                <input className="input glass-inset" value={lookEff.accentColor} onChange={(e) => setLook({ ...lookEff, accentColor: e.target.value })} maxLength={7} style={{ inlineSize: '6rem' }} aria-label={t('settings.accent')} />
              </div>
              <span className="hint">{t('settings.accentHint')}</span>
            </div>
            <button type="button" className="btn btn--primary" onClick={saveLook} disabled={saveSettings.isPending}>{t('common.save')}</button>
            {look && <button type="button" className="btn btn--ghost" onClick={() => setLook(null)}>{t('common.cancel')}</button>}
          </div>
        </section>
      )}

      {/* ── The wording on the printed family sheet (0.48.0) ─────────────────────
          How a school asks a family to pay is the school's own voice, and the details differ per
          install in ways no default can guess — "madrasah" or "school", whether a receipt is emailed
          or handed over, what their donations page is called. Collapsed by default: eleven boxes of
          prose is a lot of page for a setting most offices will visit once. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.sheetText')}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setWordingOpen((v) => !v)}>
            {wordingOpen ? t('common.close') : t('settings.sheetTextEdit')}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: wordingOpen ? '0.75rem' : 0 }}>{t('settings.sheetTextHint')}</p>

        {wordingOpen && sheetText.data && (
          <>
            {/* The two pieces of syntax, said once. Tags come from the server so this list cannot drift
                away from what the renderer actually substitutes. */}
            <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>
              {t('settings.sheetTextTags', { tags: sheetText.data.tags.map((g) => `[${g}]`).join(' ') })}
            </p>

            {sheetText.data.keys.map((key) => {
              const custom = sheetText.data!.overrides[key] !== undefined;
              return (
                <div className="field" key={key}>
                  <label className="label" htmlFor={`sheet-${key}`}>
                    {t(`settings.sheetText_${key}`)}
                    {custom && <span className="chip is-muted" style={{ marginInlineStart: '0.4rem' }}>{t('settings.sheetTextCustom')}</span>}
                  </label>
                  <textarea
                    id={`sheet-${key}`}
                    className="textarea glass-inset"
                    style={{ minHeight: '4.5rem', fontFamily: 'inherit', fontSize: '0.9rem' }}
                    value={boxValue(key)}
                    maxLength={sheetText.data!.maxLength}
                    onChange={(e) => setWording({ ...wording, [key]: e.target.value })}
                  />
                </div>
              );
            })}

            <div className="inline-form glass-inset" style={{ alignItems: 'center' }}>
              <button type="button" className="btn btn--primary" onClick={saveWording} disabled={!wordingDirty || saveSheetText.isPending}>
                {t('common.save')}
              </button>
              {wordingDirty && <button type="button" className="btn btn--ghost" onClick={() => setWording({})}>{t('common.cancel')}</button>}
              <span className="spacer" />
              {/* Puts every box back to the shipped sentence — the way out of a half-rewritten sheet. */}
              <button type="button" className="btn btn--ghost" onClick={resetWording} disabled={saveSheetText.isPending}>
                {t('settings.sheetTextReset')}
              </button>
            </div>
            <p className="hint">{t('settings.sheetTextClearHint')}</p>
          </>
        )}
      </section>

      {/* No mail PROVIDER settings here on purpose — OpenMasjidOS owns the provider and the From
          address, so there is nothing for a masjid to configure twice. What is ours to decide is who
          gets told what, which is the section below. */}

      {/* ── Email alerts ────────────────────────────────────────────────────────
          Two separate questions that used to have no answer at all: what the school emails PARENTS,
          and who at the masjid hears when something needs a person. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head"><h2>{t('settings.alerts')}</h2></div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.alertsHint')}</p>
        {alertMsg && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{alertMsg}</div>}
        {alerts.data && !alerts.data.mailAvailable && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.alertsNoMail')}</div>}

        {/* What parents get. Invites and password resets are deliberately not switchable — they are the
            only way a parent reaches their account, so there is nothing to decide. */}
        {/* Both sub-headings carry explicit margins: there is no global heading reset in app.css, so an
            h3 would otherwise inherit the browser's own spacing. */}
        <h3 className="label" style={{ marginBlock: '0 0.4rem' }}>{t('settings.parentEmails')}</h3>
        {alerts.data && (
          <>
            {/* The master stop, FIRST and on its own — it overrides everything below it, including the
                invites and resets that are otherwise always sent. Shown as a standing warning while it
                is on, because a paused install that nobody remembers pausing looks like broken email. */}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', marginBlockEnd: '0.6rem' }}>
              <input
                type="checkbox"
                style={{ marginBlockStart: '0.2rem' }}
                checked={alerts.data.parentMailPaused}
                onChange={() => void togglePause()}
                disabled={pauseParentMail.isPending}
              />
              <span>{t('settings.parentMailPause')}<br /><span className="hint">{t('settings.parentMailPauseHint')}</span></span>
            </label>
            {alerts.data.parentMailPaused && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.parentMailPausedNotice')}</div>}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
              <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={alerts.data.parentEmails.receipt} onChange={() => void toggleParentEmail('receipt')} disabled={saveParentEmails.isPending} />
              <span>{t('settings.parentReceipt')}<br /><span className="hint">{t('settings.parentReceiptHint')}</span></span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockStart: '0.5rem', cursor: 'pointer' }}>
              <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={alerts.data.parentEmails.autopayFailure} onChange={() => void toggleParentEmail('autopayFailure')} disabled={saveParentEmails.isPending} />
              <span>{t('settings.parentAutopay')}<br /><span className="hint">{t('settings.parentAutopayHint')}</span></span>
            </label>
            <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{t('settings.parentAlwaysHint')}</p>
          </>
        )}

        {/* ── Past due (0.48.0) ────────────────────────────────────────────────
            Its own block rather than a third checkbox above, because it is not just on/off: the grace
            period and the cadence are the difference between a reminder and a nuisance. The preview is
            deliberately shown BEFORE the switch — an admin about to start emailing real families about
            money should see how many of them, and for how much, first. */}
        {pastDue.data && (
          <>
            <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.pastDue')}</h3>
            <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.pastDueHint')}</p>
            <p className="muted" style={{ fontSize: '0.9rem', marginBlock: '0 0.6rem' }}>
              {pastDue.data.overdueFamilies === 0
                ? t('settings.pastDueNone')
                : t('settings.pastDueNow', {
                    count: pastDue.data.overdueFamilies,
                    amount: formatMoney(pastDue.data.overdueCents, pastDue.data.currency),
                  })}
            </p>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ marginBlockStart: '0.2rem' }}
                checked={pastDue.data.parentEmails}
                onChange={() => void savePastDue({ parentEmails: !pastDue.data!.parentEmails })}
                disabled={setPastDueCfg.isPending}
              />
              <span>{t('settings.pastDueParents')}<br /><span className="hint">{t('settings.pastDueParentsHint')}</span></span>
            </label>
            <div className="inline-form glass-inset">
              <div className="field" style={{ flex: '0 1 9rem' }}>
                <label className="label" htmlFor="pd-grace">{t('settings.pastDueGrace')}</label>
                <input
                  id="pd-grace"
                  className="input glass-inset"
                  type="number"
                  min={0}
                  max={90}
                  value={pastDue.data.graceDays}
                  onChange={(e) => void savePastDue({ graceDays: Number(e.target.value) })}
                />
                <span className="hint">{t('settings.pastDueGraceHint')}</span>
              </div>
              <div className="field" style={{ flex: '0 1 9rem' }}>
                <label className="label" htmlFor="pd-every">{t('settings.pastDueEvery')}</label>
                <input
                  id="pd-every"
                  className="input glass-inset"
                  type="number"
                  min={1}
                  max={90}
                  value={pastDue.data.everyDays}
                  onChange={(e) => void savePastDue({ everyDays: Number(e.target.value) })}
                />
                <span className="hint">{t('settings.pastDueEveryHint')}</span>
              </div>
              {/* Runs the same job the scheduler runs, ignoring only the cadence — a person pressed it. */}
              <button type="button" className="btn btn--ghost" onClick={() => void runPastDueNow()} disabled={runPastDue.isPending}>
                {runPastDue.isPending ? t('settings.pastDueRunning') : t('settings.pastDueRunNow')}
              </button>
            </div>
            {pastDueMsg && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{pastDueMsg}</div>}
          </>
        )}

        {/* ── Families with no email address (0.48.0) ──────────────────────────
            Everything above this point is an email, so a household with no address on file receives
            none of it — silently, until a parent says they never heard anything. This is that list. */}
        <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.noEmail')}</h3>
        {noEmail.data && noEmail.data.total === 0 && <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.noEmailNone')}</p>}
        {noEmail.data && noEmail.data.total > 0 && (
          <>
            <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>
              {t('settings.noEmailHint', { students: noEmail.data.total, households: noEmail.data.households })}
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table stack-phone">
                <thead>
                  {/* No household column (0.48.0): the child's own surname is almost always the household's
                      label, so it repeated the name beside it — and what this table is FOR is ringing
                      somebody, which is the last column. */}
                  <tr>
                    <th>{t('students.name')}</th>
                    <th>{t('settings.noEmailWhoToCall')}</th>
                  </tr>
                </thead>
                <tbody>
                  {noEmail.data.students.map((s) => (
                    <tr key={s.id}>
                      <td data-label={t('students.name')}>{s.fullName}</td>
                      {/* A name and a number, because the only way to fix this is to ring them and ask. */}
                      <td data-label={t('settings.noEmailWhoToCall')}>
                        {s.guardians.length === 0 ? (
                          <span className="muted">{t('settings.noEmailNoGuardian')}</span>
                        ) : (
                          s.guardians.map((g, i) => (
                            <span key={`${s.id}-${i}`} style={{ display: 'block' }}>
                              {g.name}
                              {g.phone ? <> — <a href={telHref(g.phone)}>{formatUsPhone(g.phone)}</a></> : <span className="muted"> — {t('settings.noEmailNoPhone')}</span>}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Staff alerts: an address plus what it hears about. Adding one grants no access to anything. */}
        <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.staffAlerts')}</h3>
        <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.staffAlertsHint')}</p>
        {alerts.data && alerts.data.recipients.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('settings.alertWho')}</th>
                  {alerts.data.events.map((e) => <th key={e} style={{ fontSize: '0.72rem', whiteSpace: 'normal', minWidth: '5.5rem' }}>{t(`settings.ev_${e}`)}</th>)}
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {alerts.data.recipients.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.label ? <>{r.label}<br /><span className="hint">{r.email}</span></> : r.email}
                    </td>
                    {alerts.data!.events.map((e) => (
                      <td key={e} style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          aria-label={`${r.email} — ${t(`settings.ev_${e}`)}`}
                          checked={r.events.includes(e)}
                          disabled={saveRecipient.isPending}
                          onChange={(ev) => void toggleEvent(r, e, ev.target.checked)}
                        />
                      </td>
                    ))}
                    <td className="actions">
                      <button type="button" className="btn btn--ghost btn--sm" title={t('settings.alertSendTest')} onClick={() => void sendAlertTest(r.id)} disabled={testAlert.isPending}><Send size={14} /></button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title={t('common.remove')}
                        onClick={async () => {
                          if (!window.confirm(t('settings.alertRemoveConfirm', { email: r.email }))) return;
                          await removeRecipient.mutateAsync({ id: r.id });
                          await utils.settings.alertsGet.invalidate();
                        }}
                        disabled={removeRecipient.isPending}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {alerts.data && alerts.data.recipients.length === 0 && <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.noRecipients')}</p>}
        <div className="inline-form glass-inset">
          <div className="field" style={{ flex: '2 1 14rem' }}><label className="label">{t('settings.alertEmail')}</label><input className="input glass-inset" value={newRecipient.email} onChange={(e) => setNewRecipient({ ...newRecipient, email: e.target.value })} placeholder="office@example.org" /></div>
          <div className="field" style={{ flex: '1 1 9rem' }}><label className="label">{t('settings.alertLabel')}</label><input className="input glass-inset" value={newRecipient.label} onChange={(e) => setNewRecipient({ ...newRecipient, label: e.target.value })} placeholder={t('settings.alertLabelHint')} maxLength={80} /></div>
          <button type="button" className="btn btn--primary" onClick={() => void addRecipient()} disabled={saveRecipient.isPending || !newRecipient.email.includes('@')}>{t('settings.alertAdd')}</button>
          <p className="hint">{t('settings.alertAddHint')}</p>
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
