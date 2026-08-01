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
---

## Acknowledgements

Created by **Hasan Ismail**, with immense help from **Qari Ijaz** and **Osman Sayed**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://github.com/hasan-ismail">
          <img src="https://github.com/hasan-ismail.png?size=100" width="100px;" alt="Hasan Ismail"/><br />
          <sub><b>Hasan Ismail</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/ijazshare">
          <img src="https://github.com/ijazshare.png?size=100" width="100px;" alt="Qari Ijaz"/><br />
          <sub><b>Qari Ijaz</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/osayed0001">
          <img src="https://github.com/osayed0001.png?size=100" width="100px;" alt="Osman Sayed"/><br />
          <sub><b>Osman Sayed</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

Resources for this project were generously sponsored by **[An-Noor Institute](https://www.annoorusa.org/)**, **[Rihlatul Ilm Foundation](https://rifusa.org/)**, and **[AsmaTec Inc.](https://asmatec.com/)**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://www.annoorusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/An-noor2.png" width="120px;" alt="An-Noor Institute"/><br />
          <sub><b>An-Noor Institute</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://rifusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/RIFbetter.png" width="120px;" alt="Rihlatul Ilm Foundation"/><br />
          <sub><b>Rihlatul Ilm Foundation</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://asmatec.com/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/Asmatec.png" width="120px;" alt="AsmaTec Inc."/><br />
          <sub><b>AsmaTec Inc.</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

May Allah reward everyone who made it possible.

---
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
