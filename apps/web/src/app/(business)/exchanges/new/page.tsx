'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Search } from 'lucide-react';
import { formatMoney } from '@jetnine/shared';
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
  StatusBadge,
  TableWrap,
  Toolbar,
} from '@/components/ui';

/** `GET /v1/search` — the slice the picker reads. */
interface FoundOrder {
  id: string;
  number: string;
  legacyNumber?: string | null;
  status: string;
  totalCents: number;
  requestedDate: string | null;
  customerName: string | null;
  customerPhone?: string | null;
}
interface FoundCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  customerNumber: string | null;
}

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

  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [preCutover, setPreCutover] = useState(false);
  const [found, setFound] = useState<{ orders: FoundOrder[]; customers: FoundCustomer[] } | null>(
    null,
  );
  const [customerOrders, setCustomerOrders] = useState<{
    customer: FoundCustomer;
    orders: FoundOrder[];
  } | null>(null);

  // Owner 2026-11-10: the box took an order number only, so staff found the
  // order elsewhere and pasted it. It now takes whatever the customer can
  // tell you — number, name, phone, address — through the same search the
  // top bar uses; an exact order number still goes straight to the register.
  async function find() {
    const q = query.trim();
    if (!q) return;
    setFinding(true);
    setError(null);
    setCustomerOrders(null);
    try {
      const res = await api<{ orders: FoundOrder[]; customers: FoundCustomer[] }>(
        `/v1/search?q=${encodeURIComponent(q)}`,
      );
      const exact = res.orders.find(
        (o) =>
          o.number.toLowerCase() === q.toLowerCase() ||
          (o.legacyNumber ?? '').toLowerCase() === q.toLowerCase(),
      );
      if (exact) {
        router.replace(`/exchanges/new?originalOrderId=${exact.id}`);
        return;
      }
      setFound({ orders: res.orders, customers: res.customers });
      if (res.orders.length === 0 && res.customers.length === 0) {
        setError(
          `Nothing matches "${q}". Written in STORIS before the cutover? Use "Original invoice not on file" below.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  }

  async function showCustomerOrders(customer: FoundCustomer) {
    setFinding(true);
    setError(null);
    try {
      const page = await api<{ data: FoundOrder[] }>(
        `/v1/orders?customerId=${encodeURIComponent(customer.id)}&limit=50`,
      );
      setCustomerOrders({ customer, orders: page.data ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  }

  function pick(order: FoundOrder) {
    router.replace(`/exchanges/new?originalOrderId=${order.id}`);
  }

  function OrderRows({ orders, testId }: { orders: FoundOrder[]; testId: string }) {
    return (
      <TableWrap>
        <table className="table" data-testid={testId}>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Promised</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <strong>{o.number}</strong>
                  {o.legacyNumber ? <span className="muted"> · {o.legacyNumber}</span> : null}
                </td>
                <td>
                  {o.customerName ?? '—'}
                  {o.customerPhone ? <span className="muted"> · {o.customerPhone}</span> : null}
                </td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td>{o.requestedDate ?? '—'}</td>
                <td className="num">{formatMoney(o.totalCents)}</td>
                <td className="num">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => pick(o)}
                    data-testid={`exchange-pick-${o.number}`}
                  >
                    Exchange from this order
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    );
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
          description="Find the invoice the goods were sold on — by order number, customer name, phone or address. The register picks the delivered lines from it."
        >
          <Toolbar>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void find();
                }
              }}
              placeholder="Order number, customer name, phone or address"
              aria-label="Find the original order"
              data-testid="exchange-original-query"
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={finding}
              onClick={() => void find()}
            >
              <Search size={14} />
              Find
            </Button>
          </Toolbar>
          {error && <Alert tone="error">{error}</Alert>}
          {customerOrders ? (
            <div style={{ marginTop: 12 }}>
              <p className="muted" style={{ marginBottom: 6 }}>
                Orders for <strong>{customerOrders.customer.name}</strong>
                {customerOrders.customer.phone ? ` · ${customerOrders.customer.phone}` : ''}{' '}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomerOrders(null)}
                >
                  Back to matches
                </Button>
              </p>
              {customerOrders.orders.length === 0 ? (
                <p className="muted">No orders on file for this customer.</p>
              ) : (
                <OrderRows orders={customerOrders.orders} testId="exchange-customer-orders" />
              )}
            </div>
          ) : found && (found.orders.length > 0 || found.customers.length > 0) ? (
            <div style={{ marginTop: 12 }}>
              {found.orders.length > 0 && (
                <>
                  <p className="muted" style={{ marginBottom: 6 }}>
                    Matching orders
                    {found.orders.length >= 6
                      ? ' (newest 6 — pick a customer below for all of theirs)'
                      : ''}
                  </p>
                  <OrderRows orders={found.orders} testId="exchange-found-orders" />
                </>
              )}
              {found.customers.length > 0 && (
                <>
                  <p className="muted" style={{ margin: '12px 0 6px' }}>
                    Matching customers — pick one to see every order on file
                  </p>
                  <div className="flex flex-wrap gap-2" data-testid="exchange-found-customers">
                    {found.customers.map((c) => (
                      <Button
                        key={c.id}
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void showCustomerOrders(c)}
                      >
                        {c.name}
                        {c.phone ? ` · ${c.phone}` : ''}
                        {c.customerNumber ? ` · ${c.customerNumber}` : ''}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
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
