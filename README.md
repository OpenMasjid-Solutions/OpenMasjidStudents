<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->
<p align="center">
  <strong>OpenMasjid Students</strong><br/>
  Tuition &amp; fee management for your madrasa — pay online, at the kiosk, or on the donation site.
</p>

<p align="center">
  <em>A self-hosted tuition/fee app that runs as an <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidOS">OpenMasjidOS</a> app — one Docker container, all data on the masjid's own hardware.</em>
</p>

---

**OpenMasjid Students** keeps a madrasa's **families and students**, assigns **fee plans**
per student, and generates **family invoices** each month or term. A **finance manager**
records cash / Zelle / check payments and sees the whole ledger; **parents** get a
phone-first portal with the family balance and a unified payment history, and can **pay by
card in-app (Stripe)** — with **autopay** and saved cards. Printable statements carry each
child's **Student ID** and a portal-signup QR.

Tuition can also be paid with a **child's Student ID** on the masjid's **OpenMasjid
Donations** site and **OpenMasjid Kiosk**: type the ID, check the name it shows, then pay for
any of your children from that one screen. Those payments flow straight into the same ledger
over the OpenMasjidOS **Fabric**. This app provides the `students/billing` capability those
apps consume (see [`docs/FABRIC_BILLING_CONTRACT.md`](docs/FABRIC_BILLING_CONTRACT.md)).

Three roles: **admin** manages families, students, fee plans and settings (on the masjid
network only); **finance** runs billing (network + internet uplink); **parents** get the
portal (network + uplink).

> **Standalone-first.** With no platform, no tunnel, no Donations/Kiosk and no SMTP, the app
> still fully works on the masjid network — families, students, fee plans, invoices, the
> ledger and manual-payment billing all function; every integration degrades gracefully.
> (Without the tunnel, the parent portal is network-only and card payments reconcile via the
> daily Stripe job instead of live confirmation.)

## Status

Active development. See [`CHANGELOG.md`](CHANGELOG.md) for what has landed and `CLAUDE.md`
for the specification and build plan.

## Develop

```bash
npm install          # all workspaces
npm run dev          # server on :8080, web (Vite) on :5173 proxying /trpc /api /fabric
npm run build        # typecheck + build web and server
npm run lint         # tsc --noEmit across workspaces
npm run test         # vitest (ledger, fabric contract, confirm/reconcile, autopay, origin policy, …)
```

Open http://localhost:5173 in dev. The design system is ported verbatim from OpenMasjidOS
for visual parity — see [`packages/web/PORTED_FROM_OPENMASJIDOS.md`](packages/web/PORTED_FROM_OPENMASJIDOS.md).

## License

[AGPL-3.0-only](LICENSE). Contributions are governed by the
[CLA](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md).
