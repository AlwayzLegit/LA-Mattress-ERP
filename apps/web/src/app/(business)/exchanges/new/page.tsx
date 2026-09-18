'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { NewSale } from '@/components/new-sale';
import {
  Alert,
  BackLink,
  Button,
  Card,
  Input,
  LoadingRows,
  PageHeader,
  Toolbar,
} from '@/components/ui';

/**
 * Enter an Exchange (PLAN-POS-OPERATIONS §10, owner 2026-09-18): the
 * New Sale register in exchange mode. Find the original invoice here;
 * the register then shows the Return section (what comes back), the
 * replacement lines with the same order details New Sale has (store,
 * fulfillment, promised date, salespeople, delivery charge, installation,
 * discount, notes, add-on chips) and the settlement block, and writes
 * the replacement order, the return and the exchange in one go.
 */
function NewExchangeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const originalOrderId = params.get('originalOrderId') ?? '';

  const [orderNumberQuery, setOrderNumberQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);

  async function findByNumber() {
    const q = orderNumberQuery.trim();
    if (!q) return;
    setFinding(true);
    setError(null);
    try {
      const page = await api<{ data: { id: string; number: string }[] }>(
        `/v1/orders?number=${encodeURIComponent(q)}`,
      );
      const hit = page.data?.[0];
      if (!hit) {
        setError(`No order matches "${q}". Pre-cutover exchange? Use Returns > No original first.`);
        return;
      }
      router.replace(`/exchanges/new?originalOrderId=${hit.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  }

  if (originalOrderId) {
    return (
      <div>
        <div style={{ marginBottom: 8 }}>
          <BackLink href="/exchanges">All exchanges</BackLink>
        </div>
        <NewSale exchangeOf={originalOrderId} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/exchanges">All exchanges</BackLink>}
        title="New exchange"
        sub="The return credits the replacement in one settlement — the customer pays (or keeps as store credit) only the difference."
      />
      <Card
        title="Original order"
        description="Pre-cutover sale with no order on file? Write the no-original return on the Returns page first, then bind it to a new order from the exchange detail — or ask a manager."
      >
        <Toolbar>
          <Input
            value={orderNumberQuery}
            onChange={(e) => setOrderNumberQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void findByNumber();
              }
            }}
            placeholder="Order number (SO-…)"
            aria-label="Order number"
            data-testid="exchange-original-query"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={finding}
            onClick={() => void findByNumber()}
          >
            <Search size={14} />
            Find
          </Button>
        </Toolbar>
        {error && <Alert tone="error">{error}</Alert>}
      </Card>
    </div>
  );
}

export default function NewExchangePage() {
  return (
    <Suspense fallback={<LoadingRows rows={4} />}>
      <NewExchangeInner />
    </Suspense>
  );
}
