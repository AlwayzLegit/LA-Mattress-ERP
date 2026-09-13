'use client';

import { useRef, useState } from 'react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { Alert, Button, Dialog, Field, Select } from '@/components/ui';
import { fmtDay, pluralize } from './order-format';

const REASONS = [
  'Customer changed mind',
  'Duplicate order',
  'Could not fulfil by promised date',
  'Pricing error',
  'Other',
];

/**
 * Cancel confirm (canvas 5d): `role=alertdialog`, the sentence names
 * the deposit's destination, the reserved lines going back to stock and
 * the delivery leaving the board; Reason is required; **Keep order** is
 * the default focus so Enter never cancels by accident.
 */
export function CancelOrderDialog({
  order,
  customerName,
  deliveryDate,
  onClose,
  onDone,
}: {
  order: {
    id: string;
    number: string;
    paidCents: number;
    lines: { quantity: number; qtyReserved: number; lineType: string }[];
  };
  customerName: string;
  /** The scheduled (or promised) delivery date, if the order is on the board. */
  deliveryDate: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [depositTo, setDepositTo] = useState<'store_credit' | 'original'>('store_credit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reservedLines = order.lines.filter(
    (l) => l.lineType !== 'custom' && l.qtyReserved > 0,
  ).length;
  const sentence = [
    order.paidCents > 0
      ? `The ${formatMoney(order.paidCents)} already paid ${
          depositTo === 'store_credit'
            ? `becomes store credit for ${customerName}`
            : 'is refunded to the original tender'
        }.`
      : 'Nothing has been paid.',
    reservedLines > 0
      ? `${pluralize(reservedLines, 'reserved line')} return to stock at their source.`
      : '',
    deliveryDate ? `The delivery on ${fmtDay(deliveryDate)} is removed from the board.` : '',
    'This is written to the change history and cannot be undone.',
  ]
    .filter(Boolean)
    .join(' ');

  async function confirm() {
    if (!reason) {
      setError('Pick a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/orders/${order.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason, depositTo: order.paidCents > 0 ? depositTo : null }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      alert
      size="sm"
      title={`Cancel ${order.number}?`}
      description={sentence}
      onClose={onClose}
      initialFocus={keep}
      testId="cancel-order-dialog"
      foot={
        <>
          <Button ref={keep} onClick={onClose} disabled={busy} data-testid="keep-order">
            Keep order
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            disabled={busy}
            data-testid="confirm-cancel-order"
          >
            {busy ? 'Cancelling…' : 'Cancel order'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Reason" required>
          <Select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="cancel-reason"
            required
          >
            <option value="">Choose…</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        {order.paidCents > 0 && (
          <Field label="Deposit">
            <Select
              value={depositTo}
              onChange={(e) => setDepositTo(e.target.value as 'store_credit' | 'original')}
              data-testid="cancel-deposit-to"
            >
              <option value="store_credit">Store credit for {customerName}</option>
              <option value="original">Refund to original tender</option>
            </Select>
          </Field>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
