// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * SEND THE ONBOARDING MESSAGE — the explain-what-this-is message, to a household or to the whole roster
 * (0.51.0).
 *
 * The one screen in this app where "are you sure?" has to be answered with NUMBERS. Everything else an
 * office presses here can be undone: an invoice can be voided, a charge reversed, a fee re-assigned. A
 * message that has reached two hundred families cannot be unsent, and the cost of getting it wrong is
 * not an error message — it is a masjid's phone number being restricted (docs/WHATSAPP.md §1). So this
 * asks the server what one press would do and prints the answer before offering the button:
 *
 *   • how many STUDENTS the target names, and how many HOUSEHOLDS that really is. Those two numbers
 *     differing is not a rounding — it is the whole reason siblings behave the way they do below.
 *   • how many of those households can actually be reached, per channel, and how many cannot be reached
 *     at all. "Sent to 40 households" when 12 of them have no phone and no email is a lie by omission.
 *   • how many this press will get to, since a press is bounded (`batchSize`) and the rest wait.
 *   • whether either pause is on — two independent switches, each of which alone means a family hears
 *     nothing (§9), which is exactly the invisible failure this release has been digging out of.
 *
 * PICKING A CHILD PICKS THEIR SIBLINGS, visibly. Guardians attach to the HOUSEHOLD, not the student, so
 * a message aimed at Yusuf is a message to the adults who also pay for Maryam — there is no way to write
 * to one child's parents and not the other's. The server enforces that by collapsing to households
 * (structure/audience.ts); this ticks the siblings on screen so the office sees it happen rather than
 * discovering it in the counts. Unticking one unticks the set, for the same reason.
 *
 * It is deliberately NOT a composer. The wording lives in Settings → Onboarding message, one version for
 * the whole madrasah, editable and previewable there. A free-typed box here would be a way to send two
 * hundred families whatever was in the clipboard, with no preview and no record of what went.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Users } from 'lucide-react';
import { trpc } from '../lib/trpc';

type Scope = 'all' | 'course' | 'class' | 'students';

/** Fixed to one household — the button on a student's own record. The scope picker is not drawn at all;
 *  there is nothing to choose. */
interface Props {
  /** When set, this is the single-household form: these students' household and nobody else's. */
  studentIds?: string[];
  /** What to call that household on screen. */
  familyLabel?: string;
}

export function OnboardingSend({ studentIds, familyLabel }: Props) {
  const { t } = useTranslation();
  const single = !!studentIds?.length;

  const [scope, setScope] = useState<Scope>(single ? 'students' : 'all');
  const [courseId, setCourseId] = useState('');
  const [classId, setClassId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set(studentIds ?? []));
  const [q, setQ] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tree = trpc.structure.courseTree.useQuery(undefined, { enabled: !single });
  const roster = trpc.structure.studentsByClass.useQuery({}, { enabled: !single });
  const send = trpc.people.onboardingSend.useMutation();

  const courses = tree.data ?? [];
  const allClasses = useMemo(
    () => courses.flatMap((c) => c.classes.map((k) => ({ id: k.id, label: `${c.name} · ${k.name}`, studentCount: k.studentCount }))),
    [courses],
  );
  const rows = roster.data ?? [];

  /** Which households the currently ticked students belong to — used to tick their siblings too. */
  const familyOf = useMemo(() => new Map(rows.map((r) => [r.id, r.familyId])), [rows]);

  const target = useMemo(() => {
    if (scope === 'all') return { kind: 'all' as const };
    if (scope === 'course') return { kind: 'course' as const, courseId };
    if (scope === 'class') return { kind: 'class' as const, classId };
    return { kind: 'students' as const, studentIds: [...picked] };
  }, [scope, courseId, classId, picked]);

  const ready =
    scope === 'all' ? true : scope === 'course' ? !!courseId : scope === 'class' ? !!classId : picked.size > 0;

  // Asked of the server rather than counted here: households, reachability and the batch bound are all
  // facts about the data, and a number the browser guessed would be the number the office trusted.
  const preview = trpc.people.onboardingPreview.useQuery(
    { target: target as never },
    { enabled: ready, staleTime: 0 },
  );
  const p = preview.data;

  /**
   * Tick a student AND their siblings. Untick likewise.
   *
   * The whole household moves together because that is what the send does — see the header. A UI that let
   * you tick one of three siblings would be describing something the server cannot do.
   */
  function toggle(id: string) {
    const fam = familyOf.get(id);
    const group = fam ? rows.filter((r) => r.familyId === fam).map((r) => r.id) : [id];
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) group.forEach((g) => n.delete(g));
      else group.forEach((g) => n.add(g));
      return n;
    });
    setConfirming(false);
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => `${r.fullName} ${r.familyName}`.toLowerCase().includes(needle));
  }, [rows, q]);

  async function doSend() {
    setErr(null);
    setResult(null);
    try {
      const r = await send.mutateAsync({ target: target as never });
      setConfirming(false);
      setResult(
        t('onboarding.sent', { households: r.households, emailed: r.emailed, messaged: r.messaged }) +
          (r.remaining ? ` ${t('onboarding.remaining', { count: r.remaining })}` : ''),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="win-content">
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{single ? t('onboarding.titleOne', { family: familyLabel ?? '' }) : t('onboarding.title')}</h2>
        </div>
        <p className="muted" style={{ fontSize: '0.88rem' }}>{t('onboarding.intro')}</p>
        {/* Where the words are. Said here because an office looking at a Send button wants to know what it
            is about to send, and the answer is on another screen. */}
        <p className="hint">{t('onboarding.wordingHint')}</p>

        {!single && (
          <>
            <div className="inline-form glass-inset" style={{ gap: '0.5rem' }}>
              {(['all', 'course', 'class', 'students'] as Scope[]).map((k) => (
                <label key={k} className={`chip ${scope === k ? '' : 'is-muted'}`} style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="onboarding-scope"
                    checked={scope === k}
                    onChange={() => { setScope(k); setConfirming(false); }}
                    style={{ marginInlineEnd: '0.35rem' }}
                  />
                  {t(`onboarding.scope_${k}`)}
                </label>
              ))}
            </div>

            {scope === 'course' && (
              <div className="inline-form glass-inset">
                <div className="field" style={{ flex: '1 1 16rem' }}>
                  <label className="label">{t('mass.course')}</label>
                  <select className="input glass-inset" value={courseId} onChange={(e) => { setCourseId(e.target.value); setConfirming(false); }}>
                    <option value="">{t('mass.pickCourse')}</option>
                    {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
            )}

            {scope === 'class' && (
              <div className="inline-form glass-inset">
                <div className="field" style={{ flex: '1 1 16rem' }}>
                  <label className="label">{t('mass.class')}</label>
                  <select className="input glass-inset" value={classId} onChange={(e) => { setClassId(e.target.value); setConfirming(false); }}>
                    <option value="">{t('mass.pickClass')}</option>
                    {allClasses.map((k) => <option key={k.id} value={k.id}>{k.label} ({k.studentCount})</option>)}
                  </select>
                </div>
              </div>
            )}

            {scope === 'students' && (
              <div className="glass-inset" style={{ padding: '0.7rem 0.8rem', marginBlockStart: '0.6rem' }}>
                <div className="field" style={{ marginBlockEnd: '0.5rem' }}>
                  <label className="label">{t('students.search')}</label>
                  <input className="input glass-inset" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                {/* Said before the list, not after: an office ticking one name should know the rest of that
                    household comes with it BEFORE they wonder why three boxes lit up. */}
                <p className="hint" style={{ marginBlockStart: 0 }}>{t('onboarding.siblingNote')}</p>
                <div style={{ maxHeight: '15rem', overflowY: 'auto' }}>
                  {filtered.map((s) => (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.2rem 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                      <span>{s.fullName}</span>
                      <span className="muted" style={{ fontSize: '0.85rem' }}>{s.familyName}</span>
                    </label>
                  ))}
                  {!filtered.length && <p className="muted" style={{ fontSize: '0.9rem' }}>{t('onboarding.noneFound')}</p>}
                </div>
              </div>
            )}
          </>
        )}

        {/* WHAT THIS PRESS WOULD DO. The numbers are the confirmation. */}
        {ready && p && (
          <div className="notice" style={{ marginBlockStart: '0.75rem' }}>
            <p style={{ margin: 0 }}>
              <strong>{t('onboarding.willSend', { households: p.households, students: p.students })}</strong>
            </p>
            <p className="hint" style={{ marginBlockEnd: 0 }}>
              {t('onboarding.reach', { phone: p.withPhone, email: p.withEmail })}
              {p.unreachableByPhone > 0 && ` ${t('onboarding.noPhone', { count: p.unreachableByPhone })}`}
            </p>
            {p.households > p.batchSize && (
              <p className="hint" style={{ marginBlockEnd: 0 }}>{t('onboarding.batch', { count: p.batchSize })}</p>
            )}
            {/* Each pause named on its own — they are separate switches and either alone silences a channel. */}
            {p.whatsappPaused && <p className="hint" style={{ marginBlockEnd: 0 }}>{t('onboarding.waPaused')}</p>}
            {p.mailPaused && <p className="hint" style={{ marginBlockEnd: 0 }}>{t('onboarding.mailPaused')}</p>}
            {!p.mailReady && <p className="hint" style={{ marginBlockEnd: 0 }}>{t('onboarding.noMail')}</p>}
          </div>
        )}

        <div className="inline-form" style={{ paddingInline: 0 }}>
          {!confirming ? (
            <button type="button" className="btn btn--primary" disabled={!ready || !p?.households || send.isPending} onClick={() => setConfirming(true)}>
              <Send size={14} style={{ marginInlineEnd: '0.3rem' }} />
              {t('onboarding.send')}
            </button>
          ) : (
            <>
              {/* The confirmation says what will actually happen, with the number in it (§15) — a dialog
                  that only says "are you sure?" is one people learn to click through. */}
              <span style={{ flexBasis: '100%' }}>
                {t('onboarding.confirm', { count: Math.min(p?.households ?? 0, p?.batchSize ?? 0) })}
              </span>
              <button type="button" className="btn btn--primary" disabled={send.isPending} onClick={() => void doSend()}>
                {send.isPending ? t('onboarding.sending') : t('onboarding.confirmYes')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
            </>
          )}
        </div>

        {result && (
          <div className="notice" style={{ marginBlockStart: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Users size={15} />
            <span style={{ flex: 1 }}>{result}</span>
          </div>
        )}
        {err && <p className="form-error">{err}</p>}
      </section>
    </div>
  );
}
