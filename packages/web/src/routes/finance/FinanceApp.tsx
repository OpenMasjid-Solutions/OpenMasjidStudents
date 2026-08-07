// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The finance app on the family shell (§15): a bottom dock (Billing, Year) + mac-style windows.
 *  Finance works on the LAN and over the Cloudflare tunnel (§5); every read/write is
 *  admin+finance-scoped server-side.
 *
 *  Finance gets the year view read-only — it can read the grid and print it, but changing which
 *  optional columns show (guardian contact details among them) is admin-only, so `canConfigure` is
 *  false. */
import { useState } from 'react';
import { WindowsProvider } from '../../components/Windows';
import { SchoolProvider } from '../../components/SchoolTabs';
import { AppShell } from '../../components/AppShell';
import { FINANCE_ITEMS, type FinanceSection } from '../../components/Dock';
import { trpc } from '../../lib/trpc';
import { Billing } from '../admin/Billing';
import { YearView } from '../admin/YearView';
import { Students } from '../admin/Students';

export function FinanceApp() {
  const utils = trpc.useUtils();
  const [section, setSection] = useState<FinanceSection>('billing');
  const onSignedOut = () => void utils.auth.session.invalidate();
  return (
    <WindowsProvider>
      {/* Finance shares the Students and Year screens with admin, so it needs the same school
          switcher — and a finance account limited to one school (Staff → Schools) sees only that
          one's tab. Without the provider those screens would render with no switcher at all. */}
      <SchoolProvider>
        <AppShell items={FINANCE_ITEMS} active={section} onNavigate={(s) => setSection(s as FinanceSection)} onSignedOut={onSignedOut}>
          {section === 'year' ? <YearView canConfigure={false} /> : section === 'students' ? <Students readOnly /> : <Billing canManagePlans={false} />}
        </AppShell>
      </SchoolProvider>
    </WindowsProvider>
  );
}
