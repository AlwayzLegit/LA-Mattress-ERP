'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { NewSale } from '@/components/new-sale';
import { NoOriginalReturnForm } from '@/components/no-original-return-form';
import {
  Alert,
  BackLink,
  Button,
  Card,
  Input,
  LoadingRows,
  PageHeader,
  Stack,
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
 *
 * Second path (dispatcher 2026-11-06, STORIS 03109559 against invoice
 * 03108303 from before the cutover): the original is not on file, so the
 * no-original return is written first — STORIS invoice number, the items
 * coming back with their credit, truck pickup date or drop-off — and the
 * register opens against that return (`?returnId=`) for the replacement.
 */
function NewExchangeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const originalOrderId = params.get('originalOrderId') ?? '';
  const returnId = params.get('returnId') ?? '';

  const [orderNumberQuery, setOrderNumberQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [preCutover, setPreCutover] = useState(false);

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
        setError(
          `No order matches "${q}". Written in STORIS before the cutover? Use "Original invoice not on file" below.`,
        );
        return;
      }
      router.replace(`/exchanges/new?originalOrderId=${hit.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  }

  if (originalOrderId || returnId) {
    return (
      <div>
        <div style={{ marginBottom: 8 }}>
          <BackLink href="/exchanges">All exchanges</BackLink>
        </div>
        {originalOrderId ? (
          <NewSale exchangeOf={originalOrderId} />
        ) : (
          <NewSale exchangeReturnId={returnId} />
        )}
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
      <Stack>
        <Card
          title="Original order"
          description="Find the invoice the goods were sold on. The register picks the delivered lines from it."
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
        {preCutover ? (
          <NoOriginalReturnForm
            mode="exchange"
            onCreated={(ret) => {
              router.replace(`/exchanges/new?returnId=${ret.id}`);
            }}
          />
        ) : (
          <Card
            title="Original invoice not on file (STORIS)"
            description="Sold in STORIS before the cutover? There is no order to pick lines from. Enter the STORIS invoice number and what comes back (with the credit each item earns, and whether the truck picks it up), then write the replacement on the register — one exchange, one ticket, the credit netted. Needs a manager."
            data-testid="precutover-exchange-start"
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPreCutover(true)}
              data-testid="precutover-exchange-open"
            >
              Enter a pre-cutover exchange
            </Button>
          </Card>
        )}
      </Stack>
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
