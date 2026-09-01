// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Drizzle schema (SQLite). This app is tuition/fee management for a masjid: families and
 * students (each with a generated Student ID), fee plans assigned PER STUDENT, family
 * invoices, a derived ledger, manual + Stripe payments, saved cards and autopay — plus the
 * `students/billing` Fabric provider that powers the tuition option on OpenMasjidDonations
 * and OpenMasjidKiosk. No SIS/academics (classes, grades, attendance, exams, report cards).
 *
 * Rules: money in integer cents; balances DERIVED, never stored; payments IMMUTABLE
 * (corrections are reversal rows); FKs RESTRICT on money paths; every table has
 * id/created_at/updated_at. The file holds minors' PII and every payment record, so it is
 * itself a secret and backups of it must be treated as one (CLAUDE.md §9, §14). Migrations
 * are forward-only and generated into ./drizzle.
 */
import { sqliteTable, text, integer, primaryKey, index, unique } from 'drizzle-orm/sqlite-core';

/** The roles (CLAUDE.md §5). Admin (LAN-only) manages everything; finance runs billing;
 *  parents get the portal. (Teacher/student roles were removed with the SIS.) */
export type Role = 'admin' | 'finance' | 'parent';

/** App-owned settings (the school profile, the Stripe account, notification policies, etc. — added
 *  over time). There is deliberately NO mail configuration here: the platform owns the provider and
 *  this app holds no mail credentials (§7). This is NOT a masjid profile; each app owns its own
 *  config (org rule). */
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
  /**
   * A staff member's WhatsApp number (0.50.0).
   *
   * This column was deliberately ABSENT until now, and the comment here said so: "the app never
   * contacts staff by phone, so holding one would be personal data collected for no purpose". That
   * reasoning was right and it is what changed — the app now CAN reach a person on WhatsApp, and the
   * whole point of a staff alert is that it finds the treasurer while they are away from an inbox. A
   * number with a purpose is minimization satisfied, not broken (§14); a number without one is what
   * the old rule forbade, and still is. Optional, always — an account with no number simply never
   * gets a message.
   */
  phone: text('phone'),
  /** Which country this staff number belongs to (`+1`, `+44`…), when it isn't the install's default.
   *  See whatsapp/numbers.ts — a number is useless to the gateway until it is E.164. */
  phoneCountry: text('phone_country'),
  /** Which staff alerts this person gets on WhatsApp — ids from `ALERT_EVENTS` (alerts/index.ts).
   *  Null/empty = none, which is the default for every existing and every new account. */
  waEvents: text('wa_events', { mode: 'json' }).$type<string[]>(),
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

// ── Schools (0.47.0) ─────────────────────────────────────────────────────────

/**
 * A school within the masjid — a maktab that runs Sep→Jun beside a hifz program that runs
 * year-round, each with its own calendar and its own classes.
 *
 * ONE INSTALL IS STILL ONE MASJID (CLAUDE.md §4 ❌ multi-tenant). This is not tenancy: schools share
 * every setting, every staff account, every fee plan, the Stripe account, the alert list, and — the
 * load-bearing part — THE HOUSEHOLD. A family with a child in the maktab and another in hifz is one
 * family with one balance, one portal login and one printed sheet. What a school scopes is deliberately
 * narrow: the school YEAR (so a term can start in a different month) and the COURSE tree beneath it
 * (so "Level 1" can mean two different rooms). Nothing about money is scoped, because a parent pays
 * the masjid once.
 *
 * Archived rather than deleted: a school owns years and courses, and those in turn label students.
 */
export const schools = sqliteTable(
  'schools',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ nameUq: unique('schools_name_uq').on(t.name) }),
);
export type School = typeof schools.$inferSelect;

/**
 * Which schools a staff account is limited to. NO ROWS MEANS ALL SCHOOLS, and that default is the
 * point: a masjid with one school must never have to think about this table, and adding a second
 * school must not silently narrow what existing staff can see.
 *
 * So this is an opt-in restriction, not a grant — `visibleSchoolIds()` (schools/index.ts) returns
 * every active school for an unrestricted account. It cannot widen a role either: a finance user
 * restricted to one school still sees only what finance sees, and an admin is still LAN-only (§12.4).
 */
export const userSchools = sqliteTable(
  'user_schools',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    schoolId: text('school_id')
      .notNull()
      .references(() => schools.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.schoolId] }), schoolIdx: index('user_schools_school_idx').on(t.schoolId) }),
);
export type UserSchool = typeof userSchools.$inferSelect;

// ── Structure (school year, terms, courses, classes) ─────────────────────────

/** A school year — the billing calendar (e.g. "1447–1448 / 2026–2027" running Apr→Mar).
 *  `startMonth`/`endMonth` are 1-12 and `startYear` is the calendar year the FIRST month falls in;
 *  when `endMonth` < `startMonth` the year wraps into `startYear + 1`. Together these produce the
 *  concrete billing periods the year view is built from (billing/schoolYear.ts).
 *  `startYear` is nullable only because the column was added after `school_years` shipped in
 *  0022; it is required on create from 0.37.0 on, and the year view asks for it when absent.
 *  At most one row is `isCurrent` PER SCHOOL from 0.47.0 (the router clears the flag on that
 *  school's other years) — two schools on different calendars each need a current year. Archived,
 *  never hard-deleted — generated invoice periods derive from it. */
export const schoolYears = sqliteTable(
  'school_years',
  {
    id: text('id').primaryKey(),
    /** Which school's calendar this is (0.47.0). Nullable only because the column was added to a
     *  populated table; `ensureDefaultSchool()` backfills every row at boot and every writer sets it. */
    schoolId: text('school_id').references(() => schools.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    startYear: integer('start_year'),
    startMonth: integer('start_month').notNull(),
    endMonth: integer('end_month').notNull(),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ currentIdx: index('school_years_current_idx').on(t.isCurrent), schoolIdx: index('school_years_school_idx').on(t.schoolId) }),
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

/** A course / program (e.g. Hifz, Nazrah, ʿĀlim). Purely an ORGANIZATIONAL grouping for the
 *  student directory, the year view, and mass fee/charge apply — explicitly NOT academics:
 *  no teachers, attendance, grades, or capacity live here. That scope was removed at v0.35.0
 *  and stays out (CLAUDE.md §4 ❌). */
export const courses = sqliteTable(
  'courses',
  {
    id: text('id').primaryKey(),
    /** Which school this course belongs to (0.47.0). Nullable for the same reason as
     *  `school_years.school_id` — added to a populated table, backfilled at boot.
     *
     *  Uniqueness moved WITH it: "Level 1" is a perfectly ordinary name for a course in the maktab
     *  and another in the hifz program, so the unique index is now (school_id, name). */
    schoolId: text('school_id').references(() => schools.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ nameUq: unique('courses_school_name_uq').on(t.schoolId, t.name), schoolIdx: index('courses_school_idx').on(t.schoolId) }),
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
 *
 *  It carries no money of its own: since 0.39.0 invoices and payments are PER STUDENT, and the
 *  family-level discount was dropped in favor of the per-student fee override that already
 *  existed (`student_fees.override_amount_cents`). What remains here is grouping — siblings, and
 *  the guardians they share — plus the Stripe Customer, which belongs to the family because it is
 *  one adult's card paying for all their children. */
export const families = sqliteTable('families', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  notes: text('notes'),
  status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
  /** Stripe Customer id — created on the family's first saved card / portal payment (§13.1). */
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type Family = typeof families.$inferSelect;

/** A student. `studentCode` (below) is how a parent identifies this child when paying at the
 *  Donations site / Kiosk and is one half of the portal self-registration door. Withdrawn via
 *  `status` rather than hard-deleted in the normal case (see trpc/people.ts `studentDelete` for
 *  the narrow exception). FK to family is RESTRICT (archive, don't delete, a family with
 *  students). */
export const students = sqliteTable(
  'students',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'restrict' }),
    /**
     * The child's name as the office writes it — ONE field, not a first/last pair.
     *
     * Madrasa families do not reliably split into two western halves: a nasab ("Yusuf ibn
     * Ibrahim"), a compound given name, a mononym, or a name written in Arabic script all had to
     * be mangled to fit two boxes. Storing what was actually typed means the statement, the
     * kiosk confirmation and the register all read the way the family reads it.
     *
     * Two derived things still need parts of it, and both take them at the point of use rather
     * than storing a split (see people/names.ts): the Student ID prefix uses the FIRST word, and
     * the household label uses the LAST. Deriving keeps one field authoritative.
     */
    fullName: text('full_name').notNull(),
    dob: text('dob'), // optional ISO date (YYYY-MM-DD); minimal by design (§14)
    status: text('status').$type<'active' | 'withdrawn'>().notNull().default('active'),
    notes: text('notes'),
    /**
     * Which school this child attends (0.47.0). Their SIBLING may attend another one — the household
     * is deliberately not scoped (see `schools`), which is what keeps one family on one sheet with one
     * balance.
     *
     * Nullable only because the column was added to a populated table; `ensureDefaultSchool()`
     * backfills it at boot and every writer sets it. It is kept consistent with `classId`: placing a
     * child in a class moves them to that class's school, because a child cannot be in a maktab class
     * while filed under the hifz program.
     */
    schoolId: text('school_id').references(() => schools.id, { onDelete: 'restrict' }),
    /** Current class — grouping only (see `classes`). Nullable: a student can be unplaced. */
    classId: text('class_id').references(() => classes.id, { onDelete: 'restrict' }),
    /**
     * The human-readable student ID a parent types at the kiosk or on the donation site — first three
     * letters of the first name + 4 digits, e.g. `YUS1234` (billing/studentCodes.ts).
     *
     * This is the ONLY identifier in the payment flow; there is no PIN (removed in 0.39.0). It is not
     * a secret and is not treated as one — it is printed on statements and guessable by anyone who
     * knows a child's first name. What it authorizes is deliberately narrow: seeing a balance and
     * *paying* it. The threat model says so explicitly — the worst a stranger can do with someone
     * else's ID is settle their tuition — so the compensating controls are a per-code lockout
     * (security/rateLimit.ts) and an on-screen name confirmation, not a shared secret (§11.2, §14).
     *
     * Nullable only because the column was added after `students` shipped; every student created
     * from 0.38.0 on gets one, and `backfillStudentCodes()` fills the rest at boot.
     */
    studentCode: text('student_code'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    // UNIQUE, so a collision is a database error rather than two children sharing a payment code.
    // SQLite allows many NULLs in a UNIQUE column, which is what lets the backfill run gradually.
    codeUq: unique('students_code_uq').on(t.studentCode),
    familyIdx: index('students_family_idx').on(t.familyId),
    classIdx: index('students_class_idx').on(t.classId),
    schoolIdx: index('students_school_idx').on(t.schoolId),
  }),
);
export type Student = typeof students.$inferSelect;

/** A guardian (name + contact). May span multiple families via guardian_families. */
export const guardians = sqliteTable('guardians', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  /**
   * Which country this number belongs to — `+1`, `+44`, `+92` (0.50.0). Null = the install's default.
   *
   * Per guardian rather than per install alone because a madrasa's families are not all in one country:
   * a grandparent abroad, a father working overseas, a household that moved. The stored `phone` is
   * whatever the office typed and is not touched by this — see whatsapp/numbers.ts, which is the one
   * place that combines the two into the E.164 form the gateway needs.
   */
  phoneCountry: text('phone_country'),
  /**
   * This person asked not to be messaged on WhatsApp (0.50.0), from the parent portal.
   *
   * On the GUARDIAN, not the household and not the user account: it is a decision about a phone, and
   * the phone belongs to a person. A mother who opts out does not opt her husband out, and the choice
   * survives them losing and re-making a portal login. Nothing overrides it — not the pause, not the
   * test student, not an office broadcast (whatsapp/index.ts).
   */
  waOptOut: integer('wa_opt_out', { mode: 'boolean' }).notNull().default(false),
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
 *  hash of the CSPRNG token is stored; single-use, short expiry. A link is emailed when the platform can
 *  send mail; otherwise the office reads the link out or an admin sets a temporary password. */
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
    action: text('action').notNull(), // e.g. 'payment.record', 'student.create'
    entity: text('entity'), // e.g. 'student'
    entityId: text('entity_id'),
    detail: text('detail', { mode: 'json' }).$type<Record<string, unknown>>(), // small before/after; NEVER secrets or full PII
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ entityIdx: index('audit_entity_idx').on(t.entity, t.entityId), atIdx: index('audit_at_idx').on(t.createdAt) }),
);
export type AuditEntry = typeof auditLog.$inferSelect;

/**
 * Who the office wants emailed when something happens (0.44.0).
 *
 * A row is an ADDRESS, not an account: the person who should hear that autopay switched itself off is
 * often not the person who logs in — the imām, the treasurer, a trustee who never opens the app. So
 * this is deliberately not a column on `users`, and adding a recipient grants no access to anything.
 *
 * `events` is the list of alert ids that address gets (see alerts/index.ts, which owns the catalog
 * and validates against it on every write). Storing it as JSON rather than a join table is the right
 * trade here: it is a handful of rows read whole, always written whole, and never queried BY event.
 *
 * The email is UNIQUE and stored lowercased so "Office@…" and "office@…" cannot both subscribe and
 * double every message.
 */
/**
 * What the office told the mid-year wizard about one child (0.48.0).
 *
 * The wizard asks a single question per child — "paid through which month?" — derives a carried-forward
 * bill or a dated prepayment from it, and used to discard the answer. That left the year view able to
 * say the months before go-live were never billed here, but not WHICH of them a family had settled and
 * which they were behind on. That distinction is the thing an office actually wants from the screen.
 *
 * A RECORD OF AN ANSWER, not a setting and not a balance. Nothing reads it to decide what to bill — the
 * money is entirely in the carry-in invoice and the carry-in payment, exactly as §9 requires ("a
 * mid-year start is a ledger artifact, never a setting"). It is written once, beside the artifact, so it
 * cannot drift from it; `paidThrough` is null when the office told us nothing, which is different from
 * being told "square" and must stay different (the year view says "we don't know" rather than "paid").
 *
 * ON DELETE CASCADE, unlike every money path: this is a note about a child, so it goes when they do.
 */
export const carryIns = sqliteTable('carry_ins', {
  studentId: text('student_id')
    .primaryKey()
    .references(() => students.id, { onDelete: 'cascade' }),
  /** The go-live month this answer was given for. */
  goLivePeriod: text('go_live_period').notNull(),
  /** The last month already settled when the app came in. Null = nothing was said. */
  paidThrough: text('paid_through'),
  kind: text('kind', { enum: ['owes', 'ahead', 'square'] }).notNull(),
  /** The figure that was written (0 for a child who was square). */
  amountCents: integer('amount_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
export type CarryIn = typeof carryIns.$inferSelect;

/**
 * When a household was last reminded that its balance is past due (0.48.0).
 *
 * The ONLY state the past-due reminder needs, and it exists for one reason: a daily job that emails
 * every overdue family every day is not a reminder, it is harassment — and it is how a madrasah's mail
 * ends up in spam folders, taking the invites and receipts with it. One row per household says when it
 * was last written to, so the cadence the office chose ("at most once a week") is honest.
 *
 * NOT a balance and not a debt record. Nothing bills from this; the money is entirely in the invoices
 * and the payments, as always (§9). Deleting every row would only mean the next run reminds everybody
 * once. ON DELETE CASCADE for the same reason `carry_ins` uses it: it is a note about a household, and
 * it has nothing to say once the household is gone.
 */
export const pastDueReminders = sqliteTable('past_due_reminders', {
  familyId: text('family_id')
    .primaryKey()
    .references(() => families.id, { onDelete: 'cascade' }),
  /** ISO date of the last reminder actually SENT — not attempted. A run that reached nobody (no address
   *  on file, mail down, parents paused) must not start a quiet cooldown on a family nobody wrote to. */
  lastSentOn: text('last_sent_on').notNull(),
  /** What they were overdue for at the time, for the office to see how it has moved. */
  amountCents: integer('amount_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type PastDueReminder = typeof pastDueReminders.$inferSelect;

export const alertRecipients = sqliteTable('alert_recipients', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  /** What to call them on screen ("Office", "Ustādh Bilāl"). Optional — the address is the identity. */
  label: text('label'),
  events: text('events', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type AlertRecipient = typeof alertRecipients.$inferSelect;

/**
 * What we handed to the OpenMasjidOS WhatsApp queue, and what we deliberately didn't (0.50.0).
 *
 * THE BODY IS NEVER STORED. That is the platform's rule and it is the right one: a tuition message
 * routinely carries a child's name and a family's fees, and a log is the copy of it that outlives the
 * conversation. What is here is the shape of an audit trail — which event, to whom, when, and what
 * happened — which answers the questions an office actually asks ("did Fatima get the reminder?",
 * "why didn't the Ahmeds?") without keeping a second copy of the message itself.
 *
 * `status` is the honest part. `queued` means the platform ACCEPTED it, never that WhatsApp delivered
 * it: the queue paces sends by minutes and holds them through quiet hours, and no delivery receipt
 * ever comes back to us. `skipped` is the row that stops a support call — an opted-out parent, a
 * number we could not read, a household held back by the pause — and it is written only where a send
 * was individually intended or individually possible, never once per family for a switch that is off.
 *
 * Recipients are stored as an id + a kind rather than a name or a number, so the log adds no personal
 * data that is not already on the guardian or staff row it points at. Pruned on a schedule.
 */
export const whatsappLog = sqliteTable(
  'whatsapp_log',
  {
    id: text('id').primaryKey(),
    /** Our own event id — a parent event (`receipt`…) or a staff alert id. See whatsapp/index.ts. */
    event: text('event').notNull(),
    /** `group` (0.50.0) is an ANNOUNCEMENT to an admin-approved WhatsApp group, never a family's own
     *  business — see whatsapp/index.ts for why the two paths are kept apart in the type system. */
    recipientKind: text('recipient_kind').$type<'guardian' | 'staff' | 'group'>().notNull(),
    /** `guardians.id`, `users.id`, or the opaque group id. Not an FK: the log outlives the row, like
     *  `audit_log`'s actor — and a group id belongs to the platform, not to us at all. */
    recipientId: text('recipient_id').notNull(),
    /** The household this was about, when it was about one. */
    familyId: text('family_id'),
    /**
     * What became of it (widened in 0.51.0).
     *
     * `queued` used to be the last word this app could ever say, because a 202 was the end of the
     * platform's story. OpenMasjidOS 0.51.1 reports outcomes, so `sent` and `expired` are now real
     * states the scheduler fills in — `expired` being the platform dropping a message it held for
     * more than 24 hours, which an office needs to SEE rather than infer from silence.
     *
     * On an older platform every row stays `queued` for good, which is honest: we still do not know.
     *
     * `unknown` IS NOT `failed`, and separating the two is the point of it (0.51.0-dev.9). Two things
     * produce it, and neither is a delivery failure:
     *
     *   • a 404 from `status/<id>` — an evicted record, an id that was never ours, or a platform too old
     *     to have the route. This was written as `failed`/`outcome_unknown`, which put the word "Failed"
     *     on the office's screen next to messages that had very likely arrived. The doc comment on the
     *     poller already said `unknown`; the code said `failed`. The comment was right.
     *   • a suspect window from `GET /api/fabric/whatsapp/suspect` — the masjid's WhatsApp link had
     *     silently expired, so the platform reported `sent` for messages the gateway never delivered.
     *     Those rows genuinely were reported sent, and are genuinely not known to have arrived.
     *
     * Plain text with no CHECK constraint, like `PaymentChannel`, so widening it needs no migration and
     * rows written before this are untouched.
     */
    status: text('status').$type<'queued' | 'sent' | 'failed' | 'expired' | 'skipped' | 'unknown'>().notNull(),
    /** Why, for the statuses that need one: `opted_out`, `no_number`, `paused`, `http_429`… */
    reason: text('reason'),
    /** The platform's own message id — the handle for asking what happened (0.51.0). Null on a
     *  `skipped` row, which never reached the platform, and on everything written before this. */
    platformId: text('platform_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ atIdx: index('whatsapp_log_at_idx').on(t.createdAt), recipientIdx: index('whatsapp_log_recipient_idx').on(t.recipientKind, t.recipientId) }),
);
export type WhatsappLogEntry = typeof whatsappLog.$inferSelect;

// ── Billing (fee plans, invoices, ledger, payments) ──────────────────────────

export type FeeCadence = 'monthly' | 'per_term' | 'one_time';
export type InvoiceStatus = 'open' | 'partially_paid' | 'paid' | 'void';
/** How the money arrived. The first four are card/external and are set by the code that records
 *  them; the rest are what the office picks when marking an offline payment as received.
 *
 *  `ach` is a bank transfer the masjid received directly (a parent's online bill-pay, a wire) — it
 *  is NOT the Stripe ACH debit that §4 defers, and nothing charges it. Stored as plain text with no
 *  CHECK constraint, so adding a value needs no migration; existing rows are unaffected.
 *
 *  `carry_in` is money that reached the school BEFORE it ran this app — recorded once when a madrasa
 *  goes live mid-year (0.43.0). It is its own channel rather than `other` so a statement, an export
 *  and the office can all tell "we were told this was paid" apart from "we took this payment". */
export type PaymentChannel = 'donations-web' | 'kiosk' | 'portal' | 'autopay' | 'cash' | 'zelle' | 'check' | 'ach' | 'carry_in' | 'other';

/** The channels the office may record by hand — the card ones are never chosen in the UI, they are
 *  written by the portal, autopay, and the Fabric provider. Shared so the router's zod enum and the
 *  UI's dropdown can never drift apart. */
export const MANUAL_PAYMENT_CHANNELS = ['cash', 'check', 'ach', 'zelle', 'other'] as const;
export type ManualPaymentChannel = (typeof MANUAL_PAYMENT_CHANNELS)[number];

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

/** A STUDENT's invoice for a period (per-student since 0.39.0 — one bill per child, not one per
 *  household). Total = sum of items; balance + status are DERIVED from allocations, never stored
 *  (§9). `periodKey` (e.g. "2026-07") dedupes generation per student. */
export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    periodKey: text('period_key').notNull(),
    dueDate: text('due_date'), // ISO date
    status: text('status').$type<InvoiceStatus>().notNull().default('open'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ studentIdx: index('invoices_student_idx').on(t.studentId), periodUq: unique('invoices_student_period_uq').on(t.studentId, t.periodKey) }),
);
export type Invoice = typeof invoices.$inferSelect;

/** A line on an invoice (integer cents). A credit/adjustment charge is a negative-amount line.
 *
 *  `studentId` is redundant with the invoice's own student now that invoices are per-student, but it
 *  is kept because the one-time-fee dedupe (`alreadyBilled`) reads it directly — and it stays
 *  nullable only because SQLite would need a table rebuild to tighten it. Every writer sets it. */
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

/**
 * A payment against ONE STUDENT's balance — IMMUTABLE (corrections are reversal rows with a negative
 * amount and `reversalOf` set). Per-student since 0.39.0: money recorded for a child sits in *that
 * child's* balance and is absorbed by their own fees and charges as they arrive.
 *
 * One real card charge can cover several children (a parent paying for all their kids at the kiosk or
 * in the portal). That becomes one payment row PER CHILD, all sharing the Stripe PaymentIntent, with
 * `idempotencyKey` suffixed per student (`${key}:${studentId}`) so the UNIQUE index still makes a
 * replay a no-op for each child independently.
 */
export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(), // negative for a reversal
    channel: text('channel').$type<PaymentChannel>().notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    memo: text('memo'),
    idempotencyKey: text('idempotency_key').notNull(),
    externalRef: text('external_ref', { mode: 'json' }).$type<Record<string, unknown>>(), // Stripe ids etc.
    /**
     * The invoice LINES this money was handed over for, when the payer said (0.43.0) — "this $50 is
     * the book fee", chosen at the kiosk, on the donation site or in the portal.
     *
     * Part of the payment record and therefore immutable like the rest of it: allocation is derived
     * and gets recomputed constantly, so without the instruction stored here the next recompute would
     * quietly shunt the money onto the oldest bill and the line the parent paid would still read as
     * outstanding. Null = no instruction, allocate oldest-due-first as always.
     */
    directed: text('directed', { mode: 'json' }).$type<{ itemId: string; amountCents: number }[]>(),
    reversalOf: text('reversal_of'), // the payment id this reverses
    recordedByUserId: text('recorded_by_user_id'),
    recordedByName: text('recorded_by_name'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ studentIdx: index('payments_student_idx').on(t.studentId), idemUq: unique('payments_idempotency_uq').on(t.idempotencyKey) }),
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
    /**
     * WHICH LINE of that invoice the money covered — the tuition or the book fee (0.43.0).
     *
     * Null means "the invoice as a whole", which is every row written before 0.43.0 and is read that
     * way by `billing/lines.ts` (spread over the lines in order). It carries no foreign key on
     * purpose: adding one to a populated table means a full SQLite table rebuild, and this column is
     * a DERIVED mapping that `reallocateStudent` deletes and rewrites wholesale, so a dangling id
     * cannot outlive the next recompute.
     */
    invoiceItemId: text('invoice_item_id'),
    amountCents: integer('amount_cents').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ paymentIdx: index('payment_allocations_payment_idx').on(t.paymentId), invoiceIdx: index('payment_allocations_invoice_idx').on(t.invoiceId) }),
);
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;

// ── Payments: Stripe (saved methods, autopay) ────────────────────────────────
//
// `stripe_events` lived here until 0.48.0. It deduped WEBHOOK deliveries, and there is no webhook
// (§13.4) — nothing had read or written it since that design went, so it was dropped by migration 0037
// rather than left as an invitation to wire the next thing to it.

/** Saved cards — Stripe PaymentMethod REFERENCES only (CLAUDE.md §9, §13.3): id/brand/last4/exp,
 *  NEVER a PAN. Off-session-capable, tied to the family's Stripe Customer. */
export const paymentMethods = sqliteTable(
  'payment_methods',
  {
    id: text('id').primaryKey(), // the Stripe PaymentMethod id (pm_…)
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Stripe's own `PaymentMethod.type` — `card`, `us_bank_account`, `link`, `cashapp`, … (0.48.0).
     *  NULL on a row saved before this column existed whose kind was never captured; the portal
     *  repairs those from Stripe on read. */
    type: text('type'),
    brand: text('brand'),
    last4: text('last4'),
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    /** `card.wallet.type` (`apple_pay`, `google_pay`, …) — a card added through a wallet, where the
     *  network and last four alone would not match what the parent thinks they saved. */
    wallet: text('wallet'),
    /** `us_bank_account` only: the bank's name and `checking`/`savings`. No routing number and no
     *  account-holder name — see migration 0035 for why (§14). */
    bankName: text('bank_name'),
    accountType: text('account_type'),
    /**
     * Which one autopay tries FIRST, and what it falls back to (0.48.0). Position 0 is charged; the retry
     * ladder walks down the list, so a household can say "the joint account, then my card".
     *
     * This is the authority; `isDefault` mirrors position 0 for the readers that already look at it.
     * Every query orders by `(sortOrder, createdAt)` so equal values fall back to oldest-first rather
     * than to whatever SQLite feels like.
     */
    sortOrder: integer('sort_order').notNull().default(0),
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

/**
 * A STANDING ARRANGEMENT to record an offline payment automatically (0.51.0-dev.15).
 *
 * Autopay for money that never touches Stripe: a family who hands over cash or sends a bank transfer
 * every month, where the office was keying the same payment in twelve times a year. On the chosen day the
 * scheduler records it.
 *
 * PER STUDENT, not per family, unlike `autopay_enrollments`. That table is family-scoped because it drives
 * ONE card charge that then fans out; this drives a payment, and a payment belongs to exactly one student
 * (§9). It is also how the office thinks about it — the arrangement is set on a child's billing record.
 *
 * IT ASSERTS THAT MONEY ARRIVED, which is the thing to understand before touching it. Hasan chose that
 * deliberately over a confirm-first queue, and two rules keep it from becoming a fiction:
 *
 *   • **The amount is what is OWED on the day, never a stored figure.** So it can never manufacture
 *     credit, and a family who owes nothing has nothing recorded. See `standingDue`.
 *   • **`payments.idempotency_key` is `standing:<student>:<period>`**, and that column is UNIQUE — so a
 *     re-run, a restarted container or a second scheduler cannot record the same month twice.
 *
 * `recorded_by_name` on the resulting payment is the arrangement, not a person, so the office reading
 * "who took this cash?" can see it was the app (§9's split between `recordedBy` and the audit actor).
 */
export const standingPayments = sqliteTable('standing_payments', {
  studentId: text('student_id')
    .primaryKey()
    .references(() => students.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  /** Which offline channel to record it as. The manual set only — a card is autopay's job (§13.3). */
  channel: text('channel').$type<ManualPaymentChannel>().notNull(),
  /** Day of the month to record on, 1–28. Capped at 28 so every month has one. */
  dayOfMonth: integer('day_of_month').notNull().default(1),
  /** What the office wants on the payment row, e.g. "standing order". */
  memo: text('memo'),
  /** The last period key recorded, so the screen can say when it last ran. The real idempotency is the
   *  UNIQUE payment key, not this — a stored marker alone would let a restart double-record. */
  lastPeriod: text('last_period'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type StandingPayment = typeof standingPayments.$inferSelect;

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
