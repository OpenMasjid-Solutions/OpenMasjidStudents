// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable Student ID list — the office's own copy of every child's ID, grouped by class (0.48.0).
 *
 * WHY IT IS A SERVER-RENDERED DOCUMENT and not a `window.print()` on a screen. The import used to end
 * with a Print button that called `window.print()` inside a floating window, so the browser printed the
 * app: the page behind it, the window chrome, the dock, and a roster of 39 children spread over five
 * sheets of paper. That is not a fixable amount of print CSS — a screen is laid out for a screen. Every
 * other printable in this app is HTML built here and served through one authed route
 * (billing/statementRoutes.ts), and this now is too, which also gets it the masjid's letterhead, its
 * accent color and its contact details for free.
 *
 * IT IS NOT SCOPED TO ONE IMPORT, and that is deliberate. The obvious version — "print the IDs of the
 * 36 children just added" — means putting 36 opaque ids in a URL, and it is the less useful artifact:
 * the sheet an office actually wants is the current roster with everyone's ID on it, which is why this
 * is reachable from Students at any time and not only in the minute after an import.
 *
 * ACTIVE CHILDREN ONLY. A withdrawn child's ID still resolves (their unpaid bill is still owed, §11.2),
 * but this is a lookup sheet for the roster in front of the office, and listing children who left makes
 * the class counts on it wrong.
 *
 * TWO CHILDREN PER ROW, because a masjid pays for its own toner and a 200-child roster is the
 * difference between two sheets and four. Grouping still comes first: a name is looked up by class.
 *
 * SECURITY — a Student ID is the whole credential on the payment path (§14), so a page listing all of
 * them is office paperwork: served only to admin (LAN) and finance through the same gate as the
 * statement, never a public mount, and the sheet says so on its own face. Every value goes through
 * `esc()`; IDs are never logged (this renders them, it does not log them).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { classes, courses, students } from '../db/schema';
import { esc, SHEET_PHONE_CSS } from '../billing/statements';
import { accentWash, getAccentColor, getSchoolContact, getSchoolLogo, getSchoolName } from '../settings';
import { formatDate } from '../settings/dates';
import { listSchools } from '../schools';

/** One child, as this sheet needs them. */
export interface IdSheetChild {
  fullName: string;
  studentCode: string | null;
}

/** One class's children. `label` is "Course — Class", which is how a class is named to a human. */
export interface IdSheetGroup {
  label: string;
  children: IdSheetChild[];
}

export interface IdSheetData {
  groups: IdSheetGroup[];
  total: number;
  /** Children with an ID missing — impossible for anything this app created, so worth counting rather
   *  than silently printing a blank cell. */
  missing: number;
}

/** Children with no class of their own still have to be findable, so they get a group at the end. */
const UNPLACED = 'Not in a class yet';

/**
 * Gather the roster. Split from the rendering so the grouping and the ordering can be tested without
 * parsing HTML — which name lands under which class is the whole substance of this sheet.
 *
 * `schoolIds` is the scope: a specific school, or every school the reader may see. Passing an empty
 * array means no school filter at all.
 */
export function collectIdSheet(schoolIds: string[]): IdSheetData {
  const rows = db
    .select({
      fullName: students.fullName,
      studentCode: students.studentCode,
      classId: students.classId,
    })
    .from(students)
    .where(schoolIds.length ? and(eq(students.status, 'active'), inArray(students.schoolId, schoolIds)) : eq(students.status, 'active'))
    .orderBy(asc(students.fullName))
    .all();

  const classIds = [...new Set(rows.map((r) => r.classId).filter((v): v is string => !!v))];
  /** label, plus the sort key the groups are ordered by. */
  const meta = new Map<string, { label: string; sort: string }>();
  if (classIds.length) {
    for (const c of db
      .select({ id: classes.id, cls: classes.name, clsOrder: classes.sortOrder, course: courses.name, courseOrder: courses.sortOrder })
      .from(classes)
      .leftJoin(courses, eq(courses.id, classes.courseId))
      .where(inArray(classes.id, classIds))
      .all()) {
      // (course order, course name, class order, class name) — EXACTLY the course tree's own ordering
      // (structure.courseTree). Sorting the labels alphabetically instead put "Khaamisa (5th Year)" at
      // the top and "Oola (1st Year)" third, which is not the order anybody arranged their classes in.
      // Numbers padded so 10 sorts after 9 rather than between 1 and 2.
      const pad = (n: number | null) => String(n ?? 0).padStart(6, '0');
      meta.set(c.id, {
        label: c.course ? `${c.course} — ${c.cls}` : c.cls,
        sort: `${pad(c.courseOrder)} ${c.course ?? ''} ${pad(c.clsOrder)} ${c.cls}`,
      });
    }
  }

  const byGroup = new Map<string, IdSheetChild[]>();
  for (const r of rows) {
    const key = r.classId ? meta.get(r.classId)?.label ?? UNPLACED : UNPLACED;
    const list = byGroup.get(key);
    if (list) list.push({ fullName: r.fullName, studentCode: r.studentCode });
    else byGroup.set(key, [{ fullName: r.fullName, studentCode: r.studentCode }]);
  }

  // Course, then class — the order the course tree shows them in, so the sheet reads like the app. The
  // unplaced group is pinned last whatever it sorts as.
  const order = new Map<string, string>();
  for (const m of meta.values()) order.set(m.label, m.sort);
  const groups = [...byGroup.entries()]
    .map(([label, children]) => ({ label, children }))
    .sort((a, b) => {
      if (a.label === UNPLACED) return 1;
      if (b.label === UNPLACED) return -1;
      return (order.get(a.label) ?? a.label).localeCompare(order.get(b.label) ?? b.label);
    });

  return { groups, total: rows.length, missing: rows.filter((r) => !r.studentCode).length };
}

/** Children in pairs, so each printed row holds two of them. An odd tail gets one empty half. */
function pairs(children: IdSheetChild[]): (IdSheetChild | null)[][] {
  const out: (IdSheetChild | null)[][] = [];
  for (let i = 0; i < children.length; i += 2) out.push([children[i], children[i + 1] ?? null]);
  return out;
}

/** Who the reader may see: the schools their account is allowed, and whether it is restricted at all.
 *  Both, because `visibleSchoolIds` returns EVERY school for an unrestricted account rather than an
 *  empty list, and the two cases have to behave differently — see below. */
export interface IdSheetScope {
  allowed: string[];
  restricted: boolean;
}

/**
 * Render the Student ID sheet. `scope` is a school id, or `'all'`.
 *
 * An UNRESTRICTED reader asking for `all` gets NO school filter, rather than a filter listing every
 * school. Those sound equivalent and are not: a child whose `school_id` is somehow null would be
 * excluded by the second and included by the first, and a roster sheet silently missing a child is
 * precisely the failure that must not happen. A restricted reader does get an explicit filter, because
 * narrowing is the whole point of the restriction.
 *
 * Returns null when the requested school is not one this reader may see, so the route 404s instead of
 * quietly widening the scope.
 */
export function buildIdSheetHtml(scope: string, reader: IdSheetScope, now: Date = new Date()): string | null {
  const all = listSchools();
  const multi = all.length > 1;

  let schoolIds: string[];
  let schoolName: string | null = null;
  if (scope === 'all') {
    schoolIds = reader.restricted ? reader.allowed : [];
    // Named only when there is a choice to disambiguate — on a single-school install the masjid's own
    // name is already the heading, and repeating it as "for X" reads like a fault.
    if (multi && reader.restricted && reader.allowed.length === 1) schoolName = all.find((s) => s.id === reader.allowed[0])?.name ?? null;
  } else {
    // An unrestricted reader may ask for any school that exists; a restricted one, only theirs. Keyed
    // off `restricted` rather than off `allowed` being empty, because an empty allow-list has to mean
    // "nothing is being narrowed" — reading it as "nothing is permitted" would 404 every school for the
    // ordinary account, which is every account until somebody sets a restriction.
    const allowed = reader.restricted ? reader.allowed : all.map((s) => s.id);
    if (!allowed.includes(scope)) return null;
    schoolIds = [scope];
    if (multi) schoolName = all.find((s) => s.id === scope)?.name ?? null;
  }

  const d = collectIdSheet(schoolIds);
  const schoolLabel = getSchoolName();
  const logo = getSchoolLogo();
  const accent = getAccentColor();
  const wash = accentWash(accent);
  const contact = getSchoolContact();
  const printedOn = formatDate(now.toISOString().slice(0, 10));
  const contactFooter = [contact.address, contact.phone, contact.email, contact.website].map((v) => v.trim()).filter(Boolean).join(' · ');

  const groupBlocks = d.groups.length
    ? d.groups
        .map(
          (g) => `<section>
    <h2>${esc(g.label)} <span class="count">${g.children.length}</span></h2>
    <table>
      <thead><tr><th>Name</th><th class="idcol">Student ID</th><th>Name</th><th class="idcol">Student ID</th></tr></thead>
      <tbody>${pairs(g.children)
        .map(
          (row) => `<tr>${row
            .map((c) => (c ? `<td>${esc(c.fullName)}</td><td class="idcol"><span class="code">${esc(c.studentCode ?? '—')}</span></td>` : '<td></td><td></td>'))
            .join('')}</tr>`,
        )
        .join('')}</tbody>
    </table>
  </section>`,
        )
        .join('')
    : '<p class="muted">There are no active students to list yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Student IDs — ${esc(schoolLabel)}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  /* --teal is the masjid's own color (Settings → How you appear to parents). Validated as a hex
     literal before it reaches here, because this is interpolated into a style block. */
  :root { --ink:#1a1a1a; --teal:${accent}; --wash:${wash}; --line:#cbcbcb; --muted:#666; }
  * { box-sizing: border-box; }
  body { font: 13px/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .sheet { max-width: 7.5in; margin: 0 auto; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  .btn { font: inherit; padding: 8px 16px; border: 1px solid var(--teal); background: var(--teal); color: #fff; border-radius: 8px; cursor: pointer; }
  header { border-bottom: 2px solid var(--teal); padding-bottom: 9px; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { max-height: 46px; max-width: 170px; width: auto; height: auto; }
  h1 { font-size: 19px; color: var(--teal); margin: 0; }
  .sub { color: var(--muted); margin-top: 1px; font-size: 12px; }
  .printed { margin-inline-start: auto; font-size: 11.5px; white-space: nowrap; align-self: flex-end; text-align: right; }
  .intro { margin: 0 0 12px; font-size: 12px; }
  /* A class group must not be split across sheets when it can be helped — a heading alone at the foot
     of a page is what makes a printed list annoying to use. */
  section { margin-top: 13px; break-inside: avoid; page-break-inside: avoid; }
  h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 4px; }
  .count { color: var(--teal); letter-spacing: 0; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: left; padding: 3.5px 6px; border-bottom: 1px solid var(--line); font-size: 12px; }
  thead th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .idcol { width: 21%; }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.08em; font-weight: 700; }
  .muted { color: var(--muted); }
  .note { margin-top: 14px; padding: 8px 12px; border-left: 3px solid var(--teal); background: var(--wash); font-size: 11.5px; break-inside: avoid; }
  footer { margin-top: 16px; color: var(--muted); font-size: 11px; text-align: center; }
  @media print {
    body { padding: 0; font-size: 10.5pt; }
    .toolbar { display: none; }
    /* A solid block of color is what drains a masjid's toner. */
    .note { background: #fff; }
  }
${SHEET_PHONE_CSS}
</style>
</head>
<body>
<div class="sheet">
  <div class="toolbar"><button class="btn" onclick="window.print()">Print</button></div>
  <p class="phone-tip">On a phone, Print opens your phone&rsquo;s own print preview &mdash; from there the share button will email it, send it, or save it as a PDF.</p>
  <header>
    <div class="brand">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ''}
      <div>
        <h1>${esc(schoolLabel)}</h1>
        <div class="sub">Student IDs${schoolName ? ` — ${esc(schoolName)}` : ''}</div>
      </div>
      <span class="printed muted">Printed ${esc(printedOn)}<br />${d.total} student${d.total === 1 ? '' : 's'}</span>
    </div>
  </header>

  <p class="intro">Every child's Student ID, by class. A parent types one of these to pay at the kiosk or
  on the masjid website, and to set up their parent portal account — so this is the sheet to reach for
  when a family rings and cannot find theirs. Each ID is also on the child's own record and on their
  family's statement.</p>

  ${groupBlocks}

  ${d.missing > 0 ? `<p class="muted">${d.missing} student${d.missing === 1 ? ' has' : 's have'} no Student ID on record — tell whoever looks after the system.</p>` : ''}

  <div class="note"><b>Office copy — please don't pin this up in public.</b> A Student ID is all somebody
  needs to look up what a child owes and pay it. That is the most it can do — it opens no account and
  changes no record — but a family's name and balance is still theirs, so keep this sheet where the
  office keeps its paperwork.</div>

  <footer>
    <div>${esc(schoolLabel)} · Correct as of ${esc(printedOn)}</div>
    ${contactFooter ? `<div>${esc(contactFooter)}</div>` : ''}
  </footer>
</div>
</body>
</html>`;
}
