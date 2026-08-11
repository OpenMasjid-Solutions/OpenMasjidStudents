// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * First-time setup (0.48.0) — the five things a madrasah has to do before this app is of any use, in the
 * order they depend on each other, and then a plain explanation of what each tab is for.
 *
 * WHY IT EXISTS. Everything here was already possible and every piece of it was somewhere else: the name
 * and the colour in Settings, the Stripe account further down the same page, the roster behind a button on
 * the Students tab. An office opening this app for the first time saw an empty dashboard and a row of
 * icons, with no indication that Settings was where to start or that a spreadsheet could be imported at
 * all. This is the same handful of mutations, put in an order.
 *
 * IT OWNS NO STATE OF ITS OWN. Every step writes through the SAME procedure the Settings page uses, so
 * there is no "setup complete" flag to drift from reality and nothing to undo — a madrasah that would
 * rather work through Settings gets exactly the same result, and every step here can be revisited there
 * afterwards. What decides whether the dashboard offers this at all is simply whether there are any
 * students yet (Dashboard.tsx), which is a fact rather than a flag.
 *
 * EVERY STEP IS SKIPPABLE, and that is deliberate: a madrasah with no card payments should not be stuck on
 * the Stripe step, and one that types its roster in by hand should not be made to produce a CSV. The Next
 * button never blocks; only the individual Save buttons care whether their field is filled in.
 */
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { Check, CreditCard, Download, GraduationCap, Palette, School, Upload } from 'lucide-react';
import { fadeRise } from '../lib/motion';
import { trpc } from '../lib/trpc';
import { toCsv, downloadCsv } from '../lib/csv';
import { useWindows } from './Windows';

/** The roster importer is a big component and most of this wizard is four text fields — no reason to pull
 *  it into the bundle until somebody reaches the step that opens it. */
const ImportStudents = lazy(() => import('../routes/admin/ImportStudents').then((m) => ({ default: m.ImportStudents })));

/** The steps, in dependency order: what the madrasah is called, how it looks, how it takes money, who is
 *  in it, and then where everything lives. */
const STEPS = ['school', 'look', 'payments', 'students', 'tour'] as const;
type Step = (typeof STEPS)[number];

const LOGO_MAX_BYTES = 512 * 1024;

export function FirstRunSetup() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();
  const [step, setStep] = useState<Step>('school');
  const [msg, setMsg] = useState<string | null>(null);

  const settings = trpc.settings.get.useQuery();
  const saveSettings = trpc.settings.set.useMutation();
  const logoSet = trpc.settings.logoSet.useMutation();
  const template = trpc.people.importTemplate.useQuery();
  const stripeAccounts = trpc.settings.stripeAccountsGet.useQuery();
  const saveStripeAccount = trpc.settings.stripeAccountSet.useMutation();

  // Drafts, so a half-typed name is not written on every keystroke. `??` rather than `||` on the colour:
  // an empty string is a real saved value meaning "the default teal".
  const [name, setName] = useState<string | null>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const nameEff = name ?? settings.data?.schoolName ?? '';
  const colourEff = colour ?? settings.data?.accentColor ?? '#0f766e';
  const accountEff = account ?? stripeAccounts.data?.chosenId ?? '';

  const at = STEPS.indexOf(step);
  const go = (d: 1 | -1) => {
    setMsg(null);
    setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, at + d))]);
  };

  async function saveName() {
    setMsg(null);
    if (!nameEff.trim()) return;
    await saveSettings.mutateAsync({ schoolName: nameEff.trim() });
    await utils.settings.get.invalidate();
    setName(null);
    setMsg(t('firstRun.saved'));
  }

  async function saveColour() {
    setMsg(null);
    await saveSettings.mutateAsync({ accentColor: colourEff });
    await utils.settings.get.invalidate();
    // The printed artifacts read this on the server, and the finance screens read it through
    // `settings.display` — so that has to go too or the year view keeps yesterday's colour.
    await utils.settings.display.invalidate();
    setColour(null);
    setMsg(t('firstRun.saved'));
  }

  async function pickLogo(file: File | null) {
    setMsg(null);
    if (!file) return;
    // Checked here as well as on the server so an oversized file fails instantly and locally, rather than
    // after the browser has base64'd a 10 MB photo and pushed it at the server.
    if (file.size > LOGO_MAX_BYTES) return setMsg(t('settings.logoTooBig'));
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('read_failed'));
        r.readAsDataURL(file);
      });
      await logoSet.mutateAsync({ dataUri });
      await utils.settings.get.invalidate();
      setMsg(t('firstRun.saved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function saveAccount() {
    setMsg(null);
    try {
      const r = await saveStripeAccount.mutateAsync({ accountId: accountEff });
      setMsg(r.ready ? t('settings.paymentsReady') : t('settings.paymentsNotReady'));
      setAccount(null);
      await utils.settings.stripeAccountsGet.invalidate();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  function downloadTemplate() {
    if (!template.data) return;
    downloadCsv('students-template.csv', toCsv(template.data.fields.map((f) => f.label), template.data.example));
  }

  /** The roster importer, in its own window — the same one the Students tab opens, not a second copy. */
  function openImport() {
    open({
      title: t('students.import'),
      wide: true,
      dedupeKey: 'import:students',
      icon: <Upload size={15} />,
      node: (
        <Suspense fallback={<p className="empty">{t('common.loading')}</p>}>
          <ImportStudents />
        </Suspense>
      ),
    });
  }

  /** What each tab is for, in the dock's own order so the list reads left to right along it. */
  const TOUR = ['dashboard', 'students', 'year', 'structure', 'billing', 'staff', 'settings'] as const;

  return (
    <motion.div variants={fadeRise} initial="initial" animate="animate">
      {/* Where you are, and how much is left — five steps is short enough to show all of them. */}
      <ol className="setup-steps" aria-label={t('firstRun.title')}>
        {STEPS.map((s, i) => (
          <li key={s} className={i === at ? 'is-now' : i < at ? 'is-done' : ''}>
            <span className="n">{i < at ? <Check size={13} /> : i + 1}</span>
            {t(`firstRun.step_${s}`)}
          </li>
        ))}
      </ol>

      {msg && <div className="notice" style={{ marginBlockEnd: '0.75rem' }}>{msg}</div>}

      {step === 'school' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><School size={16} /> {t('firstRun.schoolTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.schoolHint')}</p>
          <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
            <div className="field" style={{ flex: '2 1 16rem' }}>
              <label className="label" htmlFor="fr-name">{t('settings.schoolName')}</label>
              <input id="fr-name" className="input glass-inset" value={nameEff} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder={t('firstRun.namePlaceholder')} />
            </div>
            <button type="button" className="btn btn--primary" onClick={() => void saveName()} disabled={saveSettings.isPending || !nameEff.trim()}>
              {t('common.save')}
            </button>
          </div>
        </section>
      )}

      {step === 'look' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><Palette size={16} /> {t('firstRun.lookTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.lookHint')}</p>
          <div className="inline-form glass-inset" style={{ marginBlockStart: 0, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '1 1 14rem' }}>
              <label className="label" htmlFor="fr-logo">{t('firstRun.logo')}</label>
              <input id="fr-logo" className="input glass-inset" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void pickLogo(e.target.files?.[0] ?? null)} />
              <span className="hint">{t('settings.logoHint')}</span>
            </div>
            {settings.data?.logo && <img src={settings.data.logo} alt="" style={{ maxHeight: '3rem', maxWidth: '9rem', borderRadius: '0.4rem' }} />}
          </div>
          <div className="inline-form glass-inset" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 12rem' }}>
              <label className="label" htmlFor="fr-colour">{t('settings.accent')}</label>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input id="fr-colour" type="color" value={colourEff} onChange={(e) => setColour(e.target.value)} style={{ inlineSize: '2.6rem', blockSize: '2.1rem', padding: 0, border: 0, background: 'none', cursor: 'pointer' }} />
                <input className="input glass-inset" value={colourEff} onChange={(e) => setColour(e.target.value)} maxLength={7} style={{ inlineSize: '6rem' }} aria-label={t('settings.accent')} />
              </div>
              <span className="hint">{t('settings.accentHint')}</span>
            </div>
            <button type="button" className="btn btn--primary" onClick={() => void saveColour()} disabled={saveSettings.isPending}>{t('common.save')}</button>
          </div>
        </section>
      )}

      {step === 'payments' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><CreditCard size={16} /> {t('firstRun.paymentsTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.paymentsHint')}</p>
          {stripeAccounts.data && stripeAccounts.data.accounts.length === 0 ? (
            /* No accounts in the vault is not an error here — plenty of madāris take only cash, and the
               office can come back to this in Settings once they have set one up in OpenMasjidOS. */
            <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.paymentsNoAccounts')}</p>
          ) : (
            <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
              <div className="field" style={{ flex: '2 1 16rem' }}>
                <label className="label" htmlFor="fr-stripe">{t('settings.paymentsAccount')}</label>
                <select id="fr-stripe" className="input glass-inset" value={accountEff} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">{t('settings.paymentsChoose')}</option>
                  {(stripeAccounts.data?.accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn btn--primary" onClick={() => void saveAccount()} disabled={saveStripeAccount.isPending || !accountEff}>
                {t('common.save')}
              </button>
            </div>
          )}
        </section>
      )}

      {step === 'students' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><GraduationCap size={16} /> {t('firstRun.studentsTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.studentsHint')}</p>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn--primary" onClick={openImport}>
              <Upload size={15} /> {t('students.import')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={downloadTemplate} disabled={!template.data}>
              <Download size={15} /> {t('import.downloadTemplate')}
            </button>
          </div>
          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>{t('import.templateHint')}</p>
        </section>
      )}

      {step === 'tour' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2>{t('firstRun.tourTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.tourHint')}</p>
          <dl className="tour-list">
            {TOUR.map((s) => (
              <div key={s}>
                <dt>{t(`nav.${s}`)}</dt>
                <dd>{t(`firstRun.tour_${s}`)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="inline-form glass-inset" style={{ alignItems: 'center' }}>
        <button type="button" className="btn btn--ghost" onClick={() => go(-1)} disabled={at === 0}>{t('common.back')}</button>
        <span className="spacer" />
        <span className="hint">{t('firstRun.of', { n: at + 1, total: STEPS.length })}</span>
        {at < STEPS.length - 1 && (
          <button type="button" className="btn btn--primary" onClick={() => go(1)}>{t('firstRun.next')}</button>
        )}
      </div>
    </motion.div>
  );
}
