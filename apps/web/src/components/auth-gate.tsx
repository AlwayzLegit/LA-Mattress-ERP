'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/lib/auth-client';
import { Skeleton } from '@/components/ui';

/**
 * Gates the (business) shell on the session probe so logged-out
 * visitors never see the sidebar/topbar flash before a page-level
 * "not signed in" state resolves.
 *
 * Fail-open on probe errors: an offline register (POS service
 * worker) can't reach the session endpoint at all — that's not a
 * sign-out, so the shell still renders and the offline flows keep
 * working. Only a definitive "no session" answer redirects.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const signedOut = !session.isPending && !session.data && !session.error;

  useEffect(() => {
    if (signedOut) router.replace('/login');
  }, [signedOut, router]);

  if (session.isPending || signedOut) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg)' }}>
        {/* Skeleton in the shell's final positions: sidebar, topbar, page. */}
        <div
          aria-hidden
          style={{
            width: 'var(--sidebar-width)',
            borderRight: '1px solid var(--border)',
            background: 'var(--surface)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <Skeleton style={{ height: 24, width: 120 }} />
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} style={{ height: 14, width: i % 3 === 0 ? 90 : 140 }} />
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            aria-hidden
            style={{
              height: 'var(--topbar-height)',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 16px',
            }}
          >
            <Skeleton style={{ height: 24, width: 160 }} />
            <span style={{ flex: 1 }} />
            <Skeleton style={{ height: 24, width: 200 }} />
          </div>
          <div style={{ padding: 24 }}>
            <p role="status" className="sr-only">
              {signedOut ? 'Redirecting to sign in…' : 'Loading your workspace'}
            </p>
            <Skeleton style={{ height: 28, width: 220, marginBottom: 16 }} />
            <Skeleton style={{ height: 120, marginBottom: 12 }} />
            <Skeleton style={{ height: 220 }} />
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
