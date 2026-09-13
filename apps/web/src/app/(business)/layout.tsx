import type { ReactNode } from 'react';
import { ChatProvider } from './chat/chat-provider';
import { AuthGate } from '@/components/auth-gate';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { AppShell } from '@/components/app-shell';
import { ActingStoreProvider } from '@/lib/acting-store';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import { DashboardFiltersProvider } from '@/lib/dashboard-filters';

// Every (business) page calls per-tenant client hooks (the
// settings provider, useSession, etc.) — none of them are useful
// to prerender, and trying to do so trips Next's static export
// when better-auth's React adapter can't get a dispatcher.
export const dynamic = 'force-dynamic';

export default function BusinessLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <BusinessSettingsProvider>
        <DashboardFiltersProvider>
          <ActingStoreProvider>
            <ImpersonationBanner />
            <ChatProvider>
              <AppShell>{children}</AppShell>
            </ChatProvider>
          </ActingStoreProvider>
        </DashboardFiltersProvider>
      </BusinessSettingsProvider>
    </AuthGate>
  );
}
