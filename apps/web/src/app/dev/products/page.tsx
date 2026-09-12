'use client';

import { useEffect, useState } from 'react';
import { BusinessSettingsProvider } from '@/lib/business-settings';
import ProductsPage from '@/app/(business)/products/page';
import { installProductsStub } from './stub';

/** Products browser on fixtures (redesign Phase 7). */
export default function ProductsPreview() {
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
        <ProductsPage />
      </div>
    </BusinessSettingsProvider>
  );
}
