'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, Field, FormGrid, Input } from '@/components/ui';
import { errorText, fmtDate } from './kit';
import type { AtpResult } from './types';

/**
 * Available to Promise (A21 D2): type the quantity a customer wants and
 * read when it could be promised — today when net available covers it,
 * else the expected date of the open PO that covers the shortfall. The
 * per-location answer feeds the grid's ATP columns through `onResult`.
 */
export function AtpCard({
  productId,
  onResult,
}: {
  productId: string;
  onResult: (res: AtpResult | null) => void;
}) {
  const [desired, setDesired] = useState('1');
  const [res, setRes] = useState<AtpResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(qty: string) {
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 1) {
      setError('Enter a whole number of 1 or more');
      return;
    }
    try {
      const next = await api<AtpResult>(`/v1/products/${productId}/activity/atp?quantity=${n}`);
      setRes(next);
      setError(null);
      onResult(next);
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    void run('1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  return (
    <Card
      title="Available to promise"
      description="Net available now, and the earliest date the desired quantity could be promised from stock plus open purchase orders."
      data-testid="product-atp"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(desired);
        }}
      >
        <FormGrid cols={3}>
          <Field label="Desired quantity">
            <Input
              type="number"
              min={1}
              step={1}
              value={desired}
              aria-label="Desired quantity"
              data-testid="atp-desired"
              onChange={(e) => setDesired(e.target.value)}
              onBlur={() => void run(desired)}
            />
          </Field>
          <Field label="ATP date">
            <Input
              readOnly
              value={res ? (res.total.atpDate ? fmtDate(res.total.atpDate) : 'No date') : ''}
              aria-label="ATP date"
              data-testid="atp-date"
            />
          </Field>
          <Field label="ATP quantity">
            <Input
              readOnly
              value={res ? String(res.total.atpQuantity) : ''}
              aria-label="ATP quantity"
              data-testid="atp-quantity"
            />
          </Field>
        </FormGrid>
        <div className="mt-2">
          <Button type="submit" variant="secondary" size="sm">
            Check
          </Button>
        </div>
      </form>
      {error && <p className="text-sm text-[var(--danger,#b00020)]">{error}</p>}
    </Card>
  );
}
