'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useCursorList } from '@/lib/use-cursor-list';
import {
  CustomerPicker,
  customerDisplayName,
  type CustomerRow,
} from '@/components/customer-picker';
import { LoadMore } from '@/components/load-more';
import { Money } from '@/components/money';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  PageHeader,
  ResetColumns,
  SectionHeading,
  Select,
  Stack,
  StatusBadge,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';

interface ReturnRow {
  id: string;
  orderId: string | null;
  referencedOrderNumber: string | null;
  rmaNumber: string;
  status: string;
  refundMethod: string;
  amountCents: number;
  authorizedAt: string;
  completedAt: string | null;
  lines: { id: string; description: string | null; quantity: number; perUnitCents: number }[];
}

interface ReasonCode {
  id: string;
  code: string;
  description: string;
}

interface LocationRow {
  id: string;
  name: string;
  isActive: boolean;
}

interface DraftLine {
  variantId: string;
  description: string;
  quantity: string;
  refund: string;
}

/**
 * Returns register: every return document (with-order RMAs and
 * no-original returns), plus the SEC-RTN-NOORIG entry form for a
 * customer with no findable invoice. Store-credit only; goods go to
 * As-Is review; a non-manager finishes through the override dialog.
 */
const RETURN_COLUMNS: ColumnDef<ReturnRow>[] = [
  {
    id: 'rma',
    label: 'RMA',
    sortValue: (r) => r.rmaNumber,
    render: (r) => <code>{r.rmaNumber}</code>,
  },
  {
    id: 'order',
    label: 'Order',
    sortValue: (r) => (r.orderId ? 'a' : 'b'),
    render: (r) =>
      r.orderId ? (
        <Link href={`/orders/${r.orderId}`}>View order</Link>
      ) : (
        <span className="muted">
          No original
          {r.referencedOrderNumber ? ` (claimed ${r.referencedOrderNumber})` : ''}
        </span>
      ),
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => r.status,
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    id: 'refund',
    label: 'Refund',
    sortValue: (r) => r.refundMethod,
    render: (r) => (r.refundMethod === 'store_credit' ? 'Store credit' : 'Original tender'),
  },
  {
    id: 'amount',
    label: 'Amount',
    num: true,
    sortValue: (r) => r.amountCents,
    render: (r) => <Money cents={r.amountCents} />,
  },
  {
    id: 'authorized',
    label: 'Authorized',
    className: 'nowrap',
    sortValue: (r) => r.authorizedAt,
    render: (r) => new Date(r.authorizedAt).toLocaleString(),
  },
];

export default function ReturnsPage() {
  const list = useCursorList<ReturnRow>('/v1/order-returns');
  const { rows, error } = list;
  const cols = useListColumns('returns', RETURN_COLUMNS, rows);

  useEffect(() => {
    void list.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader title="Returns" />
      <Stack>
        <NoOriginalCard onChanged={() => list.load()} />
        {error && <Alert tone="error">{error}</Alert>}
        {rows == null ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState title="No return documents yet">
            Returns authorized from an order, and no-original returns written above, show up here.
          </EmptyState>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="returns" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.id}>
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
            <LoadMore state={list} noun="returns" />
          </Card>
        )}
      </Stack>
    </div>
  );
}

function NoOriginalCard({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [referenced, setReferenced] = useState('');
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<
    { variantId: string; productName: string; variantName: string | null; sku: string | null }[]
  >([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<LocationRow[]>('/v1/business/locations')
      .then((locs) => {
        const active = locs.filter((l) => l.isActive);
        setLocations(active);
        if (active[0]) setLocationId((prev) => prev || active[0]!.id);
      })
      .catch(() => setLocations([]));
    api<ReasonCode[]>('/v1/reason-codes?usageClass=return')
      .then(setReasonCodes)
      .catch(() => setReasonCodes([]));
  }, []);

  async function searchVariants() {
    if (!search.trim()) return;
    try {
      setResults(
        await api<
          {
            variantId: string;
            productName: string;
            variantName: string | null;
            sku: string | null;
          }[]
        >(`/v1/pos/lookup?q=${encodeURIComponent(search.trim())}&limit=200`),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function buildBody() {
    return {
      customerId: customer?.id,
      locationId,
      referencedOrderNumber: referenced.trim() || null,
      reason: reason || null,
      lines: lines.map((l) => ({
        variantId: l.variantId,
        quantity: Number(l.quantity),
        unitRefundCents: Math.round(Number(l.refund) * 100),
        ...(reasonCodeId ? { reasonCodeId } : {}),
      })),
    };
  }

  function validate(): boolean {
    if (!customer) {
      toast.error('Pick (or create) the customer — they receive the store credit.');
      return false;
    }
    if (!locationId) {
      toast.error('Pick the location taking the goods back.');
      return false;
    }
    if (lines.length === 0) {
      toast.error('Add at least one item.');
      return false;
    }
    for (const l of lines) {
      const q = Number(l.quantity);
      const r = Math.round(Number(l.refund) * 100);
      if (!Number.isInteger(q) || q <= 0 || !Number.isFinite(r) || r < 0) {
        toast.error(`Enter a quantity and refund amount for ${l.description}.`);
        return false;
      }
    }
    if (reasonCodes.length > 0 && !reasonCodeId) {
      toast.error('Select a return reason.');
      return false;
    }
    return true;
  }

  function reset() {
    setCustomer(null);
    setReferenced('');
    setReason('');
    setLines([]);
  }

  async function submit() {
    if (!validate() || busy) return;
    setBusy(true);
    try {
      const res = await api<{ rmaNumber: string; amountCents: number }>(
        '/v1/order-returns/no-original',
        { method: 'POST', body: JSON.stringify(buildBody()) },
      );
      toast.success(
        `${res.rmaNumber} completed — ${(res.amountCents / 100).toFixed(2)} in store credit issued; goods staged in As-Is review.`,
      );
      reset();
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED') {
        setOverrideOpen(true);
      } else {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const total = lines.reduce((s, l) => {
    const cents = Math.round(Number(l.refund) * 100);
    const q = Number(l.quantity);
    return s + (Number.isFinite(cents) && Number.isInteger(q) ? cents * q : 0);
  }, 0);

  return (
    <Card
      title="Return without an original invoice"
      description={
        <>
          For a customer whose invoice can&apos;t be found (pre-cutover sale, lost paperwork). Try
          the invoice lookup on <Link href="/sales">Sales</Link> first — every imported STORIS
          invoice is refundable normally. This path refunds as <strong>store credit only</strong>,
          stages the goods in As-Is review, and is logged for loss prevention.
        </>
      }
    >
      <SecurityOverrideDialog
        open={overrideOpen}
        title="No-original return — manager approval needed"
        usageClass="exception"
        submitLabel="Approve return"
        perform={(payload) =>
          api('/v1/order-returns/no-original', {
            method: 'POST',
            body: JSON.stringify({ ...buildBody(), override: payload.override }),
          }).then(() => undefined)
        }
        onClose={() => setOverrideOpen(false)}
        onSuccess={() => {
          reset();
          void onChanged();
        }}
      />
      {pickingCustomer && (
        <CustomerPicker
          onPick={(c) => {
            setCustomer(c);
            setPickingCustomer(false);
          }}
          onCancel={() => setPickingCustomer(false)}
        />
      )}

      <FormGrid cols={2}>
        <Field label="Customer (receives the credit)" required>
          <Button variant="secondary" size="sm" onClick={() => setPickingCustomer(true)}>
            {customer ? customerDisplayName(customer) : 'Pick or create customer'}
          </Button>
        </Field>
        <Field label="Location" required>
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Order # the customer claims (optional)" hint="Recorded verbatim">
          <Input value={referenced} onChange={(e) => setReferenced(e.target.value)} />
        </Field>
        {reasonCodes.length > 0 ? (
          <Field label="Return reason" required>
            <Select value={reasonCodeId} onChange={(e) => setReasonCodeId(e.target.value)}>
              <option value="">— Pick —</option>
              {reasonCodes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} — {r.description}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </FormGrid>

      <SectionHeading as="h3" title="Items coming back" />
      <Toolbar>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void searchVariants();
            }
          }}
          placeholder="Add item — name, SKU, or barcode"
          aria-label="Add item (name, SKU, or barcode)"
        />
        <Button variant="secondary" size="sm" onClick={() => void searchVariants()}>
          Search
        </Button>
      </Toolbar>
      {results.length === 200 && (
        <Alert tone="info">Many items match — refine your search to find the right one.</Alert>
      )}
      <Stack>
        {results.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {results.slice(0, 8).map((r) => (
              <Button
                key={r.variantId}
                size="sm"
                variant="ghost"
                disabled={lines.some((l) => l.variantId === r.variantId)}
                onClick={() => {
                  setLines((prev) => [
                    ...prev,
                    {
                      variantId: r.variantId,
                      description: [r.productName, r.variantName].filter(Boolean).join(' — '),
                      quantity: '1',
                      refund: '0.00',
                    },
                  ]);
                  setResults([]);
                  setSearch('');
                }}
              >
                + {[r.productName, r.variantName].filter(Boolean).join(' — ')}
                {r.sku ? ` (${r.sku})` : ''}
              </Button>
            ))}
          </div>
        )}

        {lines.length > 0 && (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Refund each ($)</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.variantId}>
                    <td>{l.description}</td>
                    <td className="num">
                      <Input
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                          )
                        }
                        className="w-[70px]"
                        aria-label={`Quantity for ${l.description}`}
                      />
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        value={l.refund}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, refund: e.target.value } : x)),
                          )
                        }
                        className="w-[90px]"
                        aria-label={`Refund each for ${l.description}`}
                      />
                    </td>
                    <td className="actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Stack>

      <FormActions
        start={
          total > 0 ? (
            <span>
              Store credit to issue: <Money cents={total} />
            </span>
          ) : undefined
        }
      >
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          <Undo2 size={14} />
          {busy ? 'Working…' : 'Complete return'}
        </Button>
      </FormActions>
    </Card>
  );
}
