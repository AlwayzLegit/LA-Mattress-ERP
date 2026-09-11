'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PrintablePurchaseOrder, type PrintablePo } from '@/components/printable-purchase-order';
import { PrintToolbar } from '../print-toolbar';

/**
 * Batch "Print a Purchase Order" (A22 slice 7, STORIS): every PO that
 * matches the criteria — PO number, receiving location, vendor, status,
 * direct ships in or out, not-yet-printed only — page-broken, one vendor
 * document each. Printing records a print on every PO (reprints are
 * flagged in the toolbar), the same counter the single-PO print bumps.
 *
 * Query: ids (comma list) | number, locationId, vendorId, status,
 * directShip=0|1, printed=0|1.
 */

interface PoListRow {
  id: string;
  number: string;
  status: string;
  vendorName: string | null;
  createdAt: string;
  printCount?: number;
  directShip?: boolean;
}
interface PoDetail extends PrintablePo {
  id: string;
  status: string;
  printCount?: number;
  lastPrintedAt?: string | null;
}

function BatchPoPrintInner() {
  const search = useSearchParams();
  const [pos, setPos] = useState<PoDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printed, setPrinted] = useState(false);

  const ids = (search?.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const qs = new URLSearchParams();
  for (const key of ['number', 'locationId', 'vendorId', 'status', 'directShip', 'printed']) {
    const v = search?.get(key);
    if (v) qs.set(key, v);
  }
  const query = qs.toString();

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        let targetIds = ids;
        if (targetIds.length === 0) {
          const list = await api<{ data: PoListRow[] }>(
            `/v1/purchase-orders?limit=100${query ? `&${query}` : ''}`,
          );
          targetIds = list.data.map((r) => r.id);
        }
        const details = await Promise.all(
          targetIds.map((id) => api<PoDetail>(`/v1/purchase-orders/${id}`).catch(() => null)),
        );
        if (stale) return;
        setPos(details.filter((d): d is PoDetail => d != null));
      } catch (err) {
        if (!stale) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(','), query]);

  const reprints = (pos ?? []).filter((p) => (p.printCount ?? 0) > 0);

  async function printAll() {
    if (!pos || pos.length === 0) return;
    try {
      await Promise.all(
        pos.map((p) => api(`/v1/purchase-orders/${p.id}/print`, { method: 'POST' })),
      );
      setPrinted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    window.print();
  }

  return (
    <div style={{ background: '#fff', minHeight: '100vh', color: '#000' }}>
      <PrintToolbar
        backHref="/purchase-orders"
        onPrint={printAll}
        label={pos ? `Print ${pos.length} purchase order${pos.length === 1 ? '' : 's'}` : 'Print'}
        note={
          printed
            ? 'Prints recorded.'
            : reprints.length > 0
              ? `${reprints.length} of these were printed before (reprint): ${reprints.map((p) => p.number).join(', ')}`
              : 'Printing records a print on every purchase order.'
        }
      />
      {error && <p style={{ color: '#b00', padding: 16 }}>{error}</p>}
      {pos && pos.length === 0 && (
        <p style={{ padding: 16, fontFamily: 'Arial, sans-serif' }} data-testid="batch-po-empty">
          No purchase orders match.
        </p>
      )}
      {pos?.map((p) => (
        <div key={p.id} style={{ pageBreakAfter: 'always' }} data-testid="batch-po">
          {(p.printCount ?? 0) > 0 && (
            <div
              style={{
                fontFamily: 'Arial, sans-serif',
                fontSize: 11,
                fontWeight: 700,
                padding: '8px 24px 0',
              }}
            >
              REPRINT — printed {p.printCount} time(s)
              {p.lastPrintedAt ? `, last ${new Date(p.lastPrintedAt).toLocaleString()}` : ''}
            </div>
          )}
          <PrintablePurchaseOrder po={p} />
        </div>
      ))}
    </div>
  );
}

export default function BatchPoPrintPage() {
  return (
    <Suspense fallback={null}>
      <BatchPoPrintInner />
    </Suspense>
  );
}
