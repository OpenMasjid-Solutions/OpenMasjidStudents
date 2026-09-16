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

  const [origin, setOrigin] = useState('');
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
            <div className="inline-form" style={{ alignItems: 'center' }}>
              <input id="adm-snippet" className="input glass-inset" readOnly value={cfg.embedSnippet} style={{ flex: '2 1 18rem' }} />
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard?.writeText(cfg.embedSnippet)}>
                <Copy size={13} /> {t('common.copy')}
              </button>
            </div>
          </div>
        )}
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
