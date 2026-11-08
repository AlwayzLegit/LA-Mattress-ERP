'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useCursorList } from '@/lib/use-cursor-list';
import { LoadMore } from '@/components/load-more';
import { Money } from '@/components/money';
import { NoOriginalReturnForm, findOrderByNumber } from '@/components/no-original-return-form';
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

/**
 * Returns register: every return document (with-order RMAs and
 * no-original returns), plus the SEC-RTN-NOORIG entry form
 * (`NoOriginalReturnForm`, shared with New Exchange) for a customer with
 * no findable invoice. Store-credit only; goods go to As-Is review; a
 * non-manager finishes through the override dialog.
 */
function returnColumns(onVoid: (r: ReturnRow) => void): ColumnDef<ReturnRow>[] {
  return [
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
    {
      id: 'actions',
      label: 'Actions',
      srLabel: 'Actions',
      fixed: true,
      render: (r) =>
        !r.orderId && r.status === 'completed' ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`return-void-${r.rmaNumber}`}
            title="Entered by mistake? Takes the store credit back and voids the As-Is pieces"
            onClick={() => onVoid(r)}
          >
            Void
          </Button>
        ) : null,
    },
  ];
}

export default function ReturnsPage() {
  const list = useCursorList<ReturnRow>('/v1/order-returns');
  const { rows, error } = list;
  const [voiding, setVoiding] = useState<ReturnRow | null>(null);
  const columns = useMemo(() => returnColumns(setVoiding), []);
  const cols = useListColumns('returns', columns, rows);

  useEffect(() => {
    void list.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader title="Returns" />
      <SecurityOverrideDialog
        open={voiding != null}
        title={voiding ? `Void ${voiding.rmaNumber}?` : 'Void return'}
        usageClass="exception"
        submitLabel="Void return"
        perform={async (payload) => {
          const res = await api<{ creditReversedCents: number; piecesVoided: number }>(
            `/v1/order-returns/${voiding!.id}/void`,
            {
              method: 'POST',
              body: JSON.stringify({
                reasonCodeId: payload.reasonCodeId,
                reason: payload.reason,
                override: payload.override,
              }),
            },
          );
          toast.success(
            `${voiding!.rmaNumber} voided — $${(res.creditReversedCents / 100).toFixed(2)} store credit taken back, ${res.piecesVoided} As-Is piece(s) voided.`,
          );
        }}
        onClose={() => setVoiding(null)}
        onSuccess={() => void list.load()}
      />
      <Stack>
        <InvoiceReturnCard />
        <NoOriginalReturnForm mode="return" onCreated={() => list.load()} />
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

/**
 * Return from an invoice (owner 2026-10-02: a return for WE-10021 went
 * through the no-invoice form, which has no restocking fee, pickup fee
 * or driver pickup date). The order's own return form has all three —
 * this box finds the order by number and opens it at its Returns card.
 */
function InvoiceReturnCard() {
  const router = useRouter();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);

  async function open() {
    if (!number.trim() || busy) return;
    setBusy(true);
    try {
      const hit = await findOrderByNumber(number);
      if (!hit) {
        toast.error(
          `No order ${number.trim().toUpperCase()} — check the number, or use "Return without an original invoice" below.`,
        );
        return;
      }
      router.push(`/orders/${hit.id}/full#returns`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Return from an invoice"
      description="Type the invoice / order number. It opens that order's return form: pick the items, the refund, a restocking fee, a pickup fee, and the pickup date that puts the stop on the drivers' calendar."
      data-testid="invoice-return"
    >
      <Toolbar>
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void open();
            }
          }}
          placeholder="Invoice # — e.g. WE-10021"
          aria-label="Invoice or order number"
          data-testid="invoice-return-number"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void open()}
          disabled={busy || !number.trim()}
          data-testid="invoice-return-open"
        >
          {busy ? 'Finding…' : 'Start return'}
        </Button>
      </Toolbar>
    </Card>
  );
}
