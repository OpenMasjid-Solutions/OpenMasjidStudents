// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE PUBLIC ADMISSIONS FORM'S SETTINGS (0.52.0, CLAUDE.md §4a Phase 2, §14).
 *
 * This screen switches on the only unauthenticated write surface in the app, so it has to SAY that
 * rather than present a toggle like any other. Three things it states out loud, in the copy and not
 * only in this comment, because an office turning something on deserves to know what they are
 * turning on:
 *
 *  - the form is reachable **from the internet** by anybody, with no sign-in;
 *  - an allowlisted origin can **embed** it, so that list is who may put this form on their site;
 *  - **closing intake** does not silently discard — the form keeps answering and says the madrasah
 *    is not taking inquiries at the moment.
 *
 * The switch that matters is instant-apply and audited both ways on the server, like the
 * webhook-naming toggle: "when did this start?" is a question somebody will ask.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Globe, Plus, X } from 'lucide-react';
import { trpc, type RouterOutputs } from '../lib/trpc';

type TextKey = RouterOutputs['admissions']['settingsGet']['textKeys'][number];

export function AdmissionsSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.admissions.settingsGet.useQuery();
  const save = trpc.admissions.settingsSet.useMutation();
  const saveText = trpc.admissions.textSet.useMutation();
  const startKiosk = trpc.admissions.kioskStart.useMutation();
  const revoke = trpc.admissions.kioskRevoke.useMutation();
  const devices = trpc.admissions.kioskList.useQuery();

  const [origin, setOrigin] = useState('');
  /** Shown once, like every other token this app mints — it is stored hashed. */
  const [kioskLink, setKioskLink] = useState('');
  const [wording, setWording] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Clear the "saved" note when the server's answer changes underneath us, so it never sits there
  // claiming a write that has since been superseded.
  useEffect(() => {
    setMsg('');
  }, [q.dataUpdatedAt]);

  if (!q.data) return <p className="muted" style={{ fontSize: '0.9rem' }}>{t('common.loading')}</p>;
  const cfg = q.data;

  async function apply(patch: Parameters<typeof save.mutateAsync>[0]) {
    setErr('');
    setMsg('');
    try {
      await save.mutateAsync(patch);
      await utils.admissions.settingsGet.invalidate();
      setMsg(t('settings.admissionsSaved'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  /** Anything that mutates then refreshes the device list, so the panel is never stale after an end. */
  async function run(fn: () => Promise<unknown>) {
    setErr('');
    setMsg('');
    try {
      await fn();
      await utils.admissions.kioskList.invalidate();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function openKiosk() {
    await run(async () => {
      const r = await startKiosk.mutateAsync();
      // The URL when the platform has told us our own address, the raw token otherwise — an office
      // with Remote access off still has a LAN address to type, and the token is the half that
      // matters. Same fallback as the re-admission link box.
      setKioskLink(r.url || r.token);
    });
  }

  async function addOrigin() {
    const v = origin.trim();
    if (!v) return;
    await apply({ embedOrigins: [...cfg.embedOrigins, v] });
    setOrigin('');
  }

  async function saveWording() {
    setErr('');
    try {
      await saveText.mutateAsync({ boxes: Object.entries(wording).map(([key, text]) => ({ key: key as TextKey, text })) });
      await utils.admissions.settingsGet.invalidate();
      setWording({});
      setMsg(t('settings.admissionsSaved'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const boxValue = (key: TextKey) => wording[key] ?? cfg.textOverrides[key] ?? cfg.textDefaults[key] ?? '';

  return (
    <>
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><Globe size={15} /> {t('settings.admissionsForm')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsFormHint')}</p>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockEnd: '0.9rem', cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={cfg.publicForm} disabled={save.isPending} onChange={() => void apply({ publicForm: !cfg.publicForm })} />
          <span>
            {t('settings.admissionsPublic')}
            <br />
            <span className="hint">{t('settings.admissionsPublicHint')}</span>
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockEnd: '0.9rem', cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={cfg.open} disabled={save.isPending} onChange={() => void apply({ open: !cfg.open })} />
          <span>
            {t('settings.admissionsOpen')}
            <br />
            <span className="hint">{t('settings.admissionsOpenHint')}</span>
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockEnd: '0.9rem', cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={cfg.ackEmail} disabled={save.isPending} onChange={() => void apply({ ackEmail: !cfg.ackEmail })} />
          <span>
            {t('settings.admissionsAck')}
            <br />
            <span className="hint">{t('settings.admissionsAckHint')}</span>
          </span>
        </label>

        {/* A switch being on is not the same as the feature working — the office needs to be told
            which half is missing rather than left looking at a toggle that seems to do nothing. */}
        {cfg.publicForm && !cfg.hasPublicUrl && <p className="notice">{t('settings.admissionsNoUrl')}</p>}

        {cfg.publicForm && cfg.hasPublicUrl && (
          <div className="field" style={{ marginBlockStart: '0.8rem' }}>
            <label className="label" htmlFor="adm-url">{t('settings.admissionsLink')}</label>
            <div className="inline-form" style={{ alignItems: 'center' }}>
              <input id="adm-url" className="input glass-inset" readOnly value={cfg.formUrl} style={{ flex: '2 1 18rem' }} />
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard?.writeText(cfg.formUrl)}>
                <Copy size={13} /> {t('common.copy')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.admissionsEmbed')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsEmbedHint')}</p>

        {cfg.embedOrigins.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.admissionsNoOrigins')}</p>
        ) : (
          <ul className="data-list">
            {cfg.embedOrigins.map((o) => (
              <li key={o}>
                <span>{o}</span>
                <span className="spacer" />
                <button type="button" className="btn btn--ghost btn--sm" aria-label={t('common.delete')} disabled={save.isPending} onClick={() => void apply({ embedOrigins: cfg.embedOrigins.filter((x) => x !== o) })}>
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {cfg.embedOrigins.length < cfg.maxOrigins && (
          <div className="inline-form" style={{ marginBlockStart: '0.6rem' }}>
            <div className="field" style={{ flex: '2 1 16rem' }}>
              <label className="label" htmlFor="adm-origin">{t('settings.admissionsAddOrigin')}</label>
              <input id="adm-origin" className="input glass-inset" placeholder="https://masjid.org" value={origin} onChange={(e) => setOrigin(e.target.value)} />
            </div>
            <button type="button" className="btn btn--ghost btn--sm" disabled={save.isPending || !origin.trim()} onClick={() => void addOrigin()}>
              <Plus size={13} /> {t('common.add')}
            </button>
          </div>
        )}

        {cfg.publicForm && cfg.hasPublicUrl && cfg.embedOrigins.length > 0 && (
          <div className="field" style={{ marginBlockStart: '0.8rem' }}>
            <label className="label" htmlFor="adm-snippet">{t('settings.admissionsSnippet')}</label>
            {/* A TEXTAREA, because the snippet is two lines: a named div plus the script that fills
                it in. An <input> would collapse the newline and hand an office a broken paste. */}
            <textarea id="adm-snippet" className="input glass-inset" readOnly rows={2} value={cfg.embedSnippet} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }} />
            <div className="inline-form" style={{ alignItems: 'center', marginBlockStart: '0.4rem' }}>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard?.writeText(cfg.embedSnippet)}>
                <Copy size={13} /> {t('common.copy')}
              </button>
              <span className="hint">{t('settings.admissionsSnippetHint')}</span>
            </div>
          </div>
        )}
      </section>

      {/* ── THE PUBLIC INQUIRY FORM: which answers a family must give ─────────────────────────
          Its field list is FIXED in code (decision 9 — a configurable public form is a configurable
          attack surface), so this panel only decides which of the seven are compulsory. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.admissionsInquiryRequiredTitle')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsInquiryRequiredHint')}</p>
        <ul className="data-list">
          {cfg.inquiryFields.map((f) => (
            <li key={f.key}>
              <span>{f.label}</span>
              <span className="spacer" />
              {f.alwaysRequired ? (
                <span className="muted">{t('settings.admissionsAlwaysRequired')}</span>
              ) : (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={cfg.requiredInquiryFields.includes(f.key)}
                    disabled={save.isPending}
                    onChange={() =>
                      void apply({
                        requiredInquiryFields: cfg.requiredInquiryFields.includes(f.key)
                          ? cfg.requiredInquiryFields.filter((k) => k !== f.key)
                          : [...cfg.requiredInquiryFields, f.key],
                      })
                    }
                  />
                  <span className="muted">{t('settings.admissionsRequired')}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ── TABLET MODE ───────────────────────────────────────────────────────────────────────
          LAN-only by default and the copy says why, because an office that turns on remote access
          should know what it is giving up rather than discovering it later. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.admissionsKioskTitle')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsKioskHint')}</p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockEnd: '0.9rem', cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={cfg.kiosk} disabled={save.isPending} onChange={() => void apply({ kiosk: !cfg.kiosk })} />
          <span>
            {t('settings.admissionsKiosk')}
            <br />
            <span className="hint">{t('settings.admissionsKioskNote')}</span>
          </span>
        </label>
        {cfg.kiosk && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockEnd: '0.9rem', cursor: 'pointer' }}>
            <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={cfg.kioskRemote} disabled={save.isPending} onChange={() => void apply({ kioskRemote: !cfg.kioskRemote })} />
            <span>
              {t('settings.admissionsKioskRemote')}
              <br />
              <span className="hint">{t('settings.admissionsKioskRemoteNote')}</span>
            </span>
          </label>
        )}
        {cfg.kiosk && (
          <>
            <button type="button" className="btn btn--ghost btn--sm" disabled={startKiosk.isPending} onClick={() => void openKiosk()}>
              {t('settings.admissionsKioskStart')}
            </button>
            {kioskLink && (
              <>
                <div className="inline-form" style={{ alignItems: 'center', marginBlockStart: '0.7rem' }}>
                  <input className="input glass-inset" readOnly value={kioskLink} style={{ flex: '2 1 20rem' }} />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard?.writeText(kioskLink)}>
                    <Copy size={13} /> {t('common.copy')}
                  </button>
                </div>
                <p className="hint">{t('settings.admissionsKioskOpenHint')}</p>
              </>
            )}
            {(devices.data?.devices.length ?? 0) > 0 && (
              <ul className="data-list" style={{ marginBlockStart: '0.8rem' }}>
                {devices.data!.devices.map((d) => (
                  <li key={d.id}>
                    <span>{t('settings.admissionsKioskDevice')}</span>
                    <span className="spacer" />
                    <button type="button" className="btn btn--ghost btn--sm" disabled={revoke.isPending} onClick={() => void run(() => revoke.mutateAsync({ id: d.id }))}>
                      {t('settings.admissionsKioskEnd')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* ── THE ADMISSION FORM: which answers a family must give ──────────────────────────────
          The field LIST is not configured here — it is the student-field registry on the Students
          tab, and this panel only decides which of them a family may leave blank. That split is
          deliberate: one place decides what a field IS (§16), and switching a field off there takes
          it off this list rather than leaving a requirement pointing at nothing. */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.admissionsRequiredTitle')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsRequiredHint')}</p>
        <ul className="data-list">
          {cfg.admissionFields.map((f) => (
            <li key={f.key}>
              <span>{f.label}</span>
              {f.medical && <span className="chip is-muted">{t('settings.admissionsMedical')}</span>}
              <span className="spacer" />
              {f.key === 'childName' ? (
                // Required whatever anybody says — a submission with no child's name is a blank page,
                // and there would be nothing to show the office on the other side.
                <span className="muted">{t('settings.admissionsAlwaysRequired')}</span>
              ) : (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={cfg.requiredAdmissionFields.includes(f.key)}
                    disabled={save.isPending}
                    onChange={() =>
                      void apply({
                        requiredAdmissionFields: cfg.requiredAdmissionFields.includes(f.key)
                          ? cfg.requiredAdmissionFields.filter((k) => k !== f.key)
                          : [...cfg.requiredAdmissionFields, f.key],
                      })
                    }
                  />
                  <span className="muted">{t('settings.admissionsRequired')}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.admissionsLimits')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsLimitsHint')}</p>
        <div className="inline-form">
          <div className="field" style={{ flex: '0 1 10rem' }}>
            <label className="label" htmlFor="adm-daily">{t('settings.admissionsDailyMax')}</label>
            <input
              id="adm-daily"
              type="number"
              min={0}
              max={5000}
              className="input glass-inset"
              defaultValue={cfg.dailyMax}
              onBlur={(e) => {
                // On blur rather than per keystroke, and an EMPTY box means "no change" rather than
                // zero. `Number('')` is 0, which is a finite number and a legal ceiling — so clearing
                // this box to retype it would have set the cap to nothing and silently closed the
                // form, with the screen showing 0 as though somebody had asked for it.
                const raw = e.target.value.trim();
                if (!raw) {
                  e.target.value = String(cfg.dailyMax);
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n !== cfg.dailyMax) void apply({ dailyMax: Math.trunc(n) });
              }}
            />
          </div>
          <div className="field" style={{ flex: '0 1 10rem' }}>
            <label className="label" htmlFor="adm-min">{t('settings.admissionsMinSeconds')}</label>
            <input
              id="adm-min"
              type="number"
              min={0}
              max={60}
              className="input glass-inset"
              defaultValue={cfg.minSeconds}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                if (!raw) {
                  e.target.value = String(cfg.minSeconds);
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n !== cfg.minSeconds) void apply({ minSeconds: Math.trunc(n) });
              }}
            />
          </div>
        </div>
      </section>

      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('settings.admissionsWords')}</h2>
        </div>
        <p className="hint">{t('settings.admissionsWordsHint')}</p>
        {cfg.textKeys.map((k) => (
          <div className="field" key={k} style={{ marginBlockEnd: '0.6rem' }}>
            <label className="label" htmlFor={`adm-txt-${k}`}>{t(`settings.admissionsText_${k}`)}</label>
            <textarea
              id={`adm-txt-${k}`}
              className="input glass-inset"
              rows={2}
              maxLength={cfg.textMaxLength}
              value={boxValue(k)}
              onChange={(e) => setWording({ ...wording, [k]: e.target.value })}
            />
          </div>
        ))}
        <div className="inline-form" style={{ alignItems: 'center' }}>
          <button type="button" className="btn btn--primary btn--sm" disabled={saveText.isPending || Object.keys(wording).length === 0} onClick={() => void saveWording()}>
            {t('common.save')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={saveText.isPending} onClick={() => void saveText.mutateAsync({ reset: true }).then(() => { setWording({}); return utils.admissions.settingsGet.invalidate(); })}>
            {t('settings.admissionsResetWords')}
          </button>
          {msg && <span className="notice notice--ok" style={{ margin: 0 }}>{msg}</span>}
        </div>
        {err && <p className="form-error">{err}</p>}
      </section>
    </>
  );
}
