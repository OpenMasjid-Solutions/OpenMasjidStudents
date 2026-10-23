<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidStudents — React Bits Pro migration audit

OpenMasjidStudents is the self-hosted tuition and fee-management app for a madrasah (families and
students, per-student fee plans, family invoices, a ledger, cash and card payments) that runs as an
OpenMasjidOS platform app. The frontend is **React 18.3.1 + Vite 6.0.7**, TypeScript strict, with
**Tailwind CSS v4.0.0** wired in through `@tailwindcss/vite` but — see §6 — effectively unused:
there is **no router package at all**, no shadcn/ui, no Radix, and the entire visual layer is
~3,480 lines of hand-written BEM-ish CSS ported verbatim from OpenMasjidOS `packages/ui`.
Navigation is `useState` section switching inside three role shells, plus three hard-coded
`window.location.pathname` matches in `App.tsx`. In scope: **61 `.tsx` components / 24 `.ts` lib
modules (~16,825 LOC)** across **54 distinct surfaces** — 26 React screens, 13 windowed
record/dialog surfaces, 4 non-window overlays, and 11 server-rendered HTML documents that React
never touches.

---

## 1. Screen map

Routing is **hand-rolled**, and this matters for every RB shell/nav category below. There is no
`react-router`, no file-based routing and no Astro. Three mechanisms exist:

1. **Path matching** — `App.tsx:67` reads `window.location.pathname`, runs it through
   `lib/base.ts` `stripBase()` (drops the OpenMasjidOS tunnel prefix, e.g. `/students`), then
   compares with `===` against exactly three literals. No history API, no `<Link>`, no back button.
2. **Session-gate branching** — `App.tsx:100-146` picks a screen from the `auth.session` query.
3. **`useState` section switching** inside each role shell (`AdminApp.tsx:23`,
   `FinanceApp.tsx:26`, `FamilyApp.tsx:31`) and inside `Settings.tsx:46` / `Admissions.tsx:40`.
   Sections are **not addressable** — you cannot link anyone to a settings tab.

| Route / screen | Current component file(s) | RB category | Variant | Status |
|---|---|---|---|---|
| **Anonymous, path-matched** | | | | |
| `/family/reset` (request link, and `?token=` set-password) | `routes/ResetPassword.tsx` | authentication | PENDING | not started |
| `/family/invite?token=` | `routes/InviteAccept.tsx` | authentication + onboarding | PENDING | not started |
| `/family/invite` (no token — invalid notice) | `App.tsx` `NoticeCard` | empty-state | PENDING | not started |
| `/family/register` (parent self-registration) | `routes/SelfRegister.tsx` | authentication + onboarding | PENDING | not started |
| **Session gate (no path)** | | | | |
| Connecting / session loading | `App.tsx:127-133` inline card | empty-state + preloader | PENDING | not started |
| First-run admin setup | `routes/Setup.tsx` | authentication + onboarding | PENDING | not started |
| First-run blocked over tunnel | `App.tsx` `SetupOnLanNotice` | empty-state | PENDING | not started |
| Login (LAN and tunnel variants, one component) | `routes/Login.tsx` | authentication | PENDING | not started |
| Forced password change | `routes/ChangePassword.tsx` | authentication | PENDING | not started |
| Signed-in placeholder (teacher role; no shell yet) | `routes/Home.tsx` | empty-state | PENDING | not started |
| **Admin shell (role `admin`, LAN only)** | | | | |
| Shell chrome: topbar + clock + profile + dock + windows | `components/AppShell.tsx`, `Dock.tsx`, `WindowManager.tsx`, `Windows.tsx`, `Clock.tsx`, `ProfileMenu.tsx`, `ShellControls.tsx`, `SceneBackground.tsx` | app-shell + app-sidebar + navbar + command-menu + mobile | PENDING | not started |
| `dashboard` — welcome card + stat tiles + first-run CTA | `routes/admin/Dashboard.tsx` | dashboard + analytics + card | PENDING | not started |
| `students` — roster grouped course → class, course filters, search | `routes/admin/Students.tsx` | data-table + filtering + forms + card | PENDING | not started |
| `admissions` › inquiries list | `routes/admin/Admissions.tsx` (`view='inquiries'`) | data-table + filtering + list | PENDING | not started |
| `admissions` › readmission round | `routes/admin/Admissions.tsx` + `components/Readmissions.tsx` | scheduling + forms + list | PENDING | not started |
| `year` — the year grid (students × 12 months) | `routes/admin/YearView.tsx` | data-table + scheduling + card | PENDING | not started |
| `structure` — schools, courses, classes, year rollover | `routes/admin/Structure.tsx` | settings-form + list + forms | PENDING | not started |
| `billing` — record payment, fee plans, charges, invoice gen, CSV export, refunds | `routes/admin/Billing.tsx`, `components/InvoiceGenFields.tsx`, `components/Refunds.tsx` (lazy) | billing + analytics + dashboard + forms | PENDING | not started |
| `staff` — staff accounts, roles, school scoping | `routes/admin/Staff.tsx` | settings-form + data-table | PENDING | not started |
| `settings` › school (name, currency, contact, date format, logo) | `routes/admin/Settings.tsx` (`tab='school'`, line 355) | settings-form | PENDING | not started |
| `settings` › students (custom record fields) | `Settings.tsx:557` + `components/StudentFieldsSettings.tsx` | settings-form + forms | PENDING | not started |
| `settings` › admissions (public form, embed origins, copy) | `Settings.tsx:567` → `components/AdmissionsSettings.tsx` | settings-form + integrations | PENDING | not started |
| `settings` › documents (printed-sheet wording, accent colour, logo) | `Settings.tsx:569` | settings-form + editor | PENDING | not started |
| `settings` › messages (WhatsApp gateway, templates, recipients) | `Settings.tsx:705` → `components/WhatsAppSettings.tsx` | settings-form + integrations + notifications | PENDING | not started |
| `settings` › payments (Stripe status via Fabric) | `Settings.tsx:972` | billing + integrations | PENDING | not started |
| **Finance shell (role `finance`, LAN + tunnel)** | | | | |
| Shell chrome (3-item dock) | `routes/finance/FinanceApp.tsx` + same shell components | app-shell + navbar + mobile | PENDING | not started |
| `billing` (`canManagePlans=false`) | `routes/admin/Billing.tsx` reused | billing + analytics + forms | PENDING | not started |
| `students` (`readOnly`) | `routes/admin/Students.tsx` reused | data-table + filtering | PENDING | not started |
| `year` (`canConfigure=false`) | `routes/admin/YearView.tsx` reused | data-table + scheduling | PENDING | not started |
| **Parent portal (role `parent`, phone-first)** | | | | |
| Shell: sticky topbar + tab bar, single column | `routes/family/FamilyApp.tsx` | mobile + app-shell | PENDING | not started |
| `home` — balance, children, invoices, payments, autopay CTA | `routes/family/Home.tsx` | mobile + card + list + dashboard | PENDING | not started |
| `year` — months as wrapping chips per child (deliberately not a table) | `routes/family/Year.tsx` | mobile + card + list | PENDING | not started |
| `autopay` — saved cards, autopay toggle | `routes/family/PayMethods.tsx` | billing + mobile + card | PENDING | not started |
| Pay-now sheet (Stripe Elements) | `routes/family/PayNow.tsx` | billing + app-dialog + wizard | PENDING | not started |
| **Windowed record surfaces** (mac-style windows via `Windows.tsx` — movable, minimizable to the dock, content stays mounted; NOT modals) | | | | |
| Household record (guardians, children, contact, notes) | `routes/admin/FamilyDetail.tsx` | app-dialog + forms + data-table | PENDING | not started |
| Household billing record (invoices, lines, payments) | `components/FamilyBilling.tsx` | app-dialog + billing + data-table | PENDING | not started |
| Student record (custom fields, office notes) | `components/StudentRecord.tsx`, `RecordFields.tsx`, `HouseholdFields.tsx` | app-dialog + forms | PENDING | not started |
| Inquiry detail + admit flow | `components/InquiryDetail.tsx`, `components/AdmitInquiry.tsx` | app-dialog + forms + wizard | PENDING | not started |
| Roster import (CSV/XLSX, column mapping, fee assignment) | `routes/admin/ImportStudents.tsx` | wizard + data-table + file-manager | PENDING | not started |
| Go-live / first-run wizard (lazy) | `components/FirstRunSetup.tsx` | onboarding + wizard | PENDING | not started |
| Year rollover (5-step review, lazy) | `components/YearRollover.tsx` | wizard + scheduling | PENDING | not started |
| Mid-year setup (lazy) | `components/MidYearSetup.tsx` | wizard + billing | PENDING | not started |
| Mass fee apply | `components/MassApply.tsx` | forms + data-table | PENDING | not started |
| Class enrolment | `components/ClassEnrol.tsx` | list + filtering | PENDING | not started |
| Sibling suggestions | `components/SiblingSuggestions.tsx` | list + empty-state | PENDING | not started |
| Onboarding send (invites / sheets to households) | `components/OnboardingSend.tsx` | notifications + forms | PENDING | not started |
| What's new (changelog, lazy) | `components/WhatsNew.tsx` | notifications + editor | PENDING | not started |
| **Non-window overlays** | | | | |
| Add-to-home-screen prompt | `components/InstallPrompt.tsx` | app-dialog + notifications | PENDING | not started |
| Student combobox / picker dropdown | `components/StudentPicker.tsx` | command-menu + filtering | PENDING | not started |
| School tab switcher | `components/SchoolTabs.tsx` | navbar + filtering | PENDING | not started |
| Error boundary fallback | `components/ErrorBoundary.tsx` | empty-state | PENDING | not started |
| **Server-rendered HTML — NOT React, outside any RB rebuild** | | | | |
| `GET /statements/family/:id` | `server/src/billing/statementRoutes.ts:102` + `statements.ts` | (print document) | PENDING | not started |
| `GET /sheets/family/:id` | `statementRoutes.ts:109` + `people/onboardingSheet.ts` | (print document) | PENDING | not started |
| `GET /invoices/:id` | `statementRoutes.ts:116` + `billing/invoiceDoc.ts` | (print document) | PENDING | not started |
| `GET /sheets/ids/:id` | `statementRoutes.ts:127` + `people/idSheet.ts` | (print document) | PENDING | not started |
| `GET /public/inquiry` (hosted admissions form) | `server/src/admissions/publicRoutes.ts:807` | forms | PENDING | not started |
| `GET /public/inquiry/embed` (framable) | `publicRoutes.ts:814` | forms | PENDING | not started |
| `GET /public/inquiry.js` (embeddable widget — builds DOM in the masjid's own page) | `publicRoutes.ts:849` | forms | PENDING | not started |
| `GET/POST /public/readmission` | `publicRoutes.ts:949,956` | forms | PENDING | not started |
| `GET/POST /public/admission` | `publicRoutes.ts:969,980` + `admissions/admissionForm.ts` | forms + wizard | PENDING | not started |
| `GET/POST /public/admission/kiosk` (tablet waiting-room mode) | `publicRoutes.ts:1013,1023` | forms + wizard + mobile | PENDING | not started |
| `public/offline.html` (service-worker offline page) | `packages/web/public/offline.html` | empty-state | PENDING | not started |

**Count:** 26 React screens + 13 windowed surfaces + 4 overlays + 11 server-rendered = **54
surfaces**, of which **43 are React**.

---

## 2. Animation inventory

**Not found anywhere** (grepped across `packages/web` and `packages/server`): `framer-motion` (the
old package name), `gsap`, `react-spring`, `lottie`, and **zero** Tailwind `animate-*` or
`transition-*` utility classes — because no Tailwind utility classes are used at all (§3, §6).

| Source | Where (file:line) | What it does | RB replacement |
|---|---|---|---|
| `motion` v11.15.0 (`motion/react`) | imported in 20 files; `<motion.*>` elements in 10 files, 30 element usages | The only JS animation library | removed |
| `springSoft` preset | `lib/motion.ts:11` | `spring` 320 / 30 / mass 0.9 — the house feel | block-native |
| `springSnappy` preset | `lib/motion.ts:12` | `spring` 500 / 32 — press feedback | block-native |
| `fadeRise` variants | `lib/motion.ts:15-19` | Page/card entrance: opacity 0→1, y 12→0; exit y 0→-8 | staggered-text-tw |
| `staggerContainer` variants | `lib/motion.ts:22-25` | `staggerChildren: 0.05`, `delayChildren: 0.04` | animated-list-tw |
| `staggerItem` variants | `lib/motion.ts:27-30` | Grid item: opacity / y 14→0 / scale 0.98→1 | animated-list-tw |
| `@keyframes auroraDrift` | `styles/app.css:73`, applied `app.css:71` (32s ease-in-out infinite alternate) | The wallpaper's slow ambient drift behind all glass | removed |
| `@keyframes winIn` | `styles/app.css:616`, applied `app.css:615` (`.win-enter`, 0.24s) | Window open | modal-cards-tw |
| `@keyframes winInFlat` | `styles/shell.css:188`, applied `shell.css:186` (0.24s) | Window open — paint-cheap override with no `filter` | modal-cards-tw |
| `@keyframes spin` | `styles/app.css:822`, applied `app.css:818` (0.7s linear infinite) | Spinner | preloader-tw |
| `@keyframes shimmer` | `styles/app.css:833`, applied `app.css:831` (1.4s infinite) | `.skeleton` loading shimmer | block-native |
| `@keyframes pulseGlow` | `styles/glass.css:144`, applied `glass.css:137` (2.4s infinite) | `.status-dot::after` connection pulse | block-native |
| CSS `transition:` declarations (15 active) | `app.css:150,228,305,320,420,441,495,507,679,689,715`; `family.css:83,343,344`; `tokens.css:355` | Hover lifts, dock pop, toggle/switch travel, progress width, theme-flip colour fade | block-native |
| CSS reduced-motion resets (7) | `app.css:783,784,786`; `family.css:97,352`; `glass.css:150`; `shell.css:201` | `animation: none` / `transition: none` under `prefers-reduced-motion` | block-native |
| Global reduced-motion clamp | `styles/tokens.css:364-372` | `*`, `*::before`, `*::after` → 0.01ms durations, `scroll-behavior: auto` | block-native |
| `installCursorFx()` | `lib/cursorFx.ts` (whole module), called `main.tsx:34` | rAF-throttled pointer glint — sets `--mx`/`--my` on `.fx-glint` panes; refuses to install under reduced-motion or on a coarse pointer | hover-preview-tw |
| `installScrollIdle()` | `lib/scrollIdle.ts`, called `main.tsx:38` | Marks the document during a scroll gesture so `shell.css` pauses the aurora (`animation-play-state: paused`) — a paint-cost fix, not decoration | removed |
| Ambient video backdrop | `components/SceneBackground.tsx:24-38` (`/ambient.mp4`), toggled by `lib/ambient.ts` | Optional looping muted video wallpaper, per-device localStorage flag | removed |
| `InstallPrompt` delayed entrance | `components/InstallPrompt.tsx:43` (`APPEAR_AFTER_MS = 1200`) + one `<motion.*>` | Timed slide-in of the PWA install offer | modal-cards-tw |

Motion-element usage by file: `YearRollover.tsx` 2, `ResetPassword.tsx` 2, and 1 each in
`FirstRunSetup.tsx`, `InstallPrompt.tsx`, `ChangePassword.tsx`, `routes/Home.tsx`,
`InviteAccept.tsx`, `Login.tsx`, `SelfRegister.tsx`, `Setup.tsx` — plus `App.tsx`,
`Admissions.tsx`, `Billing.tsx`, `Dashboard.tsx`, `Settings.tsx`, `Staff.tsx`, `Structure.tsx`,
`Students.tsx` and `family/Home.tsx` importing the presets.

**Total: 29 distinct animation definitions** — 5 Motion presets + 6 `@keyframes` + 15 CSS
`transition:` declarations + 3 JS-driven effects. (Those are *definitions*; they are consumed by 6
CSS `animation:` applications and 30 `<motion.*>` elements, and countered by 7 reduced-motion
resets plus one global clamp.)

---

## 3. Third-party UI inventory

Two `package.json` files carry runtime dependencies — `packages/web` and `packages/server`. The root
has only `concurrently` and `typescript`.

| Package | Version | Used where | Disposition |
|---|---|---|---|
| `motion` | ^11.15.0 | 20 files; 30 `<motion.*>` elements; `lib/motion.ts` | removed |
| `lucide-react` | ^0.469.0 | 33 files, 63 distinct icons (`Dock.tsx` nav set, every screen header) | **keep** — RB / shadcn depend on lucide |
| `clsx` | ^2.1.1 | `lib/cn.ts` → `cn()`, used across components | **keep** — shadcn's `cn()` is built on it (note: `tailwind-merge`, its other half, is **absent**) |
| `@stripe/react-stripe-js` | ^3.1.1 | `family/PayNow.tsx`, `family/PayMethods.tsx`, `FamilyBilling.tsx` | **keep — not replaceable.** Elements is the PCI boundary; CLAUDE.md §7: "Card data never touches our server" |
| `@stripe/stripe-js` | ^5.5.0 | the three above, plus `Settings.tsx`, `Structure.tsx`, `Refunds.tsx` | **keep — not replaceable** (same reason) |
| `@fontsource-variable/inter` | ^5.1.1 | `main.tsx:5`; `--font-sans` (`tokens.css:181`) | keep unless the RB type scale replaces it — RB ships no typeface, and these are self-hosted (no CDN) |
| `@fontsource-variable/space-grotesk` | ^5.1.1 | `main.tsx:6`; `--font-display` (`tokens.css:182`) | same |
| `i18next` | ^24.2.0 | `lib/i18n/index.ts` | **keep** — 1,652 keys; every string routed through `t()` |
| `react-i18next` | ^15.4.0 | every screen (`useTranslation`) | **keep** |
| `@tanstack/react-query` | ^5.62.8 | `lib/trpc.ts`, every screen | **keep** — data layer, not UI |
| `@trpc/client` / `@trpc/react-query` / `@trpc/server` | ^11.0.0 | `lib/trpc.ts` | **keep** |
| `tailwindcss` + `@tailwindcss/vite` | ^4.0.0 | `index.css:4` (`@import "tailwindcss"`), `vite.config.ts:9` | **keep — required by RB.** Currently imported and effectively unused (§6) |
| `qrcode` (server) | ^1.5.4 | `billing/statementRoutes.ts`, printed sheets and statements | **keep** — server-side, generates the `data:` QR in print documents |

**Verified absent** (grepped all three `package.json` files): MUI, Chakra, Mantine, Headless UI,
**Radix**, any date picker (forms use native `<input type="date">`), any chart library (no chart
exists anywhere in the app), any toast/notification library (in-page `.notice` elements instead),
carousel, drag-and-drop, rich-text editor, SheetJS/`xlsx`, and any date library
(`date-fns`/`dayjs`/`luxon`/`moment`). Spreadsheet read and write are hand-rolled (`lib/xlsx.ts`,
`lib/xlsxWrite.ts`), as is CSV (`lib/csv.ts`).

---

## 4. Token inventory

All tokens are CSS custom properties. `packages/web/src/styles/tokens.css` (372 lines) is the single
source and is **ported verbatim** from OpenMasjidOS `packages/ui/src/styles/tokens.css` @ `c4d309f`
(v0.40.0) — see `packages/web/PORTED_FROM_OPENMASJIDOS.md`.

| Token kind | Where defined | Count | Disposition |
|---|---|---|---|
| Colour tokens (`--color-*`) | `tokens.css:17-52` (dark), `:96-131` (light) | 22 distinct names × 2 themes | map to RB theme vars |
| Glass tokens (`--glass-*`, `--glint*`) | `tokens.css:47-67` / `:126-148` | 14 distinct × 2 themes | **no RB equivalent** — this is the house material (`backdrop-filter`) |
| Scene / aurora (`--scene-*`, `--aurora-*`, `--pattern-opacity`) | `tokens.css:74-84` / `:151-161` | 7 distinct × 2 themes | removed, or reimplemented |
| Wallpaper variants | `tokens.css:187-234` (dark) + `:245-306` (light overrides) | 9 wallpapers × 2 themes = 18 blocks | keep as data (`prefs.ts` `WALLPAPERS`, 9 entries) |
| Radii | `tokens.css:44-45` / `:123-124` — `--radius-card: 1rem`, `--radius-button: 0.625rem` | **2 tokens**; 15 distinct raw `border-radius` values bypass them (`999px` ×13, `50%` ×11, `14px` ×4, `0.7rem` ×3, `0.5rem` ×3, …) | map to the RB radius scale; the raw values are existing drift |
| Shadows | `tokens.css:41-42` / `:120-121` (`--shadow-card`, `--shadow-modal`) plus `--glass-shadow`, `--glass-shadow-raised`, `--glow-primary` | 5 | map to RB elevation |
| Fonts | `tokens.css:181-182` (`--font-sans`, `--font-display`); loaded at `main.tsx:5-6` | 2 tokens / 2 families (Inter Variable, Space Grotesk Variable) | decide against the RB type scale |
| Motion tokens | `tokens.css:173-177` (`--ease-settle`, `--dur-micro: 140ms`, `--dur-settle: 420ms`, `--lift-y: -6px`, `--tilt-max: 7deg`) | 5 | map to RB motion tokens |
| On-scene ink | `tokens.css:184-186` + `:310-314` (`--text-on-scene`, `-muted`, `-faint`) | 3 × 2 themes | map |
| Geometric motif | `tokens.css:87` / `:166` — inline `data:image/svg+xml` khatam tessellation | 1 per theme | keep as a brand asset |
| **Spacing scale** | **none exists** — every value is a literal `rem`/`px` in the six stylesheets and in inline `style={{}}` props | 0 | introduce with RB |
| **z-index scale** | **none exists** — 18 raw `z-index` literals across the stylesheets: `40`×4, `30`×2, `200`×2, `20`×2, `2`×2, `-1`×2, and one each of `60`, `50`, `5`, `3`, `100`, `1` | 0 tokens / 18 literals | introduce with RB |
| Accent presets (JS, not CSS) | `lib/prefs.ts:44-50` `ACCENTS` — cyan / teal / sky / violet / gold, each `{primary, hover, subtle}`; written inline onto `:root` by `applyAccent` (`prefs.ts:70-88`) | 5 accents × 3 values | port carefully — see §7 |

**Total distinct custom properties:** 63 defined in `tokens.css`; 73 across all six stylesheets.

**Primary brand accent — the repo's real values, quoted from `tokens.css`:**

- **Dark (default):** `--color-primary: #22D3EE` (cyan), hover `#67E8F9`, button `--color-btn: #22D3EE`,
  ink-on-primary `--color-on-primary: #00131c`; accent/gold `--color-accent: #F59E0B` and
  `--color-gold: #F59E0B`; surface `#030D1A`, raised `#0A1828`, overlay `#0F2040`; ink `#F4F7FB`.
- **Light:** `--color-primary: #0284C7`, hover `#0369A1`, button `--color-btn: #0369A1`,
  ink-on-primary `#FFFFFF`; accent/gold `#D97706`; surface `#F0F9FF`, raised `#FFFFFF`;
  ink `#0C4A6E`.

Note the documentation drift: this repo's own `CLAUDE.md` §15 says "**emerald** primary, gold
accents". No emerald exists anywhere in `tokens.css` — the palette is cyan-on-deep-navy in dark and
sky-blue in light. Take the hexes above, not §15.

---

## 5. RTL / i18n inventory

**Library and locales.** `i18next` ^24.2.0 + `react-i18next` ^15.4.0, initialised in
`lib/i18n/index.ts`. **Exactly one locale is registered**: `en` (`resources: { en: … }`,
`lng: 'en'`, `fallbackLng: 'en'`). `en.json` is the only locale file — 118 KB, ~1,652 keys. The
module's own header states the Arabic and Urdu locales and the language picker were removed by
decision.

**Is `dir="rtl"` ever set, and by what code.** Yes, by exactly one line: `lib/prefs.ts:103` in
`applyLanguage()` —
`document.documentElement.setAttribute('dir', RTL_LANGS.has(lang) ? 'rtl' : 'ltr')`, where
`RTL_LANGS = new Set(['ar','ur'])` (`prefs.ts:66`). **It can never fire today**, and is actively
defended against: `main.tsx:31` calls `prefsStore.patch({ language: 'en' })` on boot precisely
because a browser that used the old picker may still hold `ar`/`ur` in `localStorage`, which
`applyLanguage` would honour and flip a now-English UI to RTL. `packages/web/index.html:4` hardcodes
`<html lang="en">` with no `dir`. Three RTL-specific CSS rules survive and are dead code until a
locale returns: `app.css:510` (`[dir="rtl"] .toggle.is-on::after`), `family.css:232`
(`.autopay-cta .go` mirrored), `family.css:348` (switch thumb travel).

**Physical vs logical direction properties — the repo is close to RTL-correct.**

| | Stylesheets (`src/styles/*.css`) | Inline `style={{}}` in `.tsx` |
|---|---|---|
| **Physical** | **4**: `admin.css:1046` `left: 0 !important`, `admin.css:1048` `right: 0`, `app.css:599` `left: 0`, `app.css:602` `left: 50%` | **3**: `WindowManager.tsx:82` `left: '2vw'`, `WindowManager.tsx:84` `left: pos.x` (window drag position), one unrelated match |
| **Logical** | **137**: `margin-block` 39, `border-block` 20, `text-align: start\|end` 15, `padding-block` 14, `inset-inline` 13, `inset-block` 10, `margin-inline` 10, `padding-inline` 10, `border-inline` 6 | **381**: `marginBlockStart` 184, `marginBlockEnd` 136, `marginInlineStart` 34, `marginInlineEnd` 10, `marginBlock` 7, `textAlign:'end'` 3, `paddingInlineStart` 3, `paddingInline` 3, `insetInlineStart` 1 |
| **Zero occurrences of** | `margin-left`, `margin-right`, `padding-left`, `padding-right`, `border-left`, `border-right`, `text-align: left`, `text-align: right` | — |

So **7 physical against 518 logical** across the React layer, and all 7 are position/drag
coordinates where physical is arguably correct (a window's drag position is a viewport coordinate,
not a text direction). This is the cleanest RTL foundation in the migration — **do not regress it**.
RB blocks default to Tailwind's physical utilities (`ml-*`, `pr-*`, `left-*`, `text-left`); a
straight RB paste would replace 518 logical properties with physical ones and silently undo work the
repo has already done.

**The server-rendered documents are the exception, and are already physical.**
`packages/server/src` has 12 physical occurrences (`text-align: right` ×5, `text-align: left` ×4,
`border-left` ×2, `padding-left` ×1) against 3 logical (`margin-inline`), and **no HTML it emits
ever sets `dir`** — not the statements, the invoices, the ID/onboarding sheets, or the four public
admissions forms.

**Dates.** `lib/dates.ts` is display-only and hand-rolled — four formats (`iso`/`us`/`uk`/`long`),
kept deliberately in step with the server's `settings/dates.ts`, chosen per-install in Settings ›
documents. **There is no Hijri support anywhere** — grep finds no `hijri`, `islamic` or `umalqura`
and no calendar library in either package; the only "Ramadan" matches are prose in code comments
(`server/src/fabric/provider.ts:158,333`). Every date the UI collects goes through
`<input type="date">`, which is ISO by spec, so the browser localises the widget and the app never
parses a display string.

**Times.** `components/Clock.tsx:14-25` uses `Intl.DateTimeFormat(undefined, …)` — i.e. the
**browser's** locale, not i18next's — with `hour12: !clock24h` from prefs and an optional IANA
`timeZone` (`prefs.timezone`, `''` = the device's local zone).

**Currency.** `lib/money.ts` `formatMoney()` — one cached `Intl.NumberFormat` per currency code,
also on the `undefined` (browser) locale, with a comment saying that is deliberate and pre-existing.
Server twin at `server/src/db/money.ts:45`, which pins `'en'` instead. Amounts cross the wire as
integer cents.

**What would REGRESS if screens were rebuilt:**

1. **The logical-property discipline** (518 : 7). The single highest-value thing this repo already has.
2. **`styles/paintCost.test.ts`** — a source-shape test (there is no jsdom in this workspace) that
   fails the build if the four `backdrop-filter` paint-cost corrections in `shell.css` are lost, or
   if `.win-enter`'s reduced-motion override drops below the overriding specificity. A rebuild that
   reintroduces nested glass, or `filter: blur(0)` declared `both`, fails it — correctly.
3. **`styles/layoutClasses.test.ts`** — an allow-list of the files permitted to render
   `ul.picker-list` (an absolutely-positioned dropdown that collapses its section if used in flow).
   Deliberately an allow-list, not a count, so it fails on any new file that borrows the class.
4. **`prefers-reduced-motion`** — honoured in 5 media blocks plus a global clamp at
   `tokens.css:364`, and again in JS (`cursorFx.ts:23` refuses to install). CLAUDE.md §15 calls this
   non-negotiable.
5. **The 1,652 `t()` keys.** Every string goes through i18next specifically so that adding a locale
   is dropping in a JSON file rather than re-auditing every component. RB blocks ship hardcoded English.
6. **Print CSS.** The four printable documents must read correctly photocopied in black and white
   (CLAUDE.md §15). Nothing in RB addresses print.
7. **The Stripe Elements mount points** in `PayNow.tsx` / `PayMethods.tsx` — card data must never
   reach our DOM as plain inputs.

---

## 6. Prerequisites and blockers

**Versions, measured.**

| Requirement | This repo | Gap |
|---|---|---|
| React 19 | **React 18.3.1** (`react`, `react-dom`, `@types/react` ^18.3.18) | **Blocker** — major upgrade; also re-verify `Windows.tsx`'s synchronous `ref.current` mirror under React 19 StrictMode double-invocation |
| Tailwind v4 | **v4.0.0** (`tailwindcss` ^4.0.0 + `@tailwindcss/vite` ^4.0.0; `@import "tailwindcss"` at `index.css:4`) | Met on paper — see below |
| `components.json` (shadcn) | **Does not exist** anywhere in the repo | Must be created; the shadcn CLI has never run here |
| Node engine | root `package.json` `engines: { node: ">=20" }`; CI pins **Node 22** (`.github/workflows/ci.yml:51`) | Met |
| Bundler | Vite 6.0.7 with `base: './'` | Met, but `base: './'` is load-bearing — see below |
| Router | **None — no router package is installed** | **Blocker** for `app-shell` / `app-sidebar` / `navbar` / `command-menu` |

**Tailwind is present and unused.** `@import "tailwindcss"` is the entire content of `index.css`
beyond its SPDX header, and a scan of every `className` in `packages/web/src` returns **zero**
Tailwind utility classes — the most-used class names are all hand-written (`glass-inset` 311,
`hint` 272, `btn` 230, `label` 228, `input` 219, `field` 207, `btn--ghost` 142, …). So the v4
requirement is satisfied nominally while the UI shares nothing with a Tailwind codebase: every RB
block would land next to 3,480 lines of CSS that will not compose with it.

**The governing spec forbids the thing RB is built on.** This repo's `CLAUDE.md` §7, Components row,
states: *"**NOT shadcn/ui, and not Radix** — this line said so until 0.50.0 and was never true.
OpenMasjidOS/Display/Kiosk share `styles/{tokens,glass,app}.css` and none of them pull in
shadcn/Radix/tailwind-merge, so matching them (§15 parity, the harder constraint) means not adding
it here either. Nothing in `packages/web` imports Radix. Decision recorded in
`docs/DATA_MODEL.md`."* That is a recorded decision, not an oversight. **React Bits Pro cannot be
adopted here without Hasan reversing it**, and the reversal has to be made for the whole family at
once rather than in this repo alone.

**Platform-family UI parity is the harder constraint.** `CLAUDE.md` §15: *"A masjid admin opening
this app from the OpenMasjidOS dashboard should not be able to tell they left it — and that includes
the `/admin` route tree."* `PORTED_FROM_OPENMASJIDOS.md` lists 15 files copied **verbatim** from
OpenMasjidOS `packages/ui` @ `c4d309f` (v0.40.0), each carrying a third-line origin comment and each
required to stay *structurally identical to upstream* so theme fixes re-sync: `index.css`,
`tokens.css`, `glass.css`, `app.css`, `motion.ts`, `cursorFx.ts`, `ambient.ts`, `cn.ts`, `prefs.ts`,
`Glyphs.tsx`, `SceneBackground.tsx`, `ErrorBoundary.tsx`, `Windows.tsx`, `WindowManager.tsx`,
`logo-mark.png`. Rebuilding this app's frontend on RB **either breaks parity with OpenMasjidOS,
Kiosk and Display, or forces all four repos to migrate together.** This is the largest decision the
migration depends on and it is above this audit's pay grade.

**Hardware / runtime constraints.**

- *"Keep it Pi-friendly. Ask before adding heavy dependencies."* (`CLAUDE.md` §7, closing line.) The
  app is expected to run on a Raspberry Pi or a cheap mini-PC alongside the OpenMasjidOS platform
  and every other installed app.
- **There is an explicit, measured frame budget and it is already spent.** `CLAUDE.md` §15: *"THE
  MATERIAL HAS A FRAME BUDGET, AND `backdrop-filter` IS ALL OF IT"* — every element carrying one is
  its own render surface. `.glass-inset` appears **313 times** in the `.tsx` sources (27 inside one
  family's billing record, all in one scrolling container), and the four corrections that fixed the
  resulting jank live in `shell.css` with `paintCost.test.ts` guarding them. Any RB block that adds
  blur, `filter`, or a looping decoration re-enters territory this repo has already paid to leave.
- **No PDF renderer and no headless Chromium**, by policy (§7) — printed documents are print-CSS
  HTML assembled server-side.
- **No spreadsheet dependency**, by policy — the reader and writer are hand-rolled.

**What makes this repo harder than the others.**

1. **No router to hang an app-shell on.** RB's `app-shell`, `app-sidebar`, `navbar` and
   `command-menu` all assume addressable routes. Here `useState` sections are not addressable at
   all — nothing in the product can link to Settings › payments — so adding a router is a
   prerequisite of the shell work, not a by-product of it.
2. **Three shells, not one.** Admin (8 sections, windowed desktop), Finance (3 sections, the same
   shell, reusing three admin screens via `readOnly` / `canConfigure` / `canManagePlans` props), and
   the parent portal (phone-first, tab bar, entirely different chrome). Three screens are shared
   between admin and finance by prop, so rebuilding one is rebuilding both roles at once.
3. **The window manager is not a modal system.** `Windows.tsx` + `WindowManager.tsx` implement
   movable, minimizable, fullscreen-able, dedupe-keyed windows whose **content stays mounted while
   minimized** (hidden with CSS) so live state survives, and which restore from the dock. 13
   surfaces depend on it. RB's `app-dialog` is a modal; swapping it in loses minimize-to-dock, focus
   ordering (`z`), `dedupeKey` focusing and `closeByKey`.
4. **11 server-rendered HTML surfaces React never touches** — four printed documents and four public
   admissions forms plus the kiosk variant, and an **embeddable widget that runs inside a masjid's
   own website**, built with `createElement`/`textContent` (never `innerHTML`) and deliberately
   setting almost no styles so it inherits the host site's design. RB has nothing to offer here, and
   the widget in particular must stay style-less by design.
5. **`base: './'` is load-bearing.** One build must work at the LAN root *and* under the
   OpenMasjidOS tunnel path prefix (`vite.config.ts:14-19`, `lib/base.ts` `stripBase`/`withBase`).
   Any RB scaffold that bakes in an absolute base breaks the tunnel.
6. **Two CSS source-shape tests will fail a careless rebuild** (`paintCost.test.ts`,
   `layoutClasses.test.ts`) — by design, since there is no jsdom in this workspace and the failures
   they catch are otherwise silent.
7. **Licensing.** This repo is **AGPL-3.0-only** with SPDX headers on 321 files and a CLA
   (`CLA.md`). React Bits Pro is paid and proprietary. Shipping proprietary component source inside
   an AGPL tree — which AGPL §13 obliges a modifying network host to hand to its users — needs a
   licence answer before a single block is pasted. Not covered by this audit.

---

## 7. Notes

- **`applyAccent` never sets `--color-on-primary`, and it should.** `lib/prefs.ts:70-88` overwrites
  `--color-primary`, `--color-primary-hover`, `--color-primary-subtle`, `--color-btn` and
  `--color-btn-hover` inline on `:root` — but not the ink on top of them, and `ACCENTS`
  (`prefs.ts:44-50`) carries no `onPrimary` value to set. In **light** theme `--color-on-primary`
  stays `#FFFFFF` (`tokens.css:145`), so choosing the **Gold** accent (`#FBBF24`) paints white text
  on a bright amber button. OpenMasjidOS's own CLAUDE.md §13.1 now requires the two to be set
  together and has a `theme-tokens.test.ts` doing the contrast arithmetic; this port predates that
  fix (pinned at v0.40.0) and has no equivalent test. Worth fixing on the way through, whatever
  happens with RB.
- **`public/fonts/Amiri-Regular.ttf` is 431 KB of dead weight.** Shipped with its OFL licence and
  referenced by **nothing** — no `@font-face`, no CSS token, no HTML, no server template, no service
  worker. Left over from the Arabic/Urdu locales that were removed.
- **The parent portal deliberately refuses a data table.** `routes/family/Year.tsx` renders each
  child as a card with months as wrapping chips, and its header says why: the office's version is a
  200×12 grid, right at a desk and wrong on a phone. Both read the same server function
  (`billing/yearCells.ts`) so a parent and the office never see different answers about the same
  month. Applying the mapping's `data-table` here would undo a considered decision.
- **`formatMoney` divides by 100 unconditionally** (`lib/money.ts:41`), i.e. it assumes every
  currency has two decimal places. Only `usd`/`cad`/`gbp`/`eur` are offered in Settings today so it
  is currently correct, but a JPY (zero-decimal) or KWD (three-decimal) install would be misreported
  by 100× or 10×. Sibling repos have hit this. Pre-existing, unrelated to RB, recorded here because
  the money cells are about to be rewritten.
- **`routes/Home.tsx` is a live placeholder, not a dashboard.** It is what the `teacher` role gets —
  a card saying "signed in" plus a sign-out button — because `App.tsx:119-121` routes only `admin`,
  `finance` and `parent` to real shells.
- **Icons are already lucide.** 63 distinct lucide icons across 33 files, which is the one place
  this codebase and React Bits Pro agree without any work.
