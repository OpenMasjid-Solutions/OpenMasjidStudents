// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Drizzle schema (SQLite). This app is tuition/fee management for a masjid: families and
 * students (with retrievable name+PIN lookup), fee plans assigned PER STUDENT, family
 * invoices, a derived ledger, manual + Stripe payments, saved cards and autopay — plus the
 * `students/billing` Fabric provider that powers the tuition option on OpenMasjidDonations
 * and OpenMasjidKiosk. No SIS/academics (classes, grades, attendance, exams, report cards).
 *
 * Rules: money in integer cents; balances DERIVED, never stored; payments IMMUTABLE
 * (corrections are reversal rows); FKs RESTRICT on money paths; every table has
 * id/created_at/updated_at. Student PINs are RETRIEVABLE (printed on statements), so the DB
 * file itself is a secret (CLAUDE.md §9, §14) — never a hash-only PIN column. Migrations are
 * forward-only and generated into ./drizzle.
 */
import { sqliteTable, text, integer, primaryKey, index, unique } from 'drizzle-orm/sqlite-core';

/** The roles (CLAUDE.md §5). Admin (LAN-only) manages everything; finance runs billing;
 *  parents get the portal. (Teacher/student roles were removed with the SIS.) */
export type Role = 'admin' | 'finance' | 'parent';

/** App-owned settings (SMTP, Stripe choice, policies, etc. — added over time).
 *  This is NOT a masjid profile; each app owns its own config (org rule). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type Setting = typeof settings.$inferSelect;

/** Local accounts. Password is argon2id (auth/passwords.ts) — never plaintext, never logged.
 *  Soft-disable via `status`, never hard-delete money references (CLAUDE.md §9). */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email'),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<Role>().notNull(),
  status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
  displayName: text('display_name'),
  /** Staff contact + admin-only notes. */
  phone: text('phone'),
  staffNotes: text('staff_notes'),
  /** Staff are forced to set a new password on first login (CLAUDE.md §12). */
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type User = typeof users.$inferSelect;

/** Server-side sessions. The cookie holds an opaque random token; we store only its
 *  SHA-256 (`tokenHash`) so a leaked DB row can't be replayed as a cookie. `source`
 *  distinguishes a local password login from an OpenMasjidOS SSO-minted admin session
 *  (which has no local user row) — see trpc/auth.ts + fabric/platform.ts. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<Role>().notNull(),
  source: text('source').$type<'local' | 'sso'>().notNull(),
  /** Display-only username (untrusted for SSO — CLAUDE.md §12). */
  username: text('username'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
});
export type Session = typeof sessions.$inferSelect;

// ── Structure (school year, terms, courses, classes) ─────────────────────────

/** A school year — the billing calendar (e.g. "1447–1448 / 2026–2027" running Apr→Mar).
 *  `startMonth`/`endMonth` are 1-12; an `endMonth` <= `startMonth` means the year wraps into
 *  the next calendar year. At most one row is `isCurrent` (the router clears the flag on the
 *  others). Archived, never hard-deleted — generated invoice periods derive from it. */
export const schoolYears = sqliteTable(
  'school_years',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    startMonth: integer('start_month').notNull(),
    endMonth: integer('end_month').notNull(),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ currentIdx: index('school_years_current_idx').on(t.isCurrent) }),
);
export type SchoolYear = typeof schoolYears.$inferSelect;

/** An optional term/semester inside a school year — only used by madāris that bill per term
 *  (`fee_plans.cadence = 'per_term'`). With NO terms configured, per-term plans generate
 *  nothing, which is the correct no-op for a monthly-only madrasah (billing/invoices.ts). */
export const terms = sqliteTable(
  'terms',
  {
    id: text('id').primaryKey(),
    schoolYearId: text('school_year_id')
      .notNull()
      .references(() => schoolYears.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    startDate: text('start_date'), // ISO date (YYYY-MM-DD)
    endDate: text('end_date'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ yearIdx: index('terms_year_idx').on(t.schoolYearId), nameUq: unique('terms_year_name_uq').on(t.schoolYearId, t.name) }),
);
export type Term = typeof terms.$inferSelect;

/** A course / programme (e.g. Hifz, Nazrah, ʿĀlim). Purely an ORGANISATIONAL grouping for the
 *  student directory, the year view, and mass fee/charge apply — explicitly NOT academics:
 *  no teachers, attendance, grades, or capacity live here. That scope was removed at v0.35.0
 *  and stays out (CLAUDE.md §4 ❌). */
export const courses = sqliteTable(
  'courses',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ nameUq: unique('courses_name_uq').on(t.name) }),
);
export type Course = typeof courses.$inferSelect;

/** A class within a course (e.g. "Hifz 1"). A student belongs to at most one class, held as a
 *  single `students.class_id` — grouping only, so there is no per-year class history. */
export const classes = sqliteTable(
  'classes',
  {
    id: text('id').primaryKey(),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ courseIdx: index('classes_course_idx').on(t.courseId), nameUq: unique('classes_course_name_uq').on(t.courseId, t.name) }),
);
export type Class = typeof classes.$inferSelect;

// ── People (families, students, guardians) ───────────────────────────────────

/** A family groups students and links to guardians. Archived, never hard-deleted
 *  (money references it). `name` is the display label (e.g. "Ismail family").
 *  An optional per-family discount applies to generated invoices (§4): `none`, a `fixed`
 *  amount in cents, or a `percent` in basis points (e.g. 1000 = 10%). */
export const families = sqliteTable('families', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  notes: text('notes'),
  status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
  discountKind: text('discount_kind').$type<'none' | 'fixed' | 'percent'>().notNull().default('none'),
  discountValue: integer('discount_value').notNull().default(0), // cents (fixed) or basis points (percent)
  /** Stripe Customer id — created on the family's first saved card / portal payment (§13.1). */
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type Family = typeof families.$inferSelect;

/** A student. The PIN is a low-entropy capability token (6-digit CSPRNG, UNIQUE per
 *  install) used for name+PIN lookup at the Donations site / Kiosk and one door into
 *  portal self-registration — it is RETRIEVABLE (printed on statements), so it is stored
 *  in the clear and the DB file itself is a secret (§9/§14). Never logged / never in URLs.
 *  Withdrawn via `status`, never hard-deleted. FK to family is RESTRICT (archive, don't
 *  delete, a family with students). */
export const students = sqliteTable(
  'students',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'restrict' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: text('dob'), // optional ISO date (YYYY-MM-DD); minimal by design (§14)
    status: text('status').$type<'active' | 'withdrawn'>().notNull().default('active'),
    notes: text('notes'),
    /** Current class — grouping only (see `classes`). Nullable: a student can be unplaced. */
    classId: text('class_id').references(() => classes.id, { onDelete: 'restrict' }),
    pin: text('pin').notNull(),
    pinUpdatedAt: integer('pin_updated_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pinUq: unique('students_pin_uq').on(t.pin), // the unique lookup index (§11.2)
    familyIdx: index('students_family_idx').on(t.familyId),
    classIdx: index('students_class_idx').on(t.classId),
  }),
);
export type Student = typeof students.$inferSelect;

/** A guardian (name + contact). May span multiple families via guardian_families. */
export const guardians = sqliteTable('guardians', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type Guardian = typeof guardians.$inferSelect;

/** guardian ↔ family link (many-to-many). `relation` is free text (father/mother/walī…).
 *  `isEmergencyContact` flags this guardian as an emergency contact for the family (§4). */
export const guardianFamilies = sqliteTable(
  'guardian_families',
  {
    guardianId: text('guardian_id')
      .notNull()
      .references(() => guardians.id, { onDelete: 'cascade' }),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    relation: text('relation'),
    isEmergencyContact: integer('is_emergency_contact', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.guardianId, t.familyId] }) }),
);
export type GuardianFamily = typeof guardianFamilies.$inferSelect;

/** Links a guardian to a parent USER account — this is what gives a parent portal login
 *  its family scope (§9/§12). Populated when a parent accepts an invite / self-registers. */
export const guardianUsers = sqliteTable(
  'guardian_users',
  {
    guardianId: text('guardian_id')
      .notNull()
      .references(() => guardians.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.guardianId, t.userId] }), userUq: unique('guardian_users_user_uq').on(t.userId) }),
);
export type GuardianUser = typeof guardianUsers.$inferSelect;

/** One-time parent-portal invite (CLAUDE.md §12). finance/admin creates one for a guardian; the
 *  invite LINK carries an opaque CSPRNG token and we store only its SHA-256 (like sessions), so a
 *  leaked row can't be replayed. Single-use (`usedAt`) and time-limited (`expiresAt`, 7 days).
 *  Accepting it creates the parent `users` row + the `guardian_users` link. */
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  guardianId: text('guardian_id')
    .notNull()
    .references(() => guardians.id, { onDelete: 'cascade' }),
  // Who created the invite — plain actor field (no FK), like audit_log: survives user changes
  // and SSO admins (who have no local user row).
  createdByUserId: text('created_by_user_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
});
export type Invite = typeof invites.$inferSelect;

/** Password-reset tokens (CLAUDE.md §12) — like invites but for an EXISTING user. Only the SHA-256
 *  hash of the CSPRNG token is stored; single-use, short expiry. Reset is offered when SMTP is on
 *  (email a link); otherwise the office re-invites / an admin sets a temp password. */
export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
});
export type PasswordReset = typeof passwordResets.$inferSelect;

/** Extra emergency contacts per family (guardians can also be flagged, above). */
export const emergencyContacts = sqliteTable(
  'emergency_contacts',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone'),
    relation: text('relation'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ familyIdx: index('emergency_contacts_family_idx').on(t.familyId) }),
);
export type EmergencyContact = typeof emergencyContacts.$inferSelect;

/** Append-only audit trail for sensitive writes (§14). Actor is stored as plain fields
 *  (not an FK) so history survives user changes; SSO admins have no user row (id null). */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id'),
    actorRole: text('actor_role'),
    actorName: text('actor_name'),
    action: text('action').notNull(), // e.g. 'student.pin.regenerate', 'family.create'
    entity: text('entity'), // e.g. 'student'
    entityId: text('entity_id'),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(), // small before/after; NEVER PINs/secrets
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ entityIdx: index('audit_entity_idx').on(t.entity, t.entityId), atIdx: index('audit_at_idx').on(t.createdAt) }),
);
export type AuditEntry = typeof auditLog.$inferSelect;

// ── Billing (fee plans, invoices, ledger, payments) ──────────────────────────

export type FeeCadence = 'monthly' | 'per_term' | 'one_time';
export type InvoiceStatus = 'open' | 'partially_paid' | 'paid' | 'void';
export type PaymentChannel = 'donations-web' | 'kiosk' | 'portal' | 'autopay' | 'cash' | 'zelle' | 'check' | 'other';

/** A reusable fee plan — an amount (integer cents) + cadence — assigned per student (§4). */
export const feePlans = sqliteTable('fee_plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  amountCents: integer('amount_cents').notNull(),
  cadence: text('cadence').$type<FeeCadence>().notNull(),
  status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type FeePlan = typeof feePlans.$inferSelect;

/** A fee plan assigned to one STUDENT. Invoice generation gathers a family's active students'
 *  fees (one line per student × plan) and rolls them into a per-family invoice. FK RESTRICT on
 *  the money path (§9). A student can carry more than one plan; UNIQUE(student, plan).
 *
 *  `overrideAmountCents` lets an admin charge THIS student a different amount without minting a
 *  whole new plan — the effective amount is `overrideAmountCents ?? feePlans.amountCents`.
 *  `note` is a short annotation shown beside the amount in the year view (e.g. "ACH").
 *  `updatedAt` is nullable because the column was added after rows existed (SQLite cannot add a
 *  NOT NULL column without a default); it is set on every write from here on. */
export const studentFees = sqliteTable(
  'student_fees',
  {
    id: text('id').primaryKey(),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    feePlanId: text('fee_plan_id')
      .notNull()
      .references(() => feePlans.id, { onDelete: 'restrict' }),
    /** Per-student amount override in cents; null = use the plan's amount. */
    overrideAmountCents: integer('override_amount_cents'),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({ uq: unique('student_fees_uq').on(t.studentId, t.feePlanId), studentIdx: index('student_fees_student_idx').on(t.studentId) }),
);
export type StudentFee = typeof studentFees.$inferSelect;

/** A family invoice for a period. Total = sum of items; balance + status are DERIVED from
 *  allocations, never stored (§9). `periodKey` (e.g. "2026-07") dedupes generation. */
export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    periodKey: text('period_key').notNull(),
    dueDate: text('due_date'), // ISO date
    status: text('status').$type<InvoiceStatus>().notNull().default('open'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ familyIdx: index('invoices_family_idx').on(t.familyId), periodUq: unique('invoices_family_period_uq').on(t.familyId, t.periodKey) }),
);
export type Invoice = typeof invoices.$inferSelect;

/** A line on an invoice (integer cents). A discount is a negative-amount line. */
export const invoiceItems = sqliteTable(
  'invoice_items',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    studentId: text('student_id').references(() => students.id, { onDelete: 'restrict' }),
    /** The fee plan this line came from, when it came from one. Lets `per_term`/`one_time`
     *  cadences dedupe EXACTLY (has this student already been billed for this plan?) instead
     *  of matching on the description text. Null for discounts and for charge lines. */
    feePlanId: text('fee_plan_id').references(() => feePlans.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ invoiceIdx: index('invoice_items_invoice_idx').on(t.invoiceId), planIdx: index('invoice_items_plan_idx').on(t.feePlanId) }),
);
export type InvoiceItem = typeof invoiceItems.$inferSelect;

// ── Charges (one-off items: books, uniform, registration, late fees, credits) ─

/** A preconfigured chargeable item with a default price (the Items tab). Applying one COPIES
 *  its name + price onto the charge, so renaming or repricing an item never rewrites a charge
 *  already applied (§9's frozen-fact rule). Deliberately has NO cadence — anything that
 *  recurs is a fee plan, not a charge item. */
export const chargeItems = sqliteTable(
  'charge_items',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    defaultAmountCents: integer('default_amount_cents').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ nameUq: unique('charge_items_name_uq').on(t.name) }),
);
export type ChargeItem = typeof chargeItems.$inferSelect;

export type ChargeStatus = 'pending' | 'invoiced' | 'void';

/** A one-off charge on a student for a period — a book, a late fee, or a NEGATIVE amount as a
 *  credit/adjustment. `label` and `amountCents` are SNAPSHOTS taken when the charge is applied;
 *  `chargeItemId` survives only as provenance (null = a custom one-off).
 *
 *  Lifecycle: `pending` → picked up by invoice generation for `periodKey` (or appended straight
 *  onto that period's already-open invoice) → `invoiced`, with `invoiceItemId` set. A `pending`
 *  charge can be voided; once `invoiced` the invoice line is IMMUTABLE, so the correction is a
 *  second, negative charge (§9: no update/delete path on invoice_items). */
export const charges = sqliteTable(
  'charges',
  {
    id: text('id').primaryKey(),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    chargeItemId: text('charge_item_id').references(() => chargeItems.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    amountCents: integer('amount_cents').notNull(), // may be NEGATIVE (a credit/adjustment)
    note: text('note'),
    /** Billing period to land in (e.g. "2026-07"); null = the next period generated. */
    periodKey: text('period_key'),
    status: text('status').$type<ChargeStatus>().notNull().default('pending'),
    invoiceItemId: text('invoice_item_id').references(() => invoiceItems.id, { onDelete: 'restrict' }),
    createdByUserId: text('created_by_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    studentStatusIdx: index('charges_student_status_idx').on(t.studentId, t.status),
    periodIdx: index('charges_period_idx').on(t.periodKey),
  }),
);
export type Charge = typeof charges.$inferSelect;

/** A payment against a family's balance — IMMUTABLE (corrections are reversal rows with a
 *  negative amount and `reversalOf` set). `idempotencyKey` is UNIQUE per install so a replay
 *  (any channel — cash, portal, autopay, donations, kiosk) returns the original (§9). */
export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(), // negative for a reversal
    channel: text('channel').$type<PaymentChannel>().notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    memo: text('memo'),
    idempotencyKey: text('idempotency_key').notNull(),
    externalRef: text('external_ref', { mode: 'json' }).$type<Record<string, unknown>>(), // Stripe ids etc.
    reversalOf: text('reversal_of'), // the payment id this reverses
    recordedByUserId: text('recorded_by_user_id'),
    recordedByName: text('recorded_by_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ familyIdx: index('payments_family_idx').on(t.familyId), idemUq: unique('payments_idempotency_uq').on(t.idempotencyKey) }),
);
export type Payment = typeof payments.$inferSelect;

/** How much of a payment covered which invoice (oldest-due-first by the ledger). A reversal
 *  writes negative allocations mirroring the original, so per-invoice paid nets out. */
export const paymentAllocations = sqliteTable(
  'payment_allocations',
  {
    id: text('id').primaryKey(),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ paymentIdx: index('payment_allocations_payment_idx').on(t.paymentId), invoiceIdx: index('payment_allocations_invoice_idx').on(t.invoiceId) }),
);
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;

// ── Payments: Stripe (webhook dedupe, saved cards, autopay) ──────────────────

/** Processed Stripe webhook events (CLAUDE.md §9, §13.4). `eventId` is UNIQUE, so a replayed
 *  webhook is a no-op — the ledger stays idempotent even if Stripe re-delivers an event. */
export const stripeEvents = sqliteTable('stripe_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
export type StripeEvent = typeof stripeEvents.$inferSelect;

/** Saved cards — Stripe PaymentMethod REFERENCES only (CLAUDE.md §9, §13.3): id/brand/last4/exp,
 *  NEVER a PAN. Off-session-capable, tied to the family's Stripe Customer. */
export const paymentMethods = sqliteTable(
  'payment_methods',
  {
    id: text('id').primaryKey(), // the Stripe PaymentMethod id (pm_…)
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    brand: text('brand'),
    last4: text('last4'),
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ famIdx: index('payment_methods_family_idx').on(t.familyId) }),
);
export type PaymentMethod = typeof paymentMethods.$inferSelect;

/** Per-family autopay (CLAUDE.md §13.3): our scheduler charges the default card when invoices come
 *  due — NOT Stripe Billing. `failureCount` + `nextAttemptAt` drive the retry ladder; consent is
 *  timestamped. One row per family. */
export const autopayEnrollments = sqliteTable('autopay_enrollments', {
  familyId: text('family_id')
    .primaryKey()
    .references(() => families.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  defaultPmId: text('default_pm_id'),
  consentAt: integer('consent_at', { mode: 'timestamp_ms' }),
  failureCount: integer('failure_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'), // ISO date; when set, the scheduler waits until this day
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type AutopayEnrollment = typeof autopayEnrollments.$inferSelect;

/** One autopay attempt for a family on a date (CLAUDE.md §9, §13.3). UNIQUE(family, run_date) is the
 *  scheduler's own idempotency; the Stripe idempotency key for the PI is derived from `id`. */
export const autopayRuns = sqliteTable(
  'autopay_runs',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    runDate: text('run_date').notNull(), // ISO date
    amountCents: integer('amount_cents').notNull(),
    status: text('status').$type<'pending' | 'charged' | 'failed'>().notNull().default('pending'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ famDateUq: unique('autopay_runs_family_date_uq').on(t.familyId, t.runDate), piIdx: index('autopay_runs_pi_idx').on(t.stripePaymentIntentId) }),
);
export type AutopayRun = typeof autopayRuns.$inferSelect;
