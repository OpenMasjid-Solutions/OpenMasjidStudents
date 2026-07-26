// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** The finance app on the family shell (§15): a bottom dock (Billing, Year) + mac-style windows.
 *  Finance works on the LAN and over the Cloudflare tunnel (§5); every read/write is
 *  admin+finance-scoped server-side.
 *
 *  Finance gets the year view read-only — it can read the grid and print it, but changing which
 *  optional columns show (which can expose PINs) is admin-only, so `canConfigure` is false. */
import { useState } from 'react';
import { WindowsProvider } from '../../components/Windows';
import { AppShell } from '../../components/AppShell';
import { FINANCE_ITEMS, type FinanceSection } from '../../components/Dock';
import { trpc } from '../../lib/trpc';
import { Billing } from '../admin/Billing';
import { YearView } from '../admin/YearView';

export function FinanceApp() {
  const utils = trpc.useUtils();
  const [section, setSection] = useState<FinanceSection>('billing');
  const onSignedOut = () => void utils.auth.session.invalidate();
  return (
    <WindowsProvider>
      <AppShell items={FINANCE_ITEMS} active={section} onNavigate={(s) => setSection(s as FinanceSection)} onSignedOut={onSignedOut}>
        {section === 'year' ? <YearView canConfigure={false} /> : <Billing />}
      </AppShell>
    </WindowsProvider>
  );
}
