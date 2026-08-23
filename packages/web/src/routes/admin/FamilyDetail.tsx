// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** One household's record (window content) — what opens when you click a student. Everything the
 *  office needs about that child in one place: their siblings (with Student IDs), the guardians the
 *  household shares, and its emergency contacts.
 *
 *  `readOnly` is finance's view (§5): they read names, contact details and Student IDs, and can do
 *  none of the writing — no adding students, no linking siblings, no withdrawing or deleting. The
 *  server enforces the same walls; this stops finance being shown controls that would only fail. */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Pencil, Printer, Send, Trash2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { withBase } from '../../lib/base';
import { formatUsPhone, telHref } from '../../lib/phone';
import { StudentPicker } from '../../components/StudentPicker';
import { OnboardingSend } from '../../components/OnboardingSend';
import { useWindows } from '../../components/Windows';

/** What a guardian is to the child. Four choices rather than an open box: an office typing "Dad",
 *  "father" and "Father" into three records made the column unusable for anything. Stored as these
 *  lowercase codes and translated for display, so the DB never holds a locale-specific label. */
const RELATIONS = ['father', 'mother', 'relative', 'other'] as const;

/** A relation for display. Anything not in the list — free text from before 0.41.0, and every
 *  CSV-imported one — is shown as it was typed, because "Uncle" is still the truth about that
 *  guardian; only the first letter is raised, so it reads like a label beside the four known ones
 *  rather than like a database value (matches the printed sheet — people/relations.ts). */
function relationLabel(t: TFunction, raw: string | null | undefined): string {
  if (!raw) return '';
  const fallback = raw.charAt(0).toUpperCase() + raw.slice(1);
  return t(`relation.${raw}`, { defaultValue: fallback });
}

export function FamilyDetail({ familyId, readOnly = false }: { familyId: string; readOnly?: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.people.familyGet.useQuery({ id: familyId });
  const { open } = useWindows();

  /**
   * The onboarding message for THIS household.
   *
   * Passes the household's students rather than a family id, so the one send path is the same one the
   * roster-wide dialog uses (`kind: 'students'`) and the server collapses it to this household exactly as
   * it would any other selection — no second route, no second set of gates.
   */
  const openOnboarding = () =>
    open({
      title: t('onboarding.titleOne', { family: q.data?.family.name ?? '' }),
      dedupeKey: `onboarding:${familyId}`,
      icon: <Send size={15} />,
      node: <OnboardingSend studentIds={(q.data?.students ?? []).map((s) => s.id)} familyLabel={q.data?.family.name ?? ''} />,
    });

  const refresh = async () => {
    await utils.people.familyGet.invalidate({ id: familyId });
    await utils.people.directory.invalidate();
  };

  const addStudent = trpc.people.studentCreate.useMutation();
  const updateStudent = trpc.people.studentUpdate.useMutation();
  const addGuardian = trpc.people.guardianCreate.useMutation();
  const updateGuardian = trpc.people.guardianUpdate.useMutation();
  const guardianWa = trpc.people.guardianWhatsApp.useMutation();
  const removeGuardian = trpc.people.guardianRemove.useMutation();
  const removeContact = trpc.people.emergencyContactRemove.useMutation();
  const deleteStudent = trpc.people.studentDelete.useMutation();
  const addEC = trpc.people.emergencyContactAdd.useMutation();
  const invite = trpc.auth.inviteCreate.useMutation();
  const guardianReset = trpc.auth.sendGuardianReset.useMutation();
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});
  const [inviteErr, setInviteErr] = useState<Record<string, string>>({});
  /** Whether the email actually went out, and why not — so a suppressed send isn't invisible. */
  const [mailNote, setMailNote] = useState<Record<string, string>>({});
  /** The guardian being edited. Editing matters beyond tidiness: a reset can only be emailed to a
   *  guardian who HAS an email, and without this there was no way to add one. */
  const [guardianEdit, setGuardianEdit] = useState<{ id: string; name: string; phone: string; email: string; relation: string; phoneCountry: string } | null>(null);
  // Which country a guardian's number is in (0.50.0) — only offered when the masjid has actually
  // switched WhatsApp on and listed more than one, since it means nothing otherwise.
  //
  // Not asked for at all in finance's view: the settings are admin-only (§5), so finance would get a
  // 403 on every family they opened — and they cannot edit a guardian here anyway.
  const waCfg = trpc.whatsapp.get.useQuery(undefined, { enabled: !readOnly });
  const countries = waCfg.data?.enabled ? waCfg.data.countries : [];
  /** Why a delete was refused — shown as text, since it is the useful half of the interaction. */
  const [deleteErr, setDeleteErr] = useState('');
  /** The same, for the guardian and contact rows below. */
  const [guardianErr, setGuardianErr] = useState('');

  // A student MUST be put on a fee plan at creation — one with no plan is silently skipped by
  // invoice generation, which is how a child stops being billed without anyone noticing.
  const feePlans = trpc.billing.feePlanList.useQuery();

  /** Adding a sibling to THIS household — one choice, the child to bring in. It used to ask which
   *  student on this record they were a sibling OF, which was a question with no useful answer: every
   *  child here already shares one household, so any answer gave the same result. */
  const studentOptions = trpc.people.studentOptions.useQuery();
  const addSibling = trpc.people.familyAddSibling.useMutation();
  const unlinkSiblings = trpc.people.studentUnlinkSiblings.useMutation();
  const [siblingId, setSiblingId] = useState('');
  const [linkErr, setLinkErr] = useState('');

  async function submitAddSibling(e: FormEvent) {
    e.preventDefault();
    if (!siblingId) return;
    setLinkErr('');
    try {
      await addSibling.mutateAsync({ familyId, studentId: siblingId });
      setSiblingId('');
      await refresh();
      await utils.people.studentOptions.invalidate();
      await utils.structure.studentsByClass.invalidate();
    } catch (err) {
      setLinkErr((err as Error).message);
    }
  }

  async function unlink(studentId: string, name: string) {
    if (!window.confirm(t('directory.confirmUnlink', { name }))) return;
    setLinkErr('');
    try {
      await unlinkSiblings.mutateAsync({ studentId });
      await refresh();
      await utils.people.studentOptions.invalidate();
      await utils.structure.studentsByClass.invalidate();
    } catch (err) {
      setLinkErr((err as Error).message);
    }
  }

  const [showStudent, setShowStudent] = useState(false);
  /** `billFromPeriod` empty means "bill nothing yet", which is what adding a student has always done. */
  const [stu, setStu] = useState({ fullName: '', dob: '', feePlanId: '', billFromPeriod: '' });
  /** The months a mid-year catch-up may start from, and what the last one actually billed (0.48.0). */
  const billFrom = trpc.billing.billFromMonths.useQuery();
  const [billedMsg, setBilledMsg] = useState<string | null>(null);
  const [showGuardian, setShowGuardian] = useState(false);
  const [grd, setGrd] = useState({ name: '', phone: '', email: '', relation: '', phoneCountry: '' });
  const [showEC, setShowEC] = useState(false);
  const [ec, setEc] = useState({ name: '', phone: '', relation: '' });

  async function submitStudent(e: FormEvent) {
    e.preventDefault();
    if (!stu.fullName.trim() || !stu.feePlanId) return;
    const r = await addStudent.mutateAsync({ familyId, fullName: stu.fullName.trim(), dob: stu.dob || undefined, feePlanId: stu.feePlanId, billFromPeriod: stu.billFromPeriod || undefined });
    // A catch-up is never silent — five new invoices on a household is news (0.48.0).
    setBilledMsg(
      !r.billed
        ? null
        : r.billed.created
          ? t('students.billedFrom', { count: r.billed.created, from: r.billed.periods[0] })
          : t(`students.billedNone_${r.billed.reason ?? 'nothing_to_bill'}`),
    );
    setStu({ fullName: '', dob: '', feePlanId: '', billFromPeriod: stu.billFromPeriod });
    setShowStudent(false);
    await refresh();
  }
  async function submitGuardian(e: FormEvent) {
    e.preventDefault();
    if (!grd.name.trim()) return;
    await addGuardian.mutateAsync({ familyId, name: grd.name.trim(), phone: grd.phone || undefined, email: grd.email || undefined, relation: grd.relation || undefined, phoneCountry: grd.phoneCountry || undefined });
    setGrd({ name: '', phone: '', email: '', relation: '', phoneCountry: '' });
    setShowGuardian(false);
    await refresh();
  }
  async function submitEC(e: FormEvent) {
    e.preventDefault();
    if (!ec.name.trim()) return;
    await addEC.mutateAsync({ familyId, name: ec.name.trim(), phone: ec.phone || undefined, relation: ec.relation || undefined });
    setEc({ name: '', phone: '', relation: '' });
    setShowEC(false);
    await refresh();
  }
  /**
   * Withdraw a child, or bring them back.
   *
   * Only WITHDRAWING asks (0.48.0), and it says what withdrawing does: it stops future billing, which is
   * not obvious from the word and is the whole reason the office presses it. Re-activating needs no
   * confirmation — it takes nothing away, and a dialog on a harmless action is how people learn to click
   * through the ones that matter.
   */
  async function toggleWithdraw(id: string, status: 'active' | 'withdrawn', name: string) {
    if (status === 'active' && !window.confirm(t('directory.confirmWithdraw', { name }))) return;
    await updateStudent.mutateAsync({ id, status: status === 'active' ? 'withdrawn' : 'active' });
    await refresh();
  }
  /** Turn the server's reason for not emailing into something the office can act on. */
  function explainSkip(skipped: string | null | undefined, emailed: boolean): string {
    if (emailed) return t('directory.mailSent');
    // The pause is a DELIBERATE choice somebody made in Settings, so it is named as such rather than
    // reported as a failure — otherwise a paused install looks like broken email.
    if (skipped === 'parents_paused') return t('directory.mailPaused');
    if (skipped === 'no_public_url') return t('directory.mailNoUrl');
    if (skipped === 'no_transport') return t('directory.mailNoTransport');
    return t('directory.mailNotSent');
  }

  async function inviteToPortal(guardianId: string) {
    setInviteErr((e) => ({ ...e, [guardianId]: '' }));
    try {
      const r = await invite.mutateAsync({ guardianId });
      // Always show the link: it works whether or not the email went out (CLAUDE.md §12).
      const full = r.url.startsWith('http') ? r.url : `${window.location.origin}${r.url}`;
      setInviteLinks((m) => ({ ...m, [guardianId]: full }));
      setMailNote((m) => ({ ...m, [guardianId]: explainSkip(r.mailSkipped, r.emailed) }));
    } catch (err) {
      setInviteErr((e) => ({ ...e, [guardianId]: (err as Error).message }));
    }
  }

  /** Ask the server whether this student can be deleted, then confirm with the real reason either
   *  way. The precheck exists so the office is never told "no" only after committing to the click. */
  async function askDelete(studentId: string, name: string) {
    setDeleteErr('');
    try {
      const info = await utils.people.studentDeletable.fetch({ studentId });
      if (!info.deletable) {
        // Money that ARRIVED and money that was BILLED are different problems with different fixes,
        // so they get different sentences — "reverse the payment first" is useless advice to someone
        // whose actual blocker is an invoice.
        setDeleteErr(
          info.payments > 0 && info.invoiceLines + info.invoicedCharges + info.invoices === 0
            ? t('directory.deleteBlockedPaid', { name, count: info.payments })
            : t('directory.deleteBlocked', { name, count: info.invoiceLines + info.invoicedCharges + info.invoices }),
        );
        return;
      }
      const extra = info.feeAssignments + info.pendingCharges;
      if (!window.confirm(extra > 0 ? t('directory.confirmDeleteWithExtras', { name, count: extra }) : t('directory.confirmDelete', { name }))) return;
      await deleteStudent.mutateAsync({ studentId });
      await refresh();
    } catch (err) {
      setDeleteErr((err as Error).message);
    }
  }

  async function saveGuardian(e: FormEvent) {
    e.preventDefault();
    if (!guardianEdit || !guardianEdit.name.trim()) return;
    await updateGuardian.mutateAsync({
      id: guardianEdit.id,
      name: guardianEdit.name.trim(),
      // '' clears the field server-side (blankToNull), which is how a wrong number is removed.
      phone: guardianEdit.phone,
      email: guardianEdit.email.trim(),
      // The relationship belongs to the guardian↔household LINK, so the server needs to know which
      // household — a guardian can be on more than one.
      familyId,
      relation: guardianEdit.relation,
      phoneCountry: guardianEdit.phoneCountry,
    });
    setGuardianEdit(null);
    await refresh();
  }

  /**
   * Delete a guardian, having first asked the server what that will actually mean here.
   *
   * Three different sentences, because they are three different consequences: unlinked from this
   * household but kept for another; deleted outright; or deleted along with their portal login. The
   * last one is the reason this asks the server at all rather than just confirming and posting.
   */
  /**
   * Record that this parent does or does not want WhatsApp (0.51.0).
   *
   * No confirmation dialog: it is one tap to undo, and the chip beside the name says which state it is
   * in. A dialog on something this reversible is how people learn to click through the ones that
   * matter (§15).
   */
  async function setGuardianWa(guardianId: string, optOut: boolean) {
    setGuardianErr('');
    try {
      await guardianWa.mutateAsync({ id: guardianId, optOut });
      await refresh();
    } catch (err) {
      setGuardianErr((err as Error).message);
    }
  }

  async function askRemoveGuardian(guardianId: string, name: string) {
    setGuardianErr('');
    try {
      const info = await utils.people.guardianRemovable.fetch({ guardianId, familyId });
      const msg = info.deletesAccount
        ? t('directory.confirmGuardianDeleteAccount', { name })
        : info.deletesPerson
          ? t('directory.confirmGuardianDelete', { name })
          : t('directory.confirmGuardianUnlink', { name, count: info.otherFamilies });
      if (!window.confirm(msg)) return;
      await removeGuardian.mutateAsync({ guardianId, familyId });
      await refresh();
    } catch (err) {
      setGuardianErr((err as Error).message);
    }
  }

  async function askRemoveContact(id: string, name: string) {
    setGuardianErr('');
    if (!window.confirm(t('directory.confirmContactDelete', { name }))) return;
    try {
      await removeContact.mutateAsync({ id });
      await refresh();
    } catch (err) {
      setGuardianErr((err as Error).message);
    }
  }

  async function sendReset(guardianId: string) {
    setInviteErr((e) => ({ ...e, [guardianId]: '' }));
    try {
      const r = await guardianReset.mutateAsync({ guardianId });
      const full = r.url.startsWith('http') ? r.url : `${window.location.origin}${r.url}`;
      setInviteLinks((m) => ({ ...m, [guardianId]: full }));
      setMailNote((m) => ({ ...m, [guardianId]: explainSkip(r.mailSkipped, r.emailed) }));
    } catch (err) {
      setInviteErr((e) => ({ ...e, [guardianId]: (err as Error).message }));
    }
  }

  if (q.isLoading || !q.data) return <p className="empty">{t('common.loading')}</p>;
  const { students, guardians, emergencyContacts } = q.data;

  return (
    <div className="win-content">
      {/* Students */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('directory.students')}</h2>
          <span className="spacer" />
          {/* The onboarding sheet is per HOUSEHOLD, not per child — the parents, the emergency contacts,
              the portal QR and the whole "how to pay" section are the same for every child, so a sheet
              each meant handing a family of three three mostly-identical pages and no single page
              showing what the household owes. It sits here rather than on a student row for that reason.
              Not behind `readOnly`: finance prints and hands these out too, and the route allows
              exactly the same two roles. */}
          <a
            className="btn btn--ghost btn--sm"
            href={withBase(`/sheets/family/${familyId}`)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Printer size={14} /> {t('directory.printSheet')}
          </a>
          {/* The onboarding message, for THIS household. Beside the sheet button and household-scoped for
              exactly the same reason spelled out above it: the guardians are the household's, so a
              message aimed at one child reaches the adults who also pay for their siblings. A button on
              each student row would have looked like three different sends of one message.
              Admin only, unlike the sheet — printing something to hand over is finance's job; writing to
              a family in the madrasah's voice is not (§5). */}
          {!readOnly && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={openOnboarding}>
              <Send size={14} /> {t('onboarding.buttonOne')}
            </button>
          )}
          {!readOnly && <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowStudent((v) => !v)}>{t('directory.addStudent')}</button>}
        </div>
        {students.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('directory.noStudents')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>{t('directory.name')}</th><th>{t('directory.studentId')}</th><th>{t('directory.status')}</th><th className="actions" /></tr></thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.id}>
                    <td>{s.fullName}</td>
                    {/* The ID a parent types to pay, at the kiosk or on the donation site. Read it out
                        freely — it is printed on the statement and is not a secret. */}
                    <td><span className="code">{s.studentCode ?? '—'}</span></td>
                    <td>{s.status === 'withdrawn' ? <span className="chip is-muted">{t('directory.withdrawn')}</span> : <span className="chip">{t('directory.active')}</span>}</td>
                    <td className="actions">
                      {!readOnly && (
                        <>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => toggleWithdraw(s.id, s.status, s.fullName)} disabled={updateStudent.isPending}>{s.status === 'active' ? t('directory.withdraw') : t('directory.reinstate')}</button>
                          {/* Delete is for a mistake — a duplicate or a child who never enrolled. A student
                              who has been billed is part of the invoice history and can only be withdrawn,
                              so ask the server first and say why rather than offering a button that fails. */}
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => askDelete(s.id, s.fullName)}>{t('common.delete')}</button>
                          {students.length > 1 && (
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => unlink(s.id, s.fullName)} disabled={unlinkSiblings.isPending}>
                              {t('directory.unlinkSibling')}
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {deleteErr && (
                  <tr>
                    <td colSpan={5}><p className="form-error" style={{ margin: '0.25rem 0 0' }}>{deleteErr}</p></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {showStudent && (
          <form className="inline-form glass-inset" onSubmit={submitStudent}>
            <div className="field" style={{ flex: '2 1 14rem' }}><label className="label">{t('directory.fullName')}</label><input className="input glass-inset" value={stu.fullName} onChange={(e) => setStu({ ...stu, fullName: e.target.value })} autoFocus /></div>
            <div className="field"><label className="label">{t('directory.dob')}</label><input type="date" className="input glass-inset" value={stu.dob} onChange={(e) => setStu({ ...stu, dob: e.target.value })} /></div>
            <div className="field">
              <label className="label">{t('directory.feePlan')}</label>
              <select className="input glass-inset" value={stu.feePlanId} onChange={(e) => setStu({ ...stu, feePlanId: e.target.value })} required>
                <option value="">—</option>
                {(feePlans.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <p className="hint">{feePlans.data && feePlans.data.length === 0 ? t('directory.noFeePlans') : t('directory.feePlanHint')}</p>
            </div>
            {/* Joining part-way through the year (0.48.0) — the same choice the Students tab offers, so a
                child added into an existing household is treated no differently from one starting a new.
                Always rendered, for the reason set out on the Students tab: an empty month list is an
                ordinary state, and hiding the field for it made the feature impossible to find. */}
            <div className="field" style={{ flex: '1 1 12rem' }}>
              <label className="label" htmlFor="fd-billfrom">{t('students.billFrom')}</label>
              <select
                id="fd-billfrom"
                className="input glass-inset"
                value={stu.billFromPeriod}
                disabled={(billFrom.data?.months ?? []).length === 0}
                onChange={(e) => setStu({ ...stu, billFromPeriod: e.target.value })}
              >
                <option value="">{t('students.billFromNone')}</option>
                {(billFrom.data?.months ?? []).map((m) => (
                  <option key={m.periodKey} value={m.periodKey}>
                    {m.periodKey === billFrom.data?.current ? t('students.billFromThisMonth', { month: m.label }) : m.label}
                  </option>
                ))}
              </select>
              <p className="hint">
                {(billFrom.data?.months ?? []).length === 0
                  ? t('students.billFromEmpty')
                  : !stu.billFromPeriod
                    ? t('students.billFromNoneHint')
                    : stu.billFromPeriod > (billFrom.data?.current ?? '')
                      ? t('students.billFromFutureHint')
                      : t('students.billFromHint')}
              </p>
            </div>
            <button type="submit" className="btn btn--primary" disabled={addStudent.isPending || !stu.feePlanId}>{t('common.save')}</button>
          </form>
        )}
        {billedMsg && (
          <div className="notice" style={{ marginBlockStart: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ flex: 1 }}>{billedMsg}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBilledMsg(null)}>{t('common.close')}</button>
          </div>
        )}
        {showStudent && <p className="hint">{t('directory.idHint')}</p>}
      </section>

      {/* Guardians */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('directory.guardians')}</h2>
          <span className="spacer" />
          {!readOnly && <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowGuardian((v) => !v)}>{t('directory.addGuardian')}</button>}
        </div>
        {guardians.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('directory.noGuardians')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {guardians.map((g) => (
              <div key={g.guardianId} className="glass-inset" style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-button)', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{g.name}</strong>
                {g.relation && <span className="muted">· {relationLabel(t, g.relation)}</span>}
                {/* Tappable: the office rings a parent from this screen, and on a phone that should be
                    one tap rather than a copy-paste. The href is built from the digits, never from the
                    formatted text (lib/phone.ts). */}
                {g.phone && <a className="muted" href={telHref(g.phone)}>· {formatUsPhone(g.phone)}</a>}
                {g.email && <a className="muted" href={`mailto:${g.email}`}>· {g.email}</a>}
                {g.isEmergencyContact && <span className="chip is-accent">{t('directory.emergency')}</span>}
                {/* This person is not messaged on WhatsApp (0.50.0). The chip alone was the whole
                    feature at first — shown, never changeable — on the reasoning that it is the
                    parent's own answer. But a parent says "stop messaging me" at pickup, not by
                    finding a toggle in a portal, so from 0.51.0 the office can record it here too. It
                    sets the same one flag, so nothing overrides it either way (§9). */}
                {g.waOptOut && countries.length > 0 && <span className="chip is-muted">{t('directory.waOptedOut')}</span>}
                {/* Whether they took up a portal account decides which action is useful: an invite for
                    someone who never signed up, a reset for someone who did and forgot. */}
                {g.hasAccount ? (
                  <span className={`chip ${g.accountStatus === 'active' ? '' : 'is-muted'}`}>
                    {g.accountStatus === 'active' ? t('directory.hasAccount') : t('directory.accountDisabled')}
                  </span>
                ) : (
                  <span className="chip is-muted">{t('directory.noAccount')}</span>
                )}
                <span className="spacer" style={{ marginInlineStart: 'auto' }} />
                {/* Editing a guardian is a people write, so admin only. Invites and resets below are
                    NOT — finance runs parent accounts (§5), so those stay available to them. */}
                {!readOnly && (
                  <>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setGuardianEdit({ id: g.guardianId, name: g.name, phone: formatUsPhone(g.phone), email: g.email ?? '', relation: g.relation ?? '', phoneCountry: g.phoneCountry ?? '' })}>
                      <Pencil size={13} /> {t('common.edit')}
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => void askRemoveGuardian(g.guardianId, g.name)} disabled={removeGuardian.isPending}>
                      <Trash2 size={13} /> {t('common.delete')}
                    </button>
                    {/* Only where WhatsApp is actually configured — the same `countries` condition the
                        chip uses. On an install that does not use it this is a button about nothing. */}
                    {countries.length > 0 && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void setGuardianWa(g.guardianId, !g.waOptOut)}
                        disabled={guardianWa.isPending}
                        title={t(g.waOptOut ? 'directory.waResumeHint' : 'directory.waStopHint')}
                      >
                        {t(g.waOptOut ? 'directory.waResume' : 'directory.waStop')}
                      </button>
                    )}
                  </>
                )}
                {g.hasAccount ? (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => sendReset(g.guardianId)} disabled={guardianReset.isPending || !g.canSendReset}>
                    {t('directory.sendReset')}
                  </button>
                ) : (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => inviteToPortal(g.guardianId)} disabled={invite.isPending}>{t('directory.inviteToPortal')}</button>
                )}
                {/* A disabled button with only a `title` tooltip is invisible on a phone and to a
                    keyboard user, so say it as real text — and it is actionable now that Edit exists. */}
                {g.hasAccount && !g.canSendReset && <p className="hint" style={{ flexBasis: '100%', margin: '0.25rem 0 0' }}>{t('directory.resetNeedsEmail')}</p>}
                {inviteErr[g.guardianId] && <p className="form-error" style={{ flexBasis: '100%', margin: '0.25rem 0 0' }}>{inviteErr[g.guardianId]}</p>}
                {mailNote[g.guardianId] && <p className="hint" style={{ flexBasis: '100%', margin: '0.25rem 0 0' }}>{mailNote[g.guardianId]}</p>}
                {inviteLinks[g.guardianId] && (
                  <div style={{ flexBasis: '100%', display: 'flex', gap: '0.4rem', alignItems: 'center', marginBlockStart: '0.4rem' }}>
                    <input className="input glass-inset" readOnly value={inviteLinks[g.guardianId]} style={{ flex: 1, fontSize: '0.82rem' }} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => navigator.clipboard?.writeText(inviteLinks[g.guardianId])}>{t('common.copy')}</button>
                  </div>
                )}
              </div>
            ))}
            <p className="hint">{t('directory.inviteHint')}</p>
            {guardianErr && <p className="form-error">{guardianErr}</p>}
          </div>
        )}
        {guardianEdit && (
          <form className="inline-form glass-inset" onSubmit={saveGuardian}>
            <div className="field"><label className="label">{t('directory.name')}</label><input className="input glass-inset" value={guardianEdit.name} onChange={(e) => setGuardianEdit({ ...guardianEdit, name: e.target.value })} autoFocus /></div>
            <div className="field">
              <label className="label">{t('directory.relation')}</label>
              <select className="input glass-inset" value={guardianEdit.relation} onChange={(e) => setGuardianEdit({ ...guardianEdit, relation: e.target.value })}>
                <option value="">—</option>
                {/* Free text from before the dropdown ("Uncle") is offered as itself, so opening the
                    form to fix a phone number cannot quietly overwrite what the office recorded. */}
                {guardianEdit.relation && !RELATIONS.some((r) => r === guardianEdit.relation) && (
                  <option value={guardianEdit.relation}>{guardianEdit.relation}</option>
                )}
                {RELATIONS.map((r) => <option key={r} value={r}>{t(`relation.${r}`)}</option>)}
              </select>
            </div>
            <div className="field"><label className="label">{t('directory.phone')}</label><input className="input glass-inset" type="tel" inputMode="tel" autoComplete="tel" value={guardianEdit.phone} onChange={(e) => setGuardianEdit({ ...guardianEdit, phone: formatUsPhone(e.target.value) })} /></div>
            {countries.length > 1 && (
              <div className="field" style={{ flex: '0 1 7rem' }}>
                <label className="label">{t('settings.waCountry')}</label>
                <select className="input glass-inset" value={guardianEdit.phoneCountry} onChange={(e) => setGuardianEdit({ ...guardianEdit, phoneCountry: e.target.value })}>
                  <option value="">{t('settings.waCountryDefault', { code: waCfg.data!.defaultCountry })}</option>
                  {countries.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
            )}
            <div className="field"><label className="label">{t('directory.email')}</label><input className="input glass-inset" type="email" value={guardianEdit.email} onChange={(e) => setGuardianEdit({ ...guardianEdit, email: e.target.value })} /></div>
            <button type="submit" className="btn btn--primary" disabled={updateGuardian.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setGuardianEdit(null)}>{t('common.cancel')}</button>
            <p className="hint">{t('directory.guardianEditHint')}</p>
          </form>
        )}
        {showGuardian && (
          <form className="inline-form glass-inset" onSubmit={submitGuardian}>
            <div className="field"><label className="label">{t('directory.name')}</label><input className="input glass-inset" value={grd.name} onChange={(e) => setGrd({ ...grd, name: e.target.value })} autoFocus /></div>
            <div className="field">
              <label className="label">{t('directory.relation')}</label>
              <select className="input glass-inset" value={grd.relation} onChange={(e) => setGrd({ ...grd, relation: e.target.value })}>
                <option value="">—</option>
                {RELATIONS.map((r) => <option key={r} value={r}>{t(`relation.${r}`)}</option>)}
              </select>
            </div>
            <div className="field"><label className="label">{t('directory.phone')}</label><input className="input glass-inset" type="tel" inputMode="tel" autoComplete="tel" value={grd.phone} onChange={(e) => setGrd({ ...grd, phone: formatUsPhone(e.target.value) })} /></div>
            {countries.length > 1 && (
              <div className="field" style={{ flex: '0 1 7rem' }}>
                <label className="label">{t('settings.waCountry')}</label>
                <select className="input glass-inset" value={grd.phoneCountry} onChange={(e) => setGrd({ ...grd, phoneCountry: e.target.value })}>
                  <option value="">{t('settings.waCountryDefault', { code: waCfg.data!.defaultCountry })}</option>
                  {countries.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
            )}
            <div className="field"><label className="label">{t('directory.email')}</label><input className="input glass-inset" value={grd.email} onChange={(e) => setGrd({ ...grd, email: e.target.value })} /></div>
            {/* No "emergency contact" tick here any more: there is a whole Emergency contacts section
                directly below, and two ways to say the same thing meant an office ticking the box then
                wondering why nobody appeared in that list. Guardians flagged before 0.42.0 still show
                their badge. */}
            <button type="submit" className="btn btn--primary" disabled={addGuardian.isPending}>{t('common.save')}</button>
          </form>
        )}
      </section>

      {/* Emergency contacts */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('directory.emergencyContacts')}</h2>
          <span className="spacer" />
          {!readOnly && <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowEC((v) => !v)}>{t('directory.addContact')}</button>}
        </div>
        {emergencyContacts.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('directory.noContacts')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {emergencyContacts.map((c) => (
              <div key={c.id} className="glass-inset" style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-button)', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{c.name}</strong>
                {c.relation && <span className="muted">· {relationLabel(t, c.relation)}</span>}
                {c.phone && <a className="muted" href={telHref(c.phone)}>· {formatUsPhone(c.phone)}</a>}
                <span className="spacer" style={{ marginInlineStart: 'auto' }} />
                {!readOnly && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void askRemoveContact(c.id, c.name)} disabled={removeContact.isPending}>
                    <Trash2 size={13} /> {t('common.delete')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {showEC && (
          <form className="inline-form glass-inset" onSubmit={submitEC}>
            <div className="field"><label className="label">{t('directory.name')}</label><input className="input glass-inset" value={ec.name} onChange={(e) => setEc({ ...ec, name: e.target.value })} autoFocus /></div>
            {/* Free text here, unlike a guardian: "neighbour", "aunt two doors down" is the useful
                answer for whoever the office would actually ring, not one of four. */}
            <div className="field"><label className="label">{t('directory.relation')}</label><input className="input glass-inset" value={ec.relation} onChange={(e) => setEc({ ...ec, relation: e.target.value })} placeholder={t('directory.relationPlaceholder')} /></div>
            <div className="field"><label className="label">{t('directory.phone')}</label><input className="input glass-inset" type="tel" inputMode="tel" autoComplete="tel" value={ec.phone} onChange={(e) => setEc({ ...ec, phone: formatUsPhone(e.target.value) })} /></div>
            <button type="submit" className="btn btn--primary" disabled={addEC.isPending}>{t('common.save')}</button>
          </form>
        )}
      </section>

      {/* Add a sibling — at the bottom, because it is the thing you reach for after reading the
          record and realizing a child belongs on it. One choice: which child. The household you are
          looking at is the one they join, so there is nothing else to say. */}
      {!readOnly && (
        <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h2>{t('directory.addSibling')}</h2>
          </div>
          <p className="hint" style={{ marginBlockStart: 0 }}>{t('directory.addSiblingHint')}</p>
          <form className="inline-form glass-inset" onSubmit={submitAddSibling}>
            <div style={{ flex: '1 1 18rem' }}>
              {/* Type or browse — a roster of three hundred is not something anyone scrolls a
                  <select> through, and the office often knows the name but not where it sits. */}
              <StudentPicker
                id="add-sibling"
                label={t('directory.siblingStudent')}
                students={studentOptions.data ?? []}
                value={siblingId}
                onChange={setSiblingId}
                // The household is shown here because it is what is being chosen: this MERGES two
                // households, so "which Ismail?" is the question, not a decoration.
                showFamily
                // Only children OUTSIDE this household: the ones already here have nothing to join.
                exclude={students.map((own) => own.id)}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={addSibling.isPending || !siblingId}>{t('directory.addSiblingAction')}</button>
          </form>
          {linkErr && <p className="form-error">{linkErr}</p>}
        </section>
      )}
    </div>
  );
}
