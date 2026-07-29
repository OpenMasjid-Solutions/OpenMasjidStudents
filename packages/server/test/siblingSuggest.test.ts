// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Sibling suggestions — the step that finishes a CSV import (0.42.0).
 *
 * The import deliberately guesses nothing, so a file of 120 children lands as 120 households. This
 * suggests the groups and a human confirms them. What matters here:
 *  - a shared guardian phone/email is STRONG evidence and is reported as `contact`
 *  - a shared surname alone is WEAK — three unrelated Ismail families in one roster is normal — and is
 *    reported separately as `surname`, so the UI can leave it unticked
 *  - households the office has ALREADY built are never suggested, so this can be run any time
 *  - accepting a group merges the households, folding the duplicate guardian records with it
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians, emergencyContacts, students, families, autopayEnrollments, paymentMethods } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, autopayEnrollments, paymentMethods, studentFees, feePlans, guardianFamilies, guardians, emergencyContacts, students, families]) db.delete(t).run();
});

/** Import-shaped: one student per household, one guardian record per student. */
async function imported(rows: { name: string; guardian?: string; phone?: string; email?: string }[]) {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
  const out: { id: string; familyId: string; name: string }[] = [];
  for (const r of rows) {
    const s = await admin.people.studentAdd({ fullName: r.name, feePlanId: plan.id });
    if (r.guardian) await admin.people.guardianCreate({ familyId: s.familyId, name: r.guardian, phone: r.phone, email: r.email });
    out.push({ id: s.id, familyId: s.familyId, name: r.name });
  }
  return { admin, kids: out };
}

describe('siblingSuggestions', () => {
  it('groups children whose guardians share a phone number, as strong evidence', async () => {
    const { admin, kids } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '(555) 123-4567' },
      { name: 'Maryam Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      { name: 'Bilal Farooqi', guardian: 'Abu Bilal', phone: '5559998888' },
    ]);
    const groups = await admin.people.siblingSuggestions();
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('contact');
    expect(groups[0].students.map((s) => s.id).sort()).toEqual([kids[0].id, kids[1].id].sort());
    // The evidence itself comes back, so the office sees WHY rather than being asked to trust it.
    expect(groups[0].label).toMatch(/555/);
  });

  it('bridges a group through two different shared details', async () => {
    // A shares a phone with B; B shares an email with C. All three are one family.
    const { admin } = await imported([
      { name: 'A Khan', guardian: 'Dad', phone: '5551110000' },
      { name: 'B Khan', guardian: 'Dad', phone: '5551110000', email: 'dad@test.org' },
      { name: 'C Khan', guardian: 'Dad', email: 'dad@test.org' },
    ]);
    const groups = await admin.people.siblingSuggestions();
    expect(groups).toHaveLength(1);
    expect(groups[0].students).toHaveLength(3);
  });

  it('reports a surname-only match separately, and never merges it with the contact groups', async () => {
    const { admin } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      { name: 'Maryam Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      // Same surname, no contact in common — possibly a different Ismail family entirely.
      { name: 'Zaid Ismail', guardian: 'Abu Zaid', phone: '5557776666' },
    ]);
    const groups = await admin.people.siblingSuggestions();
    // Contact first, then surname — the UI shows strong evidence at the top. Zaid is alone in the
    // surname pass (the other two were already claimed), so no weak group survives the >1 filter.
    expect(groups.map((g) => g.reason)).toEqual(['contact']);
    expect(groups[0].students).toHaveLength(2);
  });

  it('suggests a surname-only group when that is genuinely all there is', async () => {
    const { admin } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      { name: 'Zaid Ismail', guardian: 'Abu Zaid', phone: '5557776666' },
    ]);
    const groups = await admin.people.siblingSuggestions();
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('surname');
    expect(groups[0].label).toBe('Ismail');
  });

  it('does not suggest anything for children who are already in a household together', async () => {
    const { admin, kids } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      { name: 'Maryam Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
    ]);
    await admin.people.familyAddSibling({ familyId: kids[1].familyId, studentId: kids[0].id });
    expect(await admin.people.siblingSuggestions()).toEqual([]);
  });

  it('ignores a guardian NAME shared across households — two families can both have a Mohammed', async () => {
    const { admin } = await imported([
      { name: 'Ali Hassan', guardian: 'Mohammed', phone: '5551111111' },
      { name: 'Omar Sheikh', guardian: 'Mohammed', phone: '5552222222' },
    ]);
    // Different surnames, different numbers: nothing to suggest.
    expect(await admin.people.siblingSuggestions()).toEqual([]);
  });

  it('is admin-only and LAN-only', async () => {
    await imported([{ name: 'A Khan' }, { name: 'B Khan' }]);
    await expect(caller('finance').people.siblingSuggestions()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').people.siblingSuggestions()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('linkSiblingGroup', () => {
  it('merges a whole group in one action and folds the duplicate guardians', async () => {
    const { admin, kids } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '(555) 123-4567' },
      { name: 'Maryam Ismail', guardian: 'Abu Yusuf', phone: '5551234567', email: 'abu@test.org' },
      { name: 'Bilal Ismail', guardian: 'Abu Yusuf', phone: '555-123-4567' },
    ]);
    const r = await admin.people.linkSiblingGroup({ studentIds: kids.map((k) => k.id) });
    expect(r.linked).toBe(3);
    // Three copies of one father collapse to one record, keeping the email only one of them had.
    expect(r.mergedGuardians).toBe(2);

    const detail = await admin.people.familyGet({ id: r.familyId });
    expect(detail.students).toHaveLength(3);
    expect(detail.guardians).toHaveLength(1);
    expect(detail.guardians[0].email).toBe('abu@test.org');
    expect(detail.family.name).toBe('Ismail family');
    // The emptied households are gone, and the suggestion no longer appears.
    expect((await admin.people.directory()).filter((f) => f.students.length === 0)).toEqual([]);
    expect(await admin.people.siblingSuggestions()).toEqual([]);
  });

  it('keeps each child’s own billing history through the merge', async () => {
    const { admin, kids } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      { name: 'Maryam Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
    ]);
    await admin.billing.generateFamily({ familyId: kids[0].familyId, periodKey: '2026-07', label: 'Jul' });
    await admin.billing.recordManualPayment({ studentId: kids[0].id, amountCents: 10000, channel: 'cash', occurredAt: '2026-07-02' });

    const r = await admin.people.linkSiblingGroup({ studentIds: kids.map((k) => k.id) });
    const billing = await admin.billing.studentBilling({ studentId: kids[0].id });
    expect(billing.invoices).toHaveLength(1);
    expect(billing.balance.owedCents).toBe(25000);
    // The household total is the sum of the children, which is the point of linking them.
    expect((await admin.billing.familyBilling({ familyId: r.familyId })).balance.owedCents).toBe(25000);
  });

  it('refuses when one household in the group has autopay set up', async () => {
    const { admin, kids } = await imported([
      { name: 'Yusuf Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
      { name: 'Maryam Ismail', guardian: 'Abu Yusuf', phone: '5551234567' },
    ]);
    const ts = new Date();
    // Maryam anchors the group (alphabetically first), so the block has to come from Yusuf's side.
    app.dbmod.db.insert(autopayEnrollments).values({ familyId: kids[0].familyId, enabled: true, createdAt: ts, updatedAt: ts }).run();
    await expect(admin.people.linkSiblingGroup({ studentIds: kids.map((k) => k.id) })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('is a no-op when the whole group is already one household', async () => {
    const { admin, kids } = await imported([{ name: 'Yusuf Ismail' }, { name: 'Maryam Ismail' }]);
    await admin.people.familyAddSibling({ familyId: kids[1].familyId, studentId: kids[0].id });
    const r = await admin.people.linkSiblingGroup({ studentIds: kids.map((k) => k.id) });
    expect(r.linked).toBe(0);
  });

  it('is admin-only and LAN-only', async () => {
    const { kids } = await imported([{ name: 'A Khan' }, { name: 'B Khan' }]);
    const ids = kids.map((k) => k.id);
    await expect(caller('finance').people.linkSiblingGroup({ studentIds: ids })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').people.linkSiblingGroup({ studentIds: ids })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
