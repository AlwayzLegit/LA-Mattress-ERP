'use client';

import { useEffect, useState } from 'react';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import ProductPage from '@/app/(business)/products/[id]/page';
import { installProductsStub } from '../stub';

/** Product page on fixtures (redesign Phase 7): /dev/products/p1. */
export default function ProductPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installProductsStub();
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <BusinessSettingsProvider>
      <div
        className="mx-auto w-full max-w-[1560px] px-[22px] pb-12 pt-[22px]"
        style={{ background: 'var(--bg)', minHeight: '100vh' }}
      >
        <div className="t-mono-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
          PREVIEW · FIXTURES FROM THE PROTOTYPE · NOTHING IS SAVED
        </div>
        <ProductPage />
      </div>
    </BusinessSettingsProvider>
  );
}
