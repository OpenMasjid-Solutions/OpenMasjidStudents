// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** One family's record (window content): students (PIN + regenerate + withdraw),
 *  guardians, emergency contacts. */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { trpc } from '../../lib/trpc';

export function FamilyDetail({ familyId }: { familyId: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const q = trpc.people.familyGet.useQuery({ id: familyId });

  const refresh = async () => {
    await utils.people.familyGet.invalidate({ id: familyId });
    await utils.people.directory.invalidate();
  };

  const addStudent = trpc.people.studentCreate.useMutation();
  const updateStudent = trpc.people.studentUpdate.useMutation();
  const regen = trpc.people.pinRegenerate.useMutation();
  const addGuardian = trpc.people.guardianCreate.useMutation();
  const updateGuardian = trpc.people.guardianUpdate.useMutation();
  const addEC = trpc.people.emergencyContactAdd.useMutation();
  const invite = trpc.auth.inviteCreate.useMutation();
  const guardianReset = trpc.auth.sendGuardianReset.useMutation();
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});
  const [inviteErr, setInviteErr] = useState<Record<string, string>>({});
  /** Whether the email actually went out, and why not — so a suppressed send isn't invisible. */
  const [mailNote, setMailNote] = useState<Record<string, string>>({});
  /** The guardian being edited. Editing matters beyond tidiness: a reset can only be emailed to a
   *  guardian who HAS an email, and without this there was no way to add one. */
  const [guardianEdit, setGuardianEdit] = useState<{ id: string; name: string; phone: string; email: string } | null>(null);

  // A student MUST be put on a fee plan at creation — one with no plan is silently skipped by
  // invoice generation, which is how a child stops being billed without anyone noticing.
  const feePlans = trpc.billing.feePlanList.useQuery();
  // Every OTHER family, for the "move to a sibling's family" action below.
  const allFamilies = trpc.people.directory.useQuery();
  const otherFamilies = allFamilies.data?.filter((f) => f.id !== familyId).map((f) => ({ id: f.id, name: f.name }));
  const setFamily = trpc.people.studentSetFamily.useMutation();

  async function moveStudent(studentId: string, toFamilyId: string) {
    await setFamily.mutateAsync({ studentId, familyId: toFamilyId });
    await refresh();
  }
  const [showStudent, setShowStudent] = useState(false);
  const [stu, setStu] = useState({ firstName: '', lastName: '', dob: '', feePlanId: '' });
  const [showGuardian, setShowGuardian] = useState(false);
  const [grd, setGrd] = useState({ name: '', phone: '', email: '', relation: '', emergency: false });
  const [showEC, setShowEC] = useState(false);
  const [ec, setEc] = useState({ name: '', phone: '', relation: '' });

  async function submitStudent(e: FormEvent) {
    e.preventDefault();
    if (!stu.firstName.trim() || !stu.lastName.trim() || !stu.feePlanId) return;
    await addStudent.mutateAsync({ familyId, firstName: stu.firstName.trim(), lastName: stu.lastName.trim(), dob: stu.dob || undefined, feePlanId: stu.feePlanId });
    setStu({ firstName: '', lastName: '', dob: '', feePlanId: '' });
    setShowStudent(false);
    await refresh();
  }
  async function submitGuardian(e: FormEvent) {
    e.preventDefault();
    if (!grd.name.trim()) return;
    await addGuardian.mutateAsync({ familyId, name: grd.name.trim(), phone: grd.phone || undefined, email: grd.email || undefined, relation: grd.relation || undefined, isEmergencyContact: grd.emergency });
    setGrd({ name: '', phone: '', email: '', relation: '', emergency: false });
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
  async function toggleWithdraw(id: string, status: 'active' | 'withdrawn') {
    await updateStudent.mutateAsync({ id, status: status === 'active' ? 'withdrawn' : 'active' });
    await refresh();
  }
  async function regenerate(id: string) {
    await regen.mutateAsync({ studentId: id });
    await refresh();
  }
  /** Turn the server's reason for not emailing into something the office can act on. */
  function explainSkip(skipped: string | null | undefined, emailed: boolean): string {
    if (emailed) return t('directory.mailSent');
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

  async function saveGuardian(e: FormEvent) {
    e.preventDefault();
    if (!guardianEdit || !guardianEdit.name.trim()) return;
    await updateGuardian.mutateAsync({
      id: guardianEdit.id,
      name: guardianEdit.name.trim(),
      // '' clears the field server-side (blankToNull), which is how a wrong number is removed.
      phone: guardianEdit.phone,
      email: guardianEdit.email.trim(),
    });
    setGuardianEdit(null);
    await refresh();
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
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowStudent((v) => !v)}>{t('directory.addStudent')}</button>
        </div>
        {students.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('directory.noStudents')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>{t('directory.name')}</th><th>{t('directory.studentId')}</th><th>{t('directory.pin')}</th><th>{t('directory.status')}</th><th className="actions" /></tr></thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.id}>
                    <td>{s.firstName} {s.lastName}</td>
                    {/* The ID a parent types at the kiosk. Not a secret (it is on the statement and
                        derived from the first name) — the PIN beside it is what authorises a payment. */}
                    <td><span className="pin">{s.studentCode ?? '—'}</span></td>
                    <td><span className="pin">{s.pin}</span></td>
                    <td>{s.status === 'withdrawn' ? <span className="chip is-muted">{t('directory.withdrawn')}</span> : <span className="chip">{t('directory.active')}</span>}</td>
                    <td className="actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => regenerate(s.id)} disabled={regen.isPending}>{t('directory.regeneratePin')}</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => toggleWithdraw(s.id, s.status)} disabled={updateStudent.isPending}>{s.status === 'active' ? t('directory.withdraw') : t('directory.reinstate')}</button>
                      {/* Moving a student to a sibling's family is how guardians start applying to
                          them — guardians hang off the FAMILY, so nothing is copied per-student. */}
                      <select
                        className="input glass-inset"
                        style={{ width: 'auto', minWidth: '9rem', padding: '0.2rem 0.35rem' }}
                        value=""
                        onChange={(e) => { if (e.target.value) void moveStudent(s.id, e.target.value); }}
                        aria-label={t('directory.moveToFamily')}
                        disabled={setFamily.isPending}
                      >
                        <option value="">{t('directory.moveToFamily')}</option>
                        {(otherFamilies ?? []).map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showStudent && (
          <form className="inline-form glass-inset" onSubmit={submitStudent}>
            <div className="field"><label className="label">{t('directory.firstName')}</label><input className="input glass-inset" value={stu.firstName} onChange={(e) => setStu({ ...stu, firstName: e.target.value })} autoFocus /></div>
            <div className="field"><label className="label">{t('directory.lastName')}</label><input className="input glass-inset" value={stu.lastName} onChange={(e) => setStu({ ...stu, lastName: e.target.value })} /></div>
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
            <button type="submit" className="btn btn--primary" disabled={addStudent.isPending || !stu.feePlanId}>{t('common.save')}</button>
          </form>
        )}
        {showStudent && <p className="hint">{t('directory.pinHint')}</p>}
      </section>

      {/* Guardians */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('directory.guardians')}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowGuardian((v) => !v)}>{t('directory.addGuardian')}</button>
        </div>
        {guardians.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('directory.noGuardians')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {guardians.map((g) => (
              <div key={g.guardianId} className="glass-inset" style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-button)', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{g.name}</strong>
                {g.relation && <span className="muted">· {g.relation}</span>}
                {g.phone && <span className="muted">· {g.phone}</span>}
                {g.email && <span className="muted">· {g.email}</span>}
                {g.isEmergencyContact && <span className="chip is-accent">{t('directory.emergency')}</span>}
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
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setGuardianEdit({ id: g.guardianId, name: g.name, phone: g.phone ?? '', email: g.email ?? '' })}>
                  <Pencil size={13} /> {t('common.edit')}
                </button>
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
          </div>
        )}
        {guardianEdit && (
          <form className="inline-form glass-inset" onSubmit={saveGuardian}>
            <div className="field"><label className="label">{t('directory.name')}</label><input className="input glass-inset" value={guardianEdit.name} onChange={(e) => setGuardianEdit({ ...guardianEdit, name: e.target.value })} autoFocus /></div>
            <div className="field"><label className="label">{t('directory.phone')}</label><input className="input glass-inset" value={guardianEdit.phone} onChange={(e) => setGuardianEdit({ ...guardianEdit, phone: e.target.value })} /></div>
            <div className="field"><label className="label">{t('directory.email')}</label><input className="input glass-inset" type="email" value={guardianEdit.email} onChange={(e) => setGuardianEdit({ ...guardianEdit, email: e.target.value })} /></div>
            <button type="submit" className="btn btn--primary" disabled={updateGuardian.isPending}>{t('common.save')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setGuardianEdit(null)}>{t('common.cancel')}</button>
            <p className="hint">{t('directory.guardianEditHint')}</p>
          </form>
        )}
        {showGuardian && (
          <form className="inline-form glass-inset" onSubmit={submitGuardian}>
            <div className="field"><label className="label">{t('directory.name')}</label><input className="input glass-inset" value={grd.name} onChange={(e) => setGrd({ ...grd, name: e.target.value })} autoFocus /></div>
            <div className="field"><label className="label">{t('directory.relation')}</label><input className="input glass-inset" value={grd.relation} onChange={(e) => setGrd({ ...grd, relation: e.target.value })} /></div>
            <div className="field"><label className="label">{t('directory.phone')}</label><input className="input glass-inset" value={grd.phone} onChange={(e) => setGrd({ ...grd, phone: e.target.value })} /></div>
            <div className="field"><label className="label">{t('directory.email')}</label><input className="input glass-inset" value={grd.email} onChange={(e) => setGrd({ ...grd, email: e.target.value })} /></div>
            <label className="hint" style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
              <input type="checkbox" checked={grd.emergency} onChange={(e) => setGrd({ ...grd, emergency: e.target.checked })} /> {t('directory.isEmergency')}
            </label>
            <button type="submit" className="btn btn--primary" disabled={addGuardian.isPending}>{t('common.save')}</button>
          </form>
        )}
      </section>

      {/* Emergency contacts */}
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2>{t('directory.emergencyContacts')}</h2>
          <span className="spacer" />
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowEC((v) => !v)}>{t('directory.addContact')}</button>
        </div>
        {emergencyContacts.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.9rem' }}>{t('directory.noContacts')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {emergencyContacts.map((c) => (
              <div key={c.id} className="glass-inset" style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-button)' }}>
                <strong>{c.name}</strong>
                {c.relation && <span className="muted"> · {c.relation}</span>}
                {c.phone && <span className="muted"> · {c.phone}</span>}
              </div>
            ))}
          </div>
        )}
        {showEC && (
          <form className="inline-form glass-inset" onSubmit={submitEC}>
            <div className="field"><label className="label">{t('directory.name')}</label><input className="input glass-inset" value={ec.name} onChange={(e) => setEc({ ...ec, name: e.target.value })} autoFocus /></div>
            <div className="field"><label className="label">{t('directory.relation')}</label><input className="input glass-inset" value={ec.relation} onChange={(e) => setEc({ ...ec, relation: e.target.value })} /></div>
            <div className="field"><label className="label">{t('directory.phone')}</label><input className="input glass-inset" value={ec.phone} onChange={(e) => setEc({ ...ec, phone: e.target.value })} /></div>
            <button type="submit" className="btn btn--primary" disabled={addEC.isPending}>{t('common.save')}</button>
          </form>
        )}
      </section>
    </div>
  );
}
