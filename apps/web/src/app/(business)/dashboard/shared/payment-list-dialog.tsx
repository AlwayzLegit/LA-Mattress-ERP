'use client';

import { useFocusTrap, rowKeys } from '@/components/ui';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { api } from '@/lib/api';
import { ShimmerRows, usdWhole } from '../owner/owner-kit';
import { dayShort, docHref, plural, rangeLabel, stamp, tenderMeta } from './kit';
import type { PaymentListResponse, StorePeriod } from './types';

/**
 * Screen 3 — the payment list behind a tender row (hand-off 2026-09-10):
 * every payment of one method at one store in the period, with the
 * order, payment date, sale date, salesperson, type and amount. Rows
 * open the document.
 */
export function PaymentListDialog({
  locationId,
  locationName,
  timezone,
  method,
  period,
  onClose,
}: {
  locationId: string;
  locationName: string;
  timezone: string;
  method: string;
  period: StorePeriod;
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<PaymentListResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const meta = tenderMeta(method);

  useEffect(() => {
    setData(null);
    setFailed(false);
    void api<PaymentListResponse>(
      `/v1/dashboard/stores/${locationId}/payments?method=${encodeURIComponent(method)}&period=${period}`,
    )
      .then(setData)
      .catch(() => setFailed(true));
  }, [locationId, method, period]);

  // Escape, the focus trap and the return of focus come from the shared hook.
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, { onClose });

  const open = (kind: 'order' | 'sale' | 'service', id: string) => {
    onClose();
    router.push(docHref(kind, id));
  };

  return (
    <div className="overlay overlay-center" onClick={onClose} data-noprint="true">
      <div
        ref={panel}
        role="dialog"
        aria-modal
        aria-label={`${meta.label} payments · ${locationName}`}
        className="dialog"
        style={{ width: 680, maxHeight: '86vh' }}
        onClick={(e) => e.stopPropagation()}
        data-testid="payment-list-dialog"
      >
        <div className="dialog-head">
          <span
            className="tender-swatch"
            style={{ background: meta.swatch, width: 8, height: 8, marginRight: 0 }}
          />
          <h3>
            {meta.label} · {locationName}
          </h3>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            payments taken {data ? rangeLabel(data.range) : '…'}
          </span>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {failed && (
          <div className="dialog-body" style={{ color: 'var(--danger)' }}>
            The payment list could not be loaded.
          </div>
        )}
        {!data && !failed && <ShimmerRows rows={5} />}
        {data && data.rows.length === 0 && (
          <div
            className="dialog-body"
            style={{ color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', padding: 28 }}
          >
            No {meta.label.toLowerCase()} payments in this period.
          </div>
        )}
        {data && data.rows.length > 0 && (
          <table className="dt dt-static" data-testid="payment-list-table">
            <thead>
              <tr>
                <th className="first">Order</th>
                <th>Payment date</th>
                <th>Sale date</th>
                <th>Salesperson</th>
                <th>Type</th>
                <th className="last" style={{ textAlign: 'right' }}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr
                  {...rowKeys}
                  key={r.paymentId}
                  className="is-clickable"
                  onClick={() => open(r.docKind, r.docId)}
                  data-testid="payment-list-row"
                >
                  <td className="first">
                    <div className="mono">{r.docNumber}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {r.customerName ?? (r.docKind === 'sale' ? 'Register sale' : 'Walk-in')}
                    </div>
                  </td>
                  <td className="mono">{dayShort(r.paidAt, timezone)}</td>
                  <td className="mono" style={{ color: 'var(--muted)' }}>
                    {dayShort(r.soldAt, timezone)}
                  </td>
                  <td style={{ color: 'var(--text2)' }}>{r.salespersonName ?? '—'}</td>
                  <td>
                    <div>{r.kind}</div>
                    {method === 'cash' && (
                      <div
                        style={{
                          fontSize: 11.5,
                          color: r.receipt ? 'var(--accent-ink)' : 'var(--warn)',
                        }}
                      >
                        {r.receipt
                          ? `received ${stamp(r.receipt.receivedAt, timezone)} · ${r.receipt.byName}`
                          : 'awaiting pickup'}
                      </div>
                    )}
                  </td>
                  <td className="num last" style={{ fontWeight: 500 }}>
                    {usdWhole(r.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && (
          <div className="dialog-foot" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
            <span style={{ color: 'var(--muted)' }}>{plural(data.count, 'payment')}</span>
            <span>
              <span style={{ color: 'var(--muted)', marginRight: 8 }}>Total</span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {usdWhole(data.totalCents)}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
