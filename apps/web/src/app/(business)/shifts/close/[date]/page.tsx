'use client';

import { Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { LoadingRows } from '@/components/ui';
import CloseOutSheet from '../close-out-sheet';

/** `/shifts/close/:date` — the close-out sheet (Z-report), redesign Phase 10. */
export default function CloseOutPage() {
  // useSearchParams needs a Suspense boundary so the server and the first
  // client render agree on the store.
  return (
    <Suspense fallback={<LoadingRows rows={6} height={48} what="The close-out" />}>
      <CloseOutRoute />
    </Suspense>
  );
}

function CloseOutRoute() {
  const params = useParams<{ date: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const raw = Array.isArray(params.date) ? params.date[0] : params.date;
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 10);
  return (
    <CloseOutSheet
      date={date}
      locationId={search.get('locationId')}
      onNavigate={(next) =>
        router.push(
          `/shifts/close/${next.date}${next.locationId ? `?locationId=${encodeURIComponent(next.locationId)}` : ''}`,
        )
      }
    />
  );
}
