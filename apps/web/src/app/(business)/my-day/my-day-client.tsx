'use client';

import { useSession } from '@/lib/auth-client';
import { Alert, LinkButton, LoadingRows, PageHeader } from '@/components/ui';
import MyDayDashboardView from '../dashboard/my-day-dashboard';
import { CompetitionStrip } from '@/components/competition/competition-strip';

export default function MyDayPageClient() {
  const session = useSession();
  if (session.isPending) return <LoadingRows />;
  if (!session.data) {
    return (
      <>
        <PageHeader title="My Day" />
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
  return (
    <>
      <CompetitionStrip showLeads actorName={userName} />
      <MyDayDashboardView userName={userName} />
    </>
  );
}
