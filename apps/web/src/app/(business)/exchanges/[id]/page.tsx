'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  KeyValue,
  LinkButton,
  LoadingRows,
  PageHeader,
  StatusBadge,
  TableWrap,
} from '@/components/ui';

interface ExchangeDetail {
  id: string;
  number: string;
  status: string;
  evenExchange: boolean;
  restockingFeeCents: number;
  restockingFeeOverridden: boolean;
  returnId: string;
  rmaNumber: string | null;
  returnStatus: string | null;
  returnCents: number;
  saleOrderId: string;
  saleOrderNumber: string | null;
  saleOrderStatus: string | null;
  originalOrderId: string | null;
  originalOrderNumber: string | null;
  referencedOrderNumber: string | null;
  customerName: string | null;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  splitAt: string | null;
  settlement: {
    returnCents: number;
    restockingFeeCents: number;
    creditCents: number;
    saleTotalCents: number;
    salePaidCents: number;
    saleBalanceDueCents: number;
  };
  returnSalespersonName?: string | null;
  fulfillment?: string;
  refundTender?: string;
  ticketPrintCount?: number;
}

export default function ExchangeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [exchange, setExchange] = useState<ExchangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setExchange(await api<ExchangeDetail>(`/v1/exchanges/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const eyebrow = <BackLink href="/exchanges">All exchanges</BackLink>;

  if (error) {
    return (
      <div>
        <PageHeader title="Exchange not found" eyebrow={eyebrow} />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!exchange) {
    return (
      <div>
        <PageHeader title="Exchange" eyebrow={eyebrow} />
        <LoadingRows rows={4} />
      </div>
    );
  }

  const s = exchange.settlement;
  const canSettle = exchange.status === 'open' && exchange.returnStatus === 'authorized';
  const canEdit = ['open', 'on_hold'].includes(exchange.status);

  return (
    <div>
      <PageHeader
        eyebrow={eyebrow}
        title={<code>{exchange.number}</code>}
        meta={
          <>
            <StatusBadge status={exchange.status} />
            {exchange.evenExchange && <span>even exchange</span>}
          </>
        }
        sub={`${exchange.customerName ?? '—'} · ${new Date(exchange.createdAt).toLocaleString()}`}
        actions={
          <>
            <LinkButton
              size="sm"
              variant="secondary"
              href={`/print/exchanges/${id}`}
              target="_blank"
              data-testid="print-exchange-ticket"
            >
              Print exchange ticket
            </LinkButton>
            {canEdit && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(`/v1/exchanges/${id}/split`)}
                  title="Dissolve into an independent return and order"
                >
                  Split exchange
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const reason = prompt('Reason for cancelling this exchange:');
                    if (reason != null) void act(`/v1/exchanges/${id}/cancel`, { reason });
                  }}
                >
                  Cancel
                </Button>
              </>
            )}
            {exchange.status === 'on_hold' && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void act(`/v1/exchanges/${id}/approve`)}
                data-testid="approve-exchange"
              >
                Approve (release hold)
              </Button>
            )}
            {canSettle && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void act(`/v1/order-returns/${exchange.returnId}/receive`)}
                data-testid="settle-exchange"
                title="Goods are back — settle the exchange"
              >
                Receive return & settle
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="The two legs">
          <KeyValue
            rows={[
              {
                label: 'Original order',
                value: exchange.originalOrderId ? (
                  <Link href={`/orders/${exchange.originalOrderId}`}>
                    <code>{exchange.originalOrderNumber}</code>
                  </Link>
                ) : (
                  <span title="Pre-cutover sale — number as claimed by the customer">
                    <code>{exchange.referencedOrderNumber ?? '—'}</code>{' '}
                    <span className="muted">(no original on file)</span>
                  </span>
                ),
              },
              {
                label: 'Return',
                value: (
                  <>
                    <code>{exchange.rmaNumber ?? '—'}</code>{' '}
                    {exchange.returnStatus && <StatusBadge status={exchange.returnStatus} />}
                  </>
                ),
              },
              {
                label: 'Replacement order',
                value: (
                  <>
                    <Link href={`/orders/${exchange.saleOrderId}`}>
                      <code>{exchange.saleOrderNumber}</code>
                    </Link>{' '}
                    {exchange.saleOrderStatus && <StatusBadge status={exchange.saleOrderStatus} />}
                  </>
                ),
              },
              ...(exchange.returnSalespersonName
                ? [{ label: 'Return salesperson', value: exchange.returnSalespersonName }]
                : []),
              {
                label: 'Goods come back by',
                value: exchange.fulfillment === 'pickup' ? 'Truck pickup' : 'Customer drop-off',
              },
              {
                label: 'Refund tender (excess credit)',
                value:
                  exchange.refundTender === 'original'
                    ? 'Original tenders'
                    : exchange.refundTender === 'cash'
                      ? 'Cash'
                      : exchange.refundTender === 'check'
                        ? 'Check'
                        : 'Store credit',
              },
              ...(exchange.notes ? [{ label: 'Notes', value: exchange.notes }] : []),
            ]}
          />
        </Card>

        <Card
          title="Settlement"
          description="Settlement rides the store-credit ledger: at receipt the credit is issued and applied to the replacement. Credit beyond the replacement's balance stays on the customer's store credit. Take the remaining balance on the replacement order page like any other order."
        >
          <TableWrap>
            <table className="table">
              <tbody>
                <tr>
                  <td>Return credit</td>
                  <td className="num">
                    <Money cents={s.returnCents} />
                  </td>
                </tr>
                <tr>
                  <td>
                    Restocking fee
                    {exchange.restockingFeeOverridden && (
                      <span className="muted" title="Overridden — no longer auto-calculated">
                        {' '}
                        (overridden)
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {s.restockingFeeCents > 0 ? (
                      <>
                        −<Money cents={s.restockingFeeCents} />
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                <tr>
                  <td>Credit toward replacement</td>
                  <td className="num">
                    <Money cents={s.creditCents} />
                  </td>
                </tr>
                <tr>
                  <td>Replacement total</td>
                  <td className="num">
                    <Money cents={s.saleTotalCents} />
                  </td>
                </tr>
                <tr>
                  <td>Paid so far (credit + tenders)</td>
                  <td className="num">
                    <Money cents={s.salePaidCents} />
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>Balance due</strong>
                  </td>
                  <td className="num" data-testid="exchange-balance-due">
                    <strong>
                      <Money cents={s.saleBalanceDueCents} />
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
    </div>
  );
}
