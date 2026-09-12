'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, LinkButton, PageHeader, Skeleton, Stack } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/auth-client';
import { useDashboardFilters } from '@/lib/dashboard-filters';
import { DashboardControls } from '@/components/shell/dashboard-controls';
import ManagerDashboardView from './manager-dashboard';
import OperationsDashboardView from './operations-dashboard';
import WarehouseDashboardView from './warehouse-dashboard';
import MyDayDashboardView from './my-day-dashboard';
import OwnerHome from './owner/owner-home';

interface ChecklistStep {
  key: string;
  label: string;
  done: boolean;
  href: string;
}
interface Checklist {
  businessId: string;
  steps: ChecklistStep[];
  complete: boolean;
}

interface Me {
  roleName: string | null;
  managerDashboard: boolean;
  operationsDashboard: boolean;
  warehouseDashboard: boolean;
  cashierDashboard: boolean;
}

/**
 * /dashboard: picks the home for the signed-in member. Fixed-by-role
 * homes (Operations, Warehouse, Cashier) and the per-member manager
 * toggle win as before; an Owner can preview every home from the
 * topbar's role switch (redesign 2026-09-04).
 */
export default function DashboardClient() {
  const session = useSession();
  const router = useRouter();
  const filters = useDashboardFilters();
  const [checklist, setChecklist] = useState<Checklist | null | 'no-business'>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!session.data) return;
    void (async () => {
      try {
        const result = await api<Checklist | null>('/v1/onboarding/checklist');
        if (result == null) {
          // Fresh signup with no memberships → punt to /welcome.
          router.replace('/welcome');
          setChecklist('no-business');
        } else {
          setChecklist(result);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [session.data, router]);

  const businessActive = checklist != null && checklist !== 'no-business';

  useEffect(() => {
    if (!businessActive) return;
    void api<Me>('/v1/business/members/me')
      .then(setMe)
      .catch(() =>
        setMe({
          roleName: null,
          managerDashboard: false,
          operationsDashboard: false,
          warehouseDashboard: false,
          cashierDashboard: false,
        }),
      );
  }, [businessActive]);

  if (session.isPending) {
    return (
      <Stack gap="sm">
        <Skeleton style={{ height: 28, width: 260 }} />
        <Skeleton style={{ height: 16, width: 200 }} />
        <Skeleton style={{ height: 120 }} />
      </Stack>
    );
  }

  if (!session.data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Alert
          tone="info"
          action={
            <LinkButton size="sm" variant="primary" href="/login">
              Sign in
            </LinkButton>
          }
        >
          You are not signed in.
        </Alert>
      </>
    );
  }

  const userName = session.data.user.name ?? session.data.user.email;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!businessActive || !me) {
    // Still resolving the business / member: the greeting shows straight
    // away (a member with no business is redirected to /welcome from here).
    return (
      <Stack gap="sm">
        <PageHeader
          title={`Welcome, ${userName}`}
          sub={
            <span data-testid="dashboard-email">
              Signed in as <strong>{session.data.user.email}</strong>
            </span>
          }
        />
        <Skeleton style={{ height: 120 }} />
      </Stack>
    );
  }

  const fixed = me.operationsDashboard
    ? 'ops'
    : me.warehouseDashboard
      ? 'warehouse'
      : me.cashierDashboard
        ? 'cashier'
        : me.managerDashboard
          ? 'manager'
          : 'owner';
  const view = me.roleName === 'Owner' ? (filters.roleView ?? 'owner') : fixed;

  const home =
    view === 'ops' ? (
      <OperationsDashboardView userName={userName} />
    ) : view === 'warehouse' ? (
      <WarehouseDashboardView userName={userName} />
    ) : view === 'cashier' ? (
      <MyDayDashboardView userName={userName} />
    ) : view === 'manager' ? (
      <ManagerDashboardView userName={userName} />
    ) : (
      <OwnerHome userName={userName} email={session.data.user.email} />
    );
  return (
    <>
      {view !== 'cashier' && <DashboardControls />}
      {home}
    </>
  );
}
