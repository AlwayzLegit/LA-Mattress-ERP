'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { NewSale } from '@/components/new-sale';
import { api } from '@/lib/api';

/**
 * POS home = New Sale, the single-screen order entry
 * (PLAN-POS-OPERATIONS §4; amendments A3/A4 — the step wizard and the
 * legacy quick-sale register are both retired; take-with rings through
 * here). Login lands here, so this page owns the same fresh-signup
 * bounce the dashboard has: no memberships → /welcome.
 */
export default function PosPage() {
  const router = useRouter();
  useEffect(() => {
    void api<unknown | null>('/v1/onboarding/checklist')
      .then((result) => {
        if (result == null) router.replace('/welcome');
      })
      .catch(() => undefined);
  }, [router]);

  return <NewSale />;
}
