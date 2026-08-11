// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * First-time setup (0.48.0) — everything a madrasah has to put in place before this app can bill
 * anybody, in the order the pieces depend on each other, and then a plain explanation of what each tab
 * is for.
 *
 * WHY IT EXISTS. Everything here was already possible and every piece of it was somewhere else: the name
 * and the colour in Settings, the school year and the classes on the Structure tab, fee plans on Billing,
 * the Stripe account further down Settings, the roster behind a button on Students. An office opening
 * this app for the first time saw an empty dashboard and a row of icons, with no indication of which tab
 * to start on — or that three of those tabs had to be visited before an invoice could exist at all. This
 * is the same handful of mutations, put in an order.
 *
 * THE ORDER IS A DEPENDENCY ORDER, NOT A PREFERENCE (this is the whole point of the middle steps):
 *   - a school YEAR decides which months exist, so it comes before anything that bills a month;
 *   - TERMS are what a `per_term` plan bills against — without them such a plan silently bills nothing,
 *     so terms are offered beside the year rather than left to be discovered later;
 *   - COURSES → CLASSES and FEE PLANS have to exist before the roster import, because the importer
 *     RESOLVES its Class and Fee plan columns against rows already in the database and refuses a file
 *     naming something that does not exist ("create it first, or clear the column"). Importing first is
 *     therefore the one order that produces an error, which is exactly the order the app used to suggest.
 *
 * IT OWNS NO STATE OF ITS OWN. Every step writes through the SAME procedure its normal tab uses, so
 * there is no "setup complete" flag to drift from reality and nothing to undo — a madrasah that would
 * rather work through the tabs gets exactly the same result, and every step here can be revisited there
 * afterwards. Each step also LISTS WHAT ALREADY EXISTS, so a half-configured install shows its own
 * progress instead of inviting a second copy of everything. What decides whether the dashboard offers
 * this at all is simply whether there are any students yet (Dashboard.tsx), which is a fact rather than
 * a flag.
 *
 * EVERY STEP IS SKIPPABLE, and that is deliberate: a madrasah with no card payments should not be stuck
 * on the Stripe step, one that bills a flat monthly fee needs no terms, and one that types its roster in
 * by hand should not be made to produce a CSV. The Next button never blocks; only the individual Save
 * buttons care whether their field is filled in.
 */
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  Check,
  CreditCard,
  Download,
  GraduationCap,
  Mail,
  Palette,
  School,
  Upload,
  Wallet,
} from 'lucide-react';
import { fadeRise } from '../lib/motion';
import { trpc } from '../lib/trpc';
import { toCsv, downloadCsv } from '../lib/csv';
import { formatMoney, parseCents } from '../lib/money';
import { MONTH_NAMES, schoolYearSpan } from '../lib/months';
import { SETUP_STEPS, SETUP_TOUR, type SetupStep } from './firstRunSteps';
import { useWindows } from './Windows';

/** The roster importer is a big component and most of this wizard is text fields — no reason to pull it
 *  into the bundle until somebody reaches the step that opens it. */
const ImportStudents = lazy(() => import('../routes/admin/ImportStudents').then((m) => ({ default: m.ImportStudents })));

/** The steps and the tab list live in `firstRunSteps.ts` — the ORDER is the load-bearing part (see the
 *  header and that file), and keeping it out of this component is what lets a test pin it down. */
const STEPS = SETUP_STEPS;
type Step = SetupStep;

const LOGO_MAX_BYTES = 512 * 1024;

/**
 * What to call a year nobody has named yet — "2026–27" when it wraps into the next calendar year,
 * plain "2026" when it starts and ends inside one.
 *
 * Offered rather than imposed: it is a placeholder that is used when the field is left alone, because a
 * label is a display string with no meaning to the billing code, and making somebody type the obvious
 * thing is the kind of friction this wizard exists to remove.
 */
function suggestYearLabel(startYear: string, startMonth: string, endMonth: string): string {
  const y = Number(startYear);
  if (!y || !startMonth || !endMonth) return '';
  const wraps = Number(endMonth) < Number(startMonth);
  return wraps ? `${y}–${String((y + 1) % 100).padStart(2, '0')}` : String(y);
}

export function FirstRunSetup() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const { open } = useWindows();
  const [step, setStep] = useState<Step>('school');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const settings = trpc.settings.get.useQuery();
  const saveSettings = trpc.settings.set.useMutation();
  const logoSet = trpc.settings.logoSet.useMutation();
  const template = trpc.people.importTemplate.useQuery();
  const stripeAccounts = trpc.settings.stripeAccountsGet.useQuery();
  const saveStripeAccount = trpc.settings.stripeAccountSet.useMutation();

  // No school id is passed to anything below. On a first run there is one school by definition, and the
  // server falls back to it (`fallbackSchool`); a madrasah that later runs a second school sets its
  // calendar and courses up on the Structure tab, where there is a switcher to say which one is meant.
  const years = trpc.structure.schoolYearList.useQuery();
  const yearCreate = trpc.structure.schoolYearCreate.useMutation();
  const tree = trpc.structure.courseTree.useQuery();
  const courseCreate = trpc.structure.courseCreate.useMutation();
  const classCreate = trpc.structure.classCreate.useMutation();
  const plans = trpc.billing.feePlanList.useQuery();
  const planCreate = trpc.billing.feePlanCreate.useMutation();
  const link = trpc.settings.linkStatus.useQuery();
  const mailTest = trpc.settings.mailTest.useMutation();

  /** Terms belong to a year, so they hang off the current one — which is also the year just created,
   *  since the first year created for a school becomes current server-side. */
  const currentYear = years.data?.find((y) => y.isCurrent) ?? years.data?.[0];
  const termsQ = trpc.structure.termList.useQuery({ schoolYearId: currentYear?.id ?? '' }, { enabled: !!currentYear });
  const termCreate = trpc.structure.termCreate.useMutation();

  // Drafts, so a half-typed name is not written on every keystroke. `??` rather than `||` on the colour:
  // an empty string is a real saved value meaning "the default teal".
  const [name, setName] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const nameEff = name ?? settings.data?.schoolName ?? '';
  const currencyEff = currency ?? settings.data?.currency ?? 'usd';
  const colourEff = colour ?? settings.data?.accentColor ?? '#0f766e';
  const accountEff = account ?? stripeAccounts.data?.chosenId ?? '';

  const thisYear = new Date().getFullYear();
  const [newYear, setNewYear] = useState({ label: '', startYear: String(thisYear), startMonth: '', endMonth: '' });
  const [newTerm, setNewTerm] = useState({ name: '', startDate: '', endDate: '' });
  const [newCourse, setNewCourse] = useState('');
  /** Per-course "add a class" input, keyed by course id — so two courses can be filled in at once. */
  const [newClass, setNewClass] = useState<Record<string, string>>({});
  const [newPlan, setNewPlan] = useState({ name: '', amount: '', cadence: 'monthly' });
  const [testTo, setTestTo] = useState('');

  const money = (c: number) => formatMoney(c, settings.data?.currency ?? 'usd');
  const suggestedLabel = suggestYearLabel(newYear.startYear, newYear.startMonth, newYear.endMonth);

  const at = STEPS.indexOf(step);
  const go = (d: 1 | -1) => {
    setMsg(null);
    setErr(null);
    setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, at + d))]);
  };

  /** One place to run a mutation, report a server error as a readable line, and say "Saved" when it
   *  worked — the same shape the Structure tab uses, for the same reason. */
  async function run(fn: () => Promise<unknown>, after?: () => void): Promise<void> {
    setMsg(null);
    setErr(null);
    try {
      await fn();
      after?.();
      setMsg(t('firstRun.saved'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function saveName() {
    if (!nameEff.trim()) return;
    await run(
      async () => {
        await saveSettings.mutateAsync({ schoolName: nameEff.trim(), currency: currencyEff as 'usd' | 'cad' | 'gbp' | 'eur' });
        await Promise.all([utils.settings.get.invalidate(), utils.settings.display.invalidate()]);
      },
      () => {
        setName(null);
        setCurrency(null);
      },
    );
  }

  async function saveColour() {
    await run(
      async () => {
        await saveSettings.mutateAsync({ accentColor: colourEff });
        // The printed artifacts read this on the server, and the finance screens read it through
        // `settings.display` — so that has to go too or the year view keeps yesterday's colour.
        await Promise.all([utils.settings.get.invalidate(), utils.settings.display.invalidate()]);
      },
      () => setColour(null),
    );
  }

  async function pickLogo(file: File | null) {
    setMsg(null);
    setErr(null);
    if (!file) return;
    // Checked here as well as on the server so an oversized file fails instantly and locally, rather than
    // after the browser has base64'd a 10 MB photo and pushed it at the server.
    if (file.size > LOGO_MAX_BYTES) return setErr(t('settings.logoTooBig'));
    await run(async () => {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('read_failed'));
        r.readAsDataURL(file);
      });
      await logoSet.mutateAsync({ dataUri });
      await utils.settings.get.invalidate();
    });
  }

  async function addYear(e: FormEvent) {
    e.preventDefault();
    if (!newYear.startMonth || !newYear.endMonth) return;
    await run(
      async () => {
        await yearCreate.mutateAsync({
          label: (newYear.label.trim() || suggestedLabel).slice(0, 160),
          startYear: Number(newYear.startYear),
          startMonth: Number(newYear.startMonth),
          endMonth: Number(newYear.endMonth),
        });
        // The year decides the year view's columns and which months Generate offers, so both refresh.
        await Promise.all([utils.structure.schoolYearList.invalidate(), utils.billing.yearGrid.invalidate(), utils.billing.billFromMonths.invalidate()]);
      },
      () => setNewYear({ label: '', startYear: String(thisYear), startMonth: '', endMonth: '' }),
    );
  }

  async function addTerm(e: FormEvent) {
    e.preventDefault();
    if (!currentYear || !newTerm.name.trim()) return;
    await run(
      async () => {
        await termCreate.mutateAsync({
          schoolYearId: currentYear.id,
          name: newTerm.name.trim(),
          startDate: newTerm.startDate || undefined,
          endDate: newTerm.endDate || undefined,
        });
        await utils.structure.termList.invalidate();
      },
      () => setNewTerm({ name: '', startDate: '', endDate: '' }),
    );
  }

  async function addCourse(e: FormEvent) {
    e.preventDefault();
    if (!newCourse.trim()) return;
    await run(
      async () => {
        await courseCreate.mutateAsync({ name: newCourse.trim() });
        await utils.structure.courseTree.invalidate();
      },
      () => setNewCourse(''),
    );
  }

  async function addClass(e: FormEvent, courseId: string) {
    e.preventDefault();
    const name = (newClass[courseId] ?? '').trim();
    if (!name) return;
    await run(
      async () => {
        await classCreate.mutateAsync({ courseId, name });
        await Promise.all([utils.structure.courseTree.invalidate(), utils.structure.studentsByClass.invalidate()]);
      },
      () => setNewClass((s) => ({ ...s, [courseId]: '' })),
    );
  }

  async function addPlan(e: FormEvent) {
    e.preventDefault();
    const cents = parseCents(newPlan.amount);
    if (!newPlan.name.trim() || !cents || cents < 1) return;
    await run(
      async () => {
        await planCreate.mutateAsync({
          name: newPlan.name.trim(),
          amountCents: cents,
          cadence: newPlan.cadence as 'monthly' | 'per_term' | 'one_time',
        });
        await utils.billing.feePlanList.invalidate();
      },
      () => setNewPlan({ name: '', amount: '', cadence: 'monthly' }),
    );
  }

  async function saveAccount() {
    setMsg(null);
    setErr(null);
    try {
      const r = await saveStripeAccount.mutateAsync({ accountId: accountEff });
      setMsg(r.ready ? t('settings.paymentsReady') : t('settings.paymentsNotReady'));
      setAccount(null);
      await utils.settings.stripeAccountsGet.invalidate();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function sendTest(e: FormEvent) {
    e.preventDefault();
    if (!testTo.trim()) return;
    setMsg(null);
    setErr(null);
    try {
      await mailTest.mutateAsync({ to: testTo.trim() });
      setMsg(t('firstRun.emailSent', { to: testTo.trim() }));
    } catch (e2) {
      setErr((e2 as Error).message);
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

  const TOUR = SETUP_TOUR;

  const yearList = years.data ?? [];
  const courses = tree.data ?? [];
  const planList = plans.data ?? [];
  const termList = termsQ.data ?? [];
  /** A `per_term` plan with no terms to bill against is a plan that generates nothing (invoices.ts
   *  skips it on a month period). Worth saying at the moment the plan is being made, not later. */
  const perTermWithoutTerms = planList.some((p) => p.cadence === 'per_term') && termList.length === 0;

  return (
    <motion.div variants={fadeRise} initial="initial" animate="animate">
      {/* Where you are, and how much is left. */}
      <ol className="setup-steps" aria-label={t('firstRun.title')}>
        {STEPS.map((s, i) => (
          <li key={s} className={i === at ? 'is-now' : i < at ? 'is-done' : ''}>
            <span className="n">{i < at ? <Check size={13} /> : i + 1}</span>
            {t(`firstRun.step_${s}`)}
          </li>
        ))}
      </ol>

      {msg && <div className="notice" style={{ marginBlockEnd: '0.75rem' }}>{msg}</div>}
      {err && <p className="form-error">{err}</p>}

      {step === 'school' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><School size={16} /> {t('firstRun.schoolTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.schoolHint')}</p>
          <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
            <div className="field" style={{ flex: '2 1 16rem' }}>
              <label className="label" htmlFor="fr-name">{t('settings.schoolName')}</label>
              <input id="fr-name" className="input glass-inset" value={nameEff} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder={t('firstRun.namePlaceholder')} />
            </div>
            {/* Currency sits here rather than on the payments step because it is not about cards: every
                amount in the app — a cash payment, a printed sheet, a fee plan — is written in it, so it
                belongs with the name and wants deciding before any money is recorded. */}
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label" htmlFor="fr-currency">{t('settings.currency')}</label>
              <select id="fr-currency" className="input glass-inset" value={currencyEff} onChange={(e) => setCurrency(e.target.value)}>
                {['usd', 'cad', 'gbp', 'eur'].map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
              </select>
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
          <div className="inline-form glass-inset" style={{ marginBlockStart: 0 }}>
            <div className="field" style={{ flex: '1 1 14rem' }}>
              <label className="label" htmlFor="fr-logo">{t('firstRun.logo')}</label>
              <input id="fr-logo" className="input glass-inset" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void pickLogo(e.target.files?.[0] ?? null)} />
              <span className="hint">{t('settings.logoHint')}</span>
            </div>
            {settings.data?.logo && <img src={settings.data.logo} alt="" style={{ maxHeight: '3rem', maxWidth: '9rem', borderRadius: '0.4rem' }} />}
          </div>
          <div className="inline-form glass-inset">
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

      {step === 'year' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><CalendarDays size={16} /> {t('firstRun.yearTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.yearHint')}</p>

          {yearList.length > 0 && (
            <div className="chip-row" style={{ marginBlockEnd: '0.75rem' }}>
              {yearList.map((y) => (
                <span key={y.id} className="chip">
                  {y.label} · {schoolYearSpan(y.startYear, y.startMonth, y.endMonth)}
                  {y.isCurrent && ` · ${t('structure.current')}`}
                </span>
              ))}
            </div>
          )}

          <form className="inline-form glass-inset" style={{ marginBlockStart: 0 }} onSubmit={addYear}>
            <div className="field" style={{ flex: '1 1 11rem' }}>
              <label className="label" htmlFor="fr-year-label">{t('structure.yearName')}</label>
              <input id="fr-year-label" className="input glass-inset" value={newYear.label} onChange={(e) => setNewYear({ ...newYear, label: e.target.value })} placeholder={suggestedLabel || t('structure.yearPlaceholder')} maxLength={160} />
            </div>
            <div className="field" style={{ flex: '0 1 7rem' }}>
              <label className="label" htmlFor="fr-year-start">{t('structure.startsIn')}</label>
              <input id="fr-year-start" className="input glass-inset" type="number" min={2000} max={2200} value={newYear.startYear} onChange={(e) => setNewYear({ ...newYear, startYear: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label" htmlFor="fr-year-from">{t('structure.from')}</label>
              <select id="fr-year-from" className="input glass-inset" value={newYear.startMonth} onChange={(e) => setNewYear({ ...newYear, startMonth: e.target.value })} required>
                <option value="">{t('common.select')}</option>
                {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label" htmlFor="fr-year-to">{t('structure.to')}</label>
              <select id="fr-year-to" className="input glass-inset" value={newYear.endMonth} onChange={(e) => setNewYear({ ...newYear, endMonth: e.target.value })} required>
                <option value="">{t('common.select')}</option>
                {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={yearCreate.isPending || !newYear.startMonth || !newYear.endMonth}>{t('structure.addYear')}</button>
          </form>
          <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{t('structure.wrapHint')}</p>

          {/* Terms — optional, and only meaningful once a year exists to hang them off. */}
          {currentYear && (
            <>
              <h3 style={{ margin: '1.1rem 0 0.25rem', fontSize: '0.95rem' }}>{t('firstRun.termsTitle', { year: currentYear.label })}</h3>
              <p className="hint" style={{ marginBlockEnd: '0.6rem' }}>{t('firstRun.termsHint')}</p>
              {termList.length > 0 && (
                <div className="chip-row" style={{ marginBlockEnd: '0.6rem' }}>
                  {termList.map((tm) => <span key={tm.id} className="chip">{tm.name}</span>)}
                </div>
              )}
              <form className="inline-form glass-inset" style={{ marginBlockStart: 0 }} onSubmit={addTerm}>
                <div className="field" style={{ flex: '1 1 11rem' }}>
                  <label className="label" htmlFor="fr-term">{t('structure.termName')}</label>
                  <input id="fr-term" className="input glass-inset" value={newTerm.name} onChange={(e) => setNewTerm({ ...newTerm, name: e.target.value })} placeholder={t('structure.termPlaceholder')} maxLength={160} />
                </div>
                <div className="field" style={{ flex: '0 1 10rem' }}>
                  <label className="label" htmlFor="fr-term-from">{t('structure.termStart')}</label>
                  <input id="fr-term-from" className="input glass-inset" type="date" value={newTerm.startDate} onChange={(e) => setNewTerm({ ...newTerm, startDate: e.target.value })} />
                </div>
                <div className="field" style={{ flex: '0 1 10rem' }}>
                  <label className="label" htmlFor="fr-term-to">{t('structure.termEnd')}</label>
                  <input id="fr-term-to" className="input glass-inset" type="date" value={newTerm.endDate} onChange={(e) => setNewTerm({ ...newTerm, endDate: e.target.value })} />
                </div>
                <button type="submit" className="btn btn--ghost" disabled={termCreate.isPending || !newTerm.name.trim()}>{t('structure.addTerm')}</button>
              </form>
            </>
          )}
        </section>
      )}

      {step === 'classes' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><BookOpen size={16} /> {t('firstRun.classesTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.classesHint')}</p>

          {courses.map((c) => (
            <div key={c.id} className="glass-inset" style={{ padding: '0.7rem 0.8rem', borderRadius: 'var(--radius-button)', marginBlockEnd: '0.6rem' }}>
              <strong style={{ fontSize: '0.92rem' }}>{c.name}</strong>
              {c.classes.length > 0 ? (
                <div className="chip-row" style={{ marginBlock: '0.45rem' }}>
                  {c.classes.map((k) => <span key={k.id} className="chip">{k.name}</span>)}
                </div>
              ) : (
                <p className="hint" style={{ marginBlock: '0.35rem' }}>{t('firstRun.noClassesYet')}</p>
              )}
              <form className="inline-form" style={{ marginBlockStart: 0 }} onSubmit={(e) => void addClass(e, c.id)}>
                <div className="field" style={{ flex: '1 1 11rem' }}>
                  <label className="label" htmlFor={`fr-class-${c.id}`}>{t('structure.className')}</label>
                  <input id={`fr-class-${c.id}`} className="input glass-inset" value={newClass[c.id] ?? ''} onChange={(e) => setNewClass({ ...newClass, [c.id]: e.target.value })} placeholder={t('structure.classPlaceholder')} maxLength={160} />
                </div>
                <button type="submit" className="btn btn--ghost" disabled={classCreate.isPending || !(newClass[c.id] ?? '').trim()}>{t('structure.addClass')}</button>
              </form>
            </div>
          ))}

          <form className="inline-form glass-inset" style={{ marginBlockStart: 0 }} onSubmit={addCourse}>
            <div className="field" style={{ flex: '1 1 13rem' }}>
              <label className="label" htmlFor="fr-course">{t('structure.courseName')}</label>
              <input id="fr-course" className="input glass-inset" value={newCourse} onChange={(e) => setNewCourse(e.target.value)} placeholder={t('structure.coursePlaceholder')} maxLength={160} />
            </div>
            <button type="submit" className="btn btn--primary" disabled={courseCreate.isPending || !newCourse.trim()}>{t('structure.addCourse')}</button>
          </form>
          <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{t('firstRun.classesImportHint')}</p>
        </section>
      )}

      {step === 'fees' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><Wallet size={16} /> {t('firstRun.feesTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.feesHint')}</p>

          {planList.length > 0 && (
            <div className="chip-row" style={{ marginBlockEnd: '0.75rem' }}>
              {planList.map((p) => (
                <span key={p.id} className="chip">{p.name} · {money(p.amountCents)} · {t(`billing.cad_${p.cadence}`)}</span>
              ))}
            </div>
          )}

          {perTermWithoutTerms && (
            <div className="notice notice--warn" style={{ marginBlockEnd: '0.75rem' }}>
              <AlertTriangle size={14} style={{ verticalAlign: '-2px', marginInlineEnd: '0.35rem' }} />
              {t('firstRun.feesNeedTerms')}
            </div>
          )}

          <form className="inline-form glass-inset" style={{ marginBlockStart: 0 }} onSubmit={addPlan}>
            <div className="field" style={{ flex: '1 1 11rem' }}>
              <label className="label" htmlFor="fr-plan">{t('billing.planName')}</label>
              <input id="fr-plan" className="input glass-inset" value={newPlan.name} onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })} placeholder={t('firstRun.planPlaceholder')} maxLength={160} />
            </div>
            <div className="field" style={{ flex: '0 1 8rem' }}>
              <label className="label" htmlFor="fr-plan-amount">{t('billing.amount')}</label>
              <input id="fr-plan-amount" className="input glass-inset" type="number" step="0.01" min="0" value={newPlan.amount} onChange={(e) => setNewPlan({ ...newPlan, amount: e.target.value })} />
            </div>
            <div className="field" style={{ flex: '0 1 9rem' }}>
              <label className="label" htmlFor="fr-plan-cadence">{t('billing.cadence')}</label>
              <select id="fr-plan-cadence" className="input glass-inset" value={newPlan.cadence} onChange={(e) => setNewPlan({ ...newPlan, cadence: e.target.value })}>
                {['monthly', 'per_term', 'one_time'].map((c) => <option key={c} value={c}>{t(`billing.cad_${c}`)}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={planCreate.isPending || !newPlan.name.trim() || !newPlan.amount}>{t('billing.addPlan')}</button>
          </form>
          <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{t('firstRun.feesOverrideHint')}</p>
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

      {step === 'email' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><Mail size={16} /> {t('firstRun.emailTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.emailHint')}</p>
          {/* Nothing here is configured in THIS app — OpenMasjidOS owns the mail provider and the From
              address. What the office needs at setup time is to know whether a parent can actually be
              reached, because an invite, a receipt and an overdue reminder all fail SILENTLY otherwise. */}
          {link.data && (
            <ul className="setup-checks">
              <li className={link.data.mailAvailable ? 'is-ok' : 'is-off'}>
                {link.data.mailAvailable ? <Check size={14} /> : <AlertTriangle size={14} />}
                {link.data.mailAvailable ? t('firstRun.emailOkMail') : t('firstRun.emailNoMail')}
              </li>
              <li className={link.data.publicUrl ? 'is-ok' : 'is-off'}>
                {link.data.publicUrl ? <Check size={14} /> : <AlertTriangle size={14} />}
                {link.data.publicUrl ? t('firstRun.emailOkUrl') : t('firstRun.emailNoUrl')}
              </li>
            </ul>
          )}
          {link.data?.mailAvailable && (
            <form className="inline-form glass-inset" style={{ marginBlockStart: 0 }} onSubmit={sendTest}>
              <div className="field" style={{ flex: '2 1 15rem' }}>
                <label className="label" htmlFor="fr-mail-to">{t('firstRun.emailTestTo')}</label>
                <input id="fr-mail-to" className="input glass-inset" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.org" maxLength={320} />
              </div>
              <button type="submit" className="btn btn--primary" disabled={mailTest.isPending || !testTo.trim()}>{t('firstRun.emailSend')}</button>
            </form>
          )}
        </section>
      )}

      {step === 'students' && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head"><h2><GraduationCap size={16} /> {t('firstRun.studentsTitle')}</h2></div>
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>{t('firstRun.studentsHint')}</p>
          {/* Said here rather than only in the importer's own errors: the columns resolve against the
              classes and plans made two steps ago, so this is the moment it is useful to know. */}
          <p className="hint" style={{ marginBlockEnd: '0.75rem' }}>
            {t('firstRun.studentsReady', {
              classes: courses.reduce((n, c) => n + c.classes.length, 0),
              plans: planList.length,
            })}
          </p>
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
