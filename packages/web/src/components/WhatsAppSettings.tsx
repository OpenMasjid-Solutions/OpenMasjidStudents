// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Settings → WhatsApp (0.50.0).
 *
 * Its own component rather than another block in Settings.tsx: it is six decisions, a preview and a
 * log, and it is the one settings panel where getting it wrong messages two hundred families.
 *
 * THE ORDER OF THE PANEL IS THE ARGUMENT IT MAKES, and it is deliberately the reverse of "turn it on
 * and see what happens":
 *
 *   1. **Can this server send at all** — and if not, the one sentence that says what to do about it.
 *   2. **What the risk is.** WhatsApp does not permit a self-hosted client. The masjid's number can be
 *      restricted or banned and there is no way to make that zero. That is said plainly, next to the
 *      switch, before it is thrown — not buried in documentation nobody opens.
 *   3. **Who would be reached** — how many numbers we can actually read, before anything is switched on.
 *   4. **The pause**, which starts ON, and the test student who gets through it.
 *   5. **Which events**, all starting off.
 *   6. **What was actually queued**, afterwards.
 *
 * Nothing here says "sent". The platform's queue paces every message and holds it through the masjid's
 * quiet hours, so what this screen can honestly report is that a message was handed over.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Send } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { StudentPicker } from './StudentPicker';

export function WhatsAppSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const cfg = trpc.whatsapp.get.useQuery();
  const audience = trpc.whatsapp.audience.useQuery();
  const save = trpc.whatsapp.set.useMutation();
  const check = trpc.whatsapp.statusCheck.useMutation();
  const roster = trpc.people.studentOptions.useQuery();
  const [msg, setMsg] = useState<string | null>(null);

  async function patch(input: Parameters<typeof save.mutateAsync>[0]) {
    setMsg(null);
    try {
      await save.mutateAsync(input);
      await utils.whatsapp.get.invalidate();
      await utils.whatsapp.audience.invalidate();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function recheck() {
    setMsg(null);
    await check.mutateAsync();
    await utils.whatsapp.get.invalidate();
  }

  // ── The country a number belongs to ────────────────────────────────────────
  // App-wide default plus a short list the office can pick from per person. Held as a draft so typing
  // "+4" mid-edit doesn't fail validation on every keystroke.
  const [newCountry, setNewCountry] = useState('');
  const countryOk = /^\+\d{1,3}$/.test(newCountry.trim());

  async function addCountry() {
    if (!countryOk || !cfg.data) return;
    await patch({ countries: [...new Set([...cfg.data.countries, newCountry.trim()])] });
    setNewCountry('');
  }

  async function removeCountry(code: string) {
    if (!cfg.data) return;
    // The default can't be removed — it is what every number with nothing more specific falls back to.
    if (code === cfg.data.defaultCountry) return;
    await patch({ countries: cfg.data.countries.filter((c) => c !== code) });
  }

  // Fixing a number whose country we guessed wrong. The same mutation the family screen uses, so
  // there is one place a guardian's country is written.
  const guardianUpdate = trpc.people.guardianUpdate.useMutation();
  async function fixCountry(guardianId: string, country: string) {
    setMsg(null);
    try {
      await guardianUpdate.mutateAsync({ id: guardianId, phoneCountry: country });
      await utils.whatsapp.audience.invalidate();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const testSend = trpc.whatsapp.testSend.useMutation();
  async function runTest() {
    setMsg(null);
    try {
      // Reports BOTH channels: the test student governs the email pause too, so "the email went and
      // the WhatsApp did not" is a real and useful outcome rather than a failure.
      const r = await testSend.mutateAsync();
      setMsg(t('settings.waTestDone', { emailed: r.emailed, whatsapp: t(`settings.waTestWa_${r.whatsapp}`) }));
      await utils.whatsapp.log.invalidate();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (!cfg.data) return null;
  const c = cfg.data;
  /** `ready` is the only state that sends. The other three each need different words from us, which is
   *  why the platform answers with one of exactly four and we key the sentence off it. */
  const reason = c.status?.reason ?? (c.fabric ? 'unreachable' : 'not-configured');
  const canSend = !!c.status?.available;

  return (
    <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
      <div className="section-head">
        <h2>{t('settings.wa')}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void recheck()} disabled={check.isPending}>
          <RefreshCw size={14} style={{ marginInlineEnd: '0.3rem' }} />
          {check.isPending ? t('settings.waChecking') : t('settings.waCheck')}
        </button>
      </div>
      <p className="muted" style={{ fontSize: '0.88rem', marginBlockEnd: '0.75rem' }}>{t('settings.waHint')}</p>
      {msg && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{msg}</div>}

      {/* 1. Can this server send? One sentence per reason — each needs a different thing done. */}
      <p style={{ margin: '0 0 0.75rem' }}>
        <span className={`chip ${canSend ? '' : 'is-muted'}`}>{canSend ? t('settings.waReady') : t('settings.waNotReady')}</span>
        <span className="hint" style={{ display: 'block', marginBlockStart: '0.3rem' }}>{t(`settings.waReason_${reason}`)}</span>
        {/* THE RAW SIGNAL, verbatim. A screen that says "not set up" while the gateway is plainly
            working in OpenMasjidOS is unarguable-with, and prose cannot settle it — the HTTP status
            and where the answer came from can. `platform` means the OS itself said this; `http` means
            we inferred it from a status code; `local` means we never got as far as asking. */}
        {!canSend && c.status && (
          <span className="hint" style={{ display: 'block', marginBlockStart: '0.2rem', opacity: 0.75 }}>
            {t('settings.waDiag', { source: c.status.source, reason: c.status.reason, status: c.status.httpStatus ?? '—' })}
          </span>
        )}
      </p>

      {/* WHY NOTHING IS SENDING — the line this screen should always have had.
          The global gates stop a message before any recipient is considered and write no log row (a
          switch that is off would otherwise fill the trail every invoice run), so an office could
          turn the feature on, take a real payment and get nothing at all with nothing anywhere saying
          which gate did it. Now the gates report themselves, in the order they are applied. */}
      {c.blockers.length > 0 && (
        <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>
          <strong>{t('settings.waBlocked')}</strong>
          <ul style={{ margin: '0.35rem 0 0', paddingInlineStart: '1.1rem' }}>
            {c.blockers.map((b) => <li key={b}>{t(`settings.waBlock_${b}`)}</li>)}
          </ul>
        </div>
      )}
      {c.blockers.length === 0 && c.pausedWithTest && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.waOnlyTest')}</div>}

      {/* 2. The risk, next to the switch — not in a document nobody opens. */}
      <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.waRisk')}</div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
        <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={c.enabled} onChange={() => void patch({ enabled: !c.enabled })} disabled={save.isPending || !c.fabric} />
        <span>{t('settings.waEnable')}<br /><span className="hint">{t('settings.waEnableHint')}</span></span>
      </label>

      {c.enabled && (
        <>
          {/* 3. Which countries a number can be in, and who that leaves reachable. */}
          <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.waCountries')}</h3>
          <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.waCountriesHint')}</p>
          <div className="inline-form glass-inset" style={{ marginBlockStart: 0, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 8rem' }}>
              <label className="label" htmlFor="wa-default">{t('settings.waDefaultCountry')}</label>
              <select id="wa-default" className="input glass-inset" value={c.defaultCountry} onChange={(e) => void patch({ defaultCountry: e.target.value })} disabled={save.isPending}>
                {c.countries.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 8rem' }}>
              <label className="label" htmlFor="wa-add-country">{t('settings.waAddCountry')}</label>
              <input id="wa-add-country" className="input glass-inset" value={newCountry} onChange={(e) => setNewCountry(e.target.value)} placeholder="+44" maxLength={5} />
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => void addCountry()} disabled={!countryOk || save.isPending}>{t('common.add')}</button>
            <div className="field" style={{ flexBasis: '100%' }}>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {c.countries.map((x) => (
                  <span key={x} className={`chip ${x === c.defaultCountry ? 'is-accent' : ''}`}>
                    {x}
                    {x !== c.defaultCountry && (
                      <button type="button" className="btn btn--ghost btn--sm" style={{ padding: '0 0.25rem' }} onClick={() => void removeCountry(x)} aria-label={t('common.remove')}>×</button>
                    )}
                  </span>
                ))}
              </span>
            </div>
          </div>

          {audience.data && (
            <>
              <p className="muted" style={{ fontSize: '0.9rem', marginBlock: '0.6rem' }}>
                {t('settings.waAudience', {
                  reachable: audience.data.reachable,
                  guardians: audience.data.guardians,
                  optedOut: audience.data.optedOut,
                  noNumber: audience.data.noNumber,
                })}
              </p>
              {audience.data.unreadableTotal > 0 && (
                <>
                  <p className="hint" style={{ marginBlockEnd: '0.4rem' }}>{t('settings.waUnreadable', { count: audience.data.unreadableTotal })}</p>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table stack-phone">
                      <thead>
                        <tr>
                          <th>{t('settings.waWho')}</th>
                          <th>{t('settings.waNumber')}</th>
                          <th>{t('settings.waCountry')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audience.data.unreadable.map((g) => (
                          <tr key={g.guardianId}>
                            <td data-label={t('settings.waWho')}>{g.name}<br /><span className="hint">{g.label}</span></td>
                            <td data-label={t('settings.waNumber')}><code style={{ fontSize: '0.82rem' }}>{g.phone}</code></td>
                            <td data-label={t('settings.waCountry')}>
                              {/* Almost always the fix: a number written the way its own country writes
                                  it, filed under the wrong one. */}
                              <select
                                className="input glass-inset"
                                style={{ width: 'auto', minWidth: '6rem', padding: '0.2rem 0.35rem' }}
                                value={g.country ?? ''}
                                onChange={(e) => void fixCountry(g.guardianId, e.target.value)}
                                disabled={guardianUpdate.isPending}
                                aria-label={t('settings.waCountry')}
                              >
                                <option value="">{t('settings.waCountryDefault', { code: audience.data!.defaultCountry })}</option>
                                {audience.data!.countries.map((x) => <option key={x} value={x}>{x}</option>)}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {/* 4. The pause, and the one household that gets through it. */}
          <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.waParents')}</h3>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', marginBlockEnd: '0.6rem' }}>
            <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={c.paused} onChange={() => void patch({ paused: !c.paused })} disabled={save.isPending} />
            <span>{t('settings.waPause')}<br /><span className="hint">{t('settings.waPauseHint')}</span></span>
          </label>
          {c.paused && <div className="notice notice--warn" style={{ marginBlockEnd: '0.6rem' }}>{t('settings.waPausedNotice')}</div>}

          <div className="inline-form glass-inset" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '1 1 16rem' }}>
              <StudentPicker
                students={roster.data ?? []}
                value={c.testStudentId}
                onChange={(id) => void patch({ testStudentId: id })}
                label={t('settings.waTestStudent')}
                placeholder={t('settings.waTestStudentPick')}
              />
              <span className="hint">{t('settings.waTestStudentHint')}</span>
            </div>
            {/* Enabled as soon as there is a test student. It no longer waits on the WhatsApp gateway:
                the test student governs the EMAIL pause too, so an office setting this up before OpenWA
                exists on the server can still prove the exception works. */}
            <button type="button" className="btn btn--ghost" onClick={() => void runTest()} disabled={testSend.isPending || !c.testStudentId}>
              <Send size={14} style={{ marginInlineEnd: '0.3rem' }} />
              {testSend.isPending ? t('settings.waTesting') : t('settings.waSendTest')}
            </button>
          </div>
          {/* A test student that no longer resolves is the silent failure this line exists to stop:
              the household is set, the pause is on, and nothing gets through. */}
          {c.testStudentId && !c.testFamilyId && <p className="form-error">{t('settings.waTestStudentGone')}</p>}

          {/* 5. Which messages. All off until somebody says otherwise. */}
          <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.waEvents')}</h3>
          <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.waEventsHint')}</p>
          {c.parentEvents.map((e) => (
            <label key={e} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', marginBlockEnd: '0.4rem' }}>
              <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={!!c.events[e]} onChange={() => void patch({ event: { id: e, on: !c.events[e] } })} disabled={save.isPending} />
              <span>{t(`settings.waEv_${e}`)}<br /><span className="hint">{t(`settings.waEvHint_${e}`)}</span></span>
            </label>
          ))}

          <MessageWording />
          <Groups />
          <EmailRequest />
          <QueueLog />
        </>
      )}
    </section>
  );
}

/**
 * What each message actually says (0.50.0-dev.4).
 *
 * The shipped sentences follow one rule — WhatsApp carries the fact, email carries the detail — and
 * that rule is a good default rather than a law about somebody else's madrasah. One school wants the
 * balance in every message, another wants three words and a name, and a school writing in Urdu wants
 * their own sentences entirely.
 *
 * Two things make this safe to hand over. The tags are a fixed list per message, so an office can only
 * interpolate what the server offers — there is no tag for a Student ID or a card, which is the
 * enforcement rather than a rule in a document. And the PREVIEW is rendered against a real household
 * (the test student's, when one is set), both with and without the "check your email" line, because a
 * template full of brackets is unreadable as prose and the message a family gets is the thing being
 * decided.
 */
function MessageWording() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.whatsapp.textsGet.useQuery();
  const save = trpc.whatsapp.textsSet.useMutation();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const dirty = Object.keys(draft).length > 0;

  if (!q.data) return null;
  const d = q.data;
  type TextKey = (typeof d.keys)[number];
  // Pre-filled with the wording IN FORCE, so an office edits real prose; clearing a box is how they
  // put our sentence back (the server treats '' as "use the default").
  const boxValue = (k: TextKey) => draft[k] ?? d.overrides[k] ?? d.defaults[k] ?? '';

  async function persist(boxes: { key: TextKey; text: string }[], reset = false) {
    await save.mutateAsync(reset ? { reset: true } : { boxes });
    await utils.whatsapp.textsGet.invalidate();
    setDraft({});
  }

  return (
    <>
      <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>
        {t('settings.waWording')}
        <button type="button" className="btn btn--ghost btn--sm" style={{ marginInlineStart: '0.5rem' }} onClick={() => setOpen((v) => !v)}>
          {open ? t('common.close') : t('settings.waWordingEdit')}
        </button>
      </h3>
      <p className="hint">{t('settings.waWordingHint')}</p>

      {open && (
        <>
          {d.sampleFamily && <p className="hint" style={{ marginBlock: '0.5rem' }}>{t('settings.waWordingSample', { family: d.sampleFamily })}</p>}
          {d.keys.map((k) => {
            const preview = d.preview.find((p) => p.key === k);
            const custom = d.overrides[k] !== undefined;
            return (
              <div className="field" key={k}>
                <label className="label" htmlFor={`wa-text-${k}`}>
                  {t(`settings.waText_${k}`)}
                  {custom && <span className="chip is-muted" style={{ marginInlineStart: '0.4rem' }}>{t('settings.sheetTextCustom')}</span>}
                </label>
                <textarea
                  id={`wa-text-${k}`}
                  className="textarea glass-inset"
                  style={{ minHeight: '4.5rem', fontFamily: 'inherit', fontSize: '0.9rem' }}
                  value={boxValue(k)}
                  maxLength={d.maxLength}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                />
                {/* Only the tags THIS message can fill in: one that cannot resolve would leave a hole
                    in the sentence, so offering it would be a trap. */}
                <span className="hint">
                  {t('settings.waWordingTags', { tags: (d.tags[k] ?? []).map((g) => `[${g}]`).join(' ') })}
                </span>
                {preview && !draft[k] && (
                  <div className="glass-inset" style={{ padding: '0.5rem 0.7rem', borderRadius: '0.6rem', marginBlockStart: '0.35rem' }}>
                    <span className="hint">{t('settings.waWordingPreview')}</span>
                    <p style={{ whiteSpace: 'pre-wrap', fontSize: '0.88rem', margin: '0.25rem 0 0' }}>{preview.withEmail}</p>
                  </div>
                )}
                {/* Unsaved edits show no preview rather than a stale one: the tags are resolved on the
                    server, and a preview of the previous wording beside a changed box is a lie. */}
                {draft[k] !== undefined && <span className="hint">{t('settings.waWordingUnsaved')}</span>}
              </div>
            );
          })}

          <div className="inline-form glass-inset" style={{ alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void persist(Object.entries(draft).map(([key, text]) => ({ key: key as TextKey, text })))}
              disabled={!dirty || save.isPending}
            >
              {t('common.save')}
            </button>
            {dirty && <button type="button" className="btn btn--ghost" onClick={() => setDraft({})}>{t('common.cancel')}</button>}
            <span className="spacer" />
            <button type="button" className="btn btn--ghost" onClick={() => void persist([], true)} disabled={save.isPending}>
              {t('settings.sheetTextReset')}
            </button>
          </div>
          <p className="hint">{t('settings.waWordingClearHint')}</p>
        </>
      )}
    </>
  );
}

/**
 * Staff alerts to a WhatsApp group (0.50.0) — a masjid's finance group getting every payment alert.
 *
 * A GROUP IS A STAFF CHANNEL, not a way to reach parents. The events are the same ones a staff account
 * can subscribe to, laid out as the same matrix the email-alert list uses, because it is the same
 * decision: who hears about what. There is deliberately no composer — nothing free-typed can be sent
 * to a group, and no parent event can reach one at all.
 *
 * THE ONE THING TO GET RIGHT IS `detail`. An alert has two texts: the one that names the household and
 * the amount, and the one that names nobody. This app cannot see who is in a group, so the choice is
 * the admin's — and it starts on the careful side, with the consequence written next to the switch
 * rather than in a document. A finance group of three wants the names; a group of two hundred parents
 * must never get them.
 *
 * Renders nothing when no groups are approved. That is a normal state — approval is the admin's to
 * give and withdraw in OpenMasjidOS — and a feature with nowhere to send is better hidden than broken.
 */
function Groups() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.whatsapp.groups.useQuery();
  const save = trpc.whatsapp.groupSet.useMutation();
  const test = trpc.whatsapp.groupTest.useMutation();
  const [note, setNote] = useState<string | null>(null);

  if (!q.data || q.data.groups.length === 0) return null;
  const d = q.data;
  type Group = (typeof d.groups)[number];

  async function set(g: Group, patch: { events?: Group['events']; detail?: boolean }) {
    setNote(null);
    try {
      await save.mutateAsync({ groupId: g.id, events: patch.events ?? g.events, detail: patch.detail ?? g.detail });
      await utils.whatsapp.groups.invalidate();
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  async function runTest(g: Group) {
    setNote(null);
    try {
      await test.mutateAsync({ groupId: g.id });
      setNote(t('settings.waGroupTestQueued', { group: g.label }));
      await utils.whatsapp.log.invalidate();
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <>
      <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.waGroups')}</h3>
      <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.waGroupsHint')}</p>
      {note && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{note}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('settings.waGroupWhich')}</th>
              {d.events.map((e) => <th key={e} style={{ fontSize: '0.72rem', whiteSpace: 'normal', minWidth: '5.5rem' }}>{t(`settings.ev_${e}`)}</th>)}
              <th className="actions" />
            </tr>
          </thead>
          <tbody>
            {d.groups.map((g) => (
              <tr key={g.id}>
                <td>{g.label}</td>
                {d.events.map((e) => (
                  <td key={e} style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      aria-label={`${g.label} — ${t(`settings.ev_${e}`)}`}
                      checked={g.events.includes(e)}
                      disabled={save.isPending}
                      onChange={(ev) => void set(g, { events: ev.target.checked ? [...g.events, e] : g.events.filter((x) => x !== e) })}
                    />
                  </td>
                ))}
                <td className="actions">
                  <button type="button" className="btn btn--ghost btn--sm" title={t('settings.waGroupTest')} onClick={() => void runTest(g)} disabled={test.isPending || !d.ready}>
                    <Send size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The consequence, per group, next to the switch that causes it. */}
      {d.groups.map((g) => (
        <label key={`d-${g.id}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', marginBlockStart: '0.5rem' }}>
          <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={g.detail} disabled={save.isPending} onChange={() => void set(g, { detail: !g.detail })} />
          <span>
            {t('settings.waGroupDetail', { group: g.label })}
            <br />
            <span className="hint">{g.detail ? t('settings.waGroupDetailOn') : t('settings.waGroupDetailOff')}</span>
          </span>
        </label>
      ))}
      <p className="hint" style={{ marginBlockStart: '0.5rem' }}>{t('settings.waGroupsParentsHint')}</p>
    </>
  );
}

/**
 * "We don't have your email address" — the one message an office sends on purpose.
 *
 * It exists because email is the channel that carries everything with detail in it (receipts,
 * invoices, statements), and a household with no address on file silently receives none of it. Until
 * now the only fix was a list of phone numbers to ring.
 *
 * The wording is EDITABLE and the preview is per household rather than one generic sample, because the
 * part an office is actually checking is `[children]` — whether the message names the right kids.
 */
function EmailRequest() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.whatsapp.emailRequestPreview.useQuery();
  const send = trpc.whatsapp.emailRequestSend.useMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!q.data) return null;
  const d = q.data;
  // The box is pre-filled with the wording IN FORCE, so an office edits real prose; clearing it puts
  // the shipped sentence back (the server treats '' as "use the default").
  const text = draft ?? (d.template || d.fallback);

  async function run() {
    setNote(null);
    const first = d.preview[0];
    if (!window.confirm(t('settings.waEmailReqConfirm', { count: Math.min(d.sendable, d.batchSize), sample: first ? first.text : '' }))) return;
    try {
      const r = await send.mutateAsync({ text: draft ?? undefined });
      setDraft(null);
      setNote(t('settings.waEmailReqDone', { queued: r.queued, remaining: r.remaining }));
      await utils.whatsapp.emailRequestPreview.invalidate();
      await utils.whatsapp.log.invalidate();
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <>
      <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>{t('settings.waEmailReq')}</h3>
      {d.households === 0 ? (
        <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.waEmailReqNone')}</p>
      ) : (
        <>
          <p className="hint" style={{ marginBlockEnd: '0.5rem' }}>{t('settings.waEmailReqHint', { households: d.households, sendable: d.sendable })}</p>
          <div className="field">
            <label className="label" htmlFor="wa-emailreq">{t('settings.waEmailReqText')}</label>
            <textarea
              id="wa-emailreq"
              className="textarea glass-inset"
              style={{ minHeight: '7rem', fontFamily: 'inherit', fontSize: '0.9rem' }}
              value={text}
              maxLength={d.maxLength}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="hint">{t('settings.waEmailReqTags', { tags: d.tags.map((g) => `[${g}]`).join(' ') })}</span>
          </div>

          {/* What one real household will read, tags resolved. The list is behind a toggle: on a
              roster of two hundred it is a page of prose nobody asked for until they do. */}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((v) => !v)}>
            {open ? t('common.close') : t('settings.waEmailReqPreview')}
          </button>
          {open && (
            <div style={{ marginBlockStart: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {d.preview.map((h) => (
                <div key={h.familyId} className="glass-inset" style={{ padding: '0.6rem 0.75rem', borderRadius: '0.6rem' }}>
                  <strong style={{ fontSize: '0.9rem' }}>{h.label}</strong>
                  <p style={{ whiteSpace: 'pre-wrap', fontSize: '0.88rem', margin: '0.35rem 0' }}>{h.text}</p>
                  <span className="hint">
                    {h.recipients.length === 0
                      ? t('settings.waEmailReqNoAdult')
                      : h.recipients.map((r) => `${r.name} ${r.optedOut ? t('settings.waOptedOut') : r.usable ? r.mask : t('settings.waNoNumber')}`).join(' · ')}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="inline-form glass-inset" style={{ alignItems: 'center' }}>
            <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={send.isPending || d.sendable === 0 || d.paused}>
              {send.isPending ? t('settings.waEmailReqSending') : t('settings.waEmailReqSend', { count: Math.min(d.sendable, d.batchSize) })}
            </button>
            {/* The pause is respected here too, and says so: an office that can't work out why the
                button does nothing is the failure this line prevents. Set a test student and the
                message reaches that household while everyone else stays quiet. */}
            {d.paused && <span className="hint">{t('settings.waEmailReqPaused')}</span>}
            {d.sendable < d.households && <span className="hint">{t('settings.waEmailReqUnreachable', { count: d.households - d.sendable })}</span>}
          </div>
          {note && <div className="notice" style={{ marginBlockEnd: '0.6rem' }}>{note}</div>}
        </>
      )}
    </>
  );
}

/** What was handed to the queue — never what it said (§14). Collapsed, because it is an answer to a
 *  question ("did the Ahmeds get it?") rather than something to read every visit. */
function QueueLog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const q = trpc.whatsapp.log.useQuery({ limit: 100 }, { enabled: open });

  return (
    <>
      <h3 className="label" style={{ marginBlockStart: '1.1rem', marginBlockEnd: '0.4rem' }}>
        {t('settings.waLog')}
        <button type="button" className="btn btn--ghost btn--sm" style={{ marginInlineStart: '0.5rem' }} onClick={() => setOpen((v) => !v)}>
          {open ? t('common.close') : t('common.show')}
        </button>
      </h3>
      <p className="hint">{t('settings.waLogHint')}</p>
      {/* WHAT "QUEUED" ACTUALLY MEANS, where somebody reads the word and starts wondering. A receipt
          queued at three in the morning does not arrive at three in the morning — the platform holds
          everything through the masjid's quiet hours — and a screen that leaves that to be discovered
          reads as "it doesn't work". */}
      {open && <p className="hint">{t('settings.waQueuedMeaning')}</p>}
      {open && q.data && (q.data.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.9rem' }}>{t('settings.waLogEmpty')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table stack-phone">
            <thead>
              <tr>
                <th>{t('settings.waLogWhen')}</th>
                <th>{t('settings.waLogWhat')}</th>
                <th>{t('settings.waWho')}</th>
                <th>{t('directory.status')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.id}>
                  <td data-label={t('settings.waLogWhen')}>{new Date(r.at).toLocaleString()}</td>
                  <td data-label={t('settings.waLogWhat')}>{r.event}</td>
                  <td data-label={t('settings.waWho')}>{r.who}{r.household ? <><br /><span className="hint">{r.household}</span></> : null}</td>
                  <td data-label={t('directory.status')}>
                    <span className={`chip ${r.status === 'queued' ? '' : 'is-muted'}`}>{t(`settings.waStatus_${r.status}`)}</span>
                    {r.reason && <span className="hint" style={{ display: 'block' }}>{t(`settings.waReasonShort_${r.reason}`, { defaultValue: r.reason })}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
