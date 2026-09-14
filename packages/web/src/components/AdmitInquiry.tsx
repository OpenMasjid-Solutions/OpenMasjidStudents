// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ADMITTING A CHILD — the step that turns a conversation into a student (0.52.0-dev.8).
 *
 * CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §4. One press creates the household, the child and their
 * Student ID, attaches the parent to the household, puts them on a fee plan, places them in a class
 * if there is one, and raises the enrollment fee. It is idempotent, so a second press is safe.
 *
 * ── THE ONE THING THIS SCREEN MUST GET RIGHT ────────────────────────────────
 *
 * **A sibling is offered, never assumed — in either direction.** If a household already has somebody
 * with this parent's email or phone number, that is shown at the top with WHY it matched, because a
 * younger sibling quietly given a second household is a family that then gets two bills, two sheets
 * and two portal logins. Joining them automatically would be the same mistake the other way, and
 * worse: it attaches a child to an address and a set of guardians nobody confirmed. So the office
 * picks, and the screen makes the choice visible rather than making it for them.
 *
 * The fee plan is REQUIRED and says so, because a child on no plan is invisible to invoice generation
 * — that is how a family silently stops being billed.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GraduationCap, Users } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatMoney } from '../lib/money';
import { cn } from '../lib/cn';

export function AdmitInquiry({ id, onAdmitted }: { id: string; onAdmitted?: () => void | Promise<unknown> }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.admissions.convertPreview.useQuery({ id });
  const tree = trpc.structure.courseTree.useQuery({});
  const convert = trpc.admissions.convert.useMutation();

  const [familyId, setFamilyId] = useState<string | null>(null);
  const [feePlanId, setFeePlanId] = useState('');
  const [classId, setClassId] = useState('');
  const [waive, setWaive] = useState(false);
  const [err, setErr] = useState('');

  if (!q.data) return <p className="muted" style={{ fontSize: '0.9rem' }}>{t('common.loading')}</p>;
  const { inquiry, hints, alreadyAdmitted, feePlans, enrollmentFee, currency } = q.data;

  if (alreadyAdmitted) {
    return (
      <p className="notice notice--ok" style={{ margin: 0 }}>
        {t('admissions.alreadyAdmitted')}
      </p>
    );
  }

  async function submit() {
    setErr('');
    try {
      await convert.mutateAsync({
        id,
        feePlanId,
        familyId: familyId ?? undefined,
        classId: classId || undefined,
        feeWaived: waive || undefined,
      });
      await Promise.all([utils.admissions.get.invalidate({ id }), utils.admissions.convertPreview.invalidate({ id }), utils.admissions.list.invalidate()]);
      await onAdmitted?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      {hints.length > 0 && (
        <>
          <p className="hint">
            <Users size={13} /> {t('admissions.siblingHint')}
          </p>
          <div className="filter-bar" role="group" aria-label={t('admissions.household')}>
            <button type="button" className={cn('btn btn--ghost btn--sm', familyId === null && 'is-active')} aria-pressed={familyId === null} onClick={() => setFamilyId(null)}>
              {t('admissions.newHousehold')}
            </button>
            {hints.map((h) => (
              <button key={h.familyId} type="button" className={cn('btn btn--ghost btn--sm', familyId === h.familyId && 'is-active')} aria-pressed={familyId === h.familyId} onClick={() => setFamilyId(h.familyId)}>
                {h.familyName}
                <span className="chip is-muted">{t(`admissions.matchedOn.${h.matchedOn}`)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="inline-form">
        <div className="field" style={{ flex: '1 1 12rem' }}>
          <label className="label" htmlFor="adm-plan">{t('directory.feePlan')}</label>
          <select id="adm-plan" className="input glass-inset" value={feePlanId} onChange={(e) => setFeePlanId(e.target.value)} required>
            <option value="">{feePlans.length ? t('directory.choosePlan') : t('directory.noFeePlans')}</option>
            {feePlans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatMoney(p.amountCents, currency)}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 12rem' }}>
          <label className="label" htmlFor="adm-class">{t('admissions.class')}</label>
          <select id="adm-class" className="input glass-inset" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">{t('admissions.noClass')}</option>
            {(tree.data ?? []).map((c) => (
              <optgroup key={c.id} label={c.name}>
                {c.classes.map((k) => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {/* What the year charges to join, and the office's chance to waive it for this family. Shown
          only when there is one — most madāris charge nothing, and an empty box asking about a fee
          that does not exist is a question nobody should have to answer. */}
      {enrollmentFee.amountCents != null && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBlockStart: '0.6rem', cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginBlockStart: '0.2rem' }} checked={waive} onChange={() => setWaive((v) => !v)} />
          <span>
            {t('admissions.waiveFee', { amount: formatMoney(enrollmentFee.amountCents, currency) })}
            <br />
            <span className="hint">{t('admissions.waiveFeeHint')}</span>
          </span>
        </label>
      )}

      <div className="inline-form" style={{ alignItems: 'center', marginBlockStart: '0.8rem' }}>
        <button type="button" className="btn btn--primary" disabled={convert.isPending || !feePlanId} onClick={() => void submit()}>
          <GraduationCap size={14} /> {t('admissions.admit', { name: inquiry.childName })}
        </button>
        <span className="hint" style={{ flex: '1 1 100%', margin: 0 }}>
          {familyId ? t('admissions.admitIntoHousehold') : t('admissions.admitNewHousehold')}
        </span>
      </div>
      {err && <p className="form-error">{err}</p>}
    </>
  );
}
