'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Alert, Button, Field, FormGrid, Input, Select } from '@/components/ui';
import { ActionDialog, errorText } from './dialog';
import type { ActionOrder, OpsLists } from './types';

interface MemberRow {
  membershipId: string;
  name: string | null;
  email: string;
  status: string;
}

const FULFILLMENT = [
  ['delivery', 'Delivery'],
  ['pickup', 'Customer pickup'],
  ['take_with', 'Take-with'],
  ['direct_ship', 'Direct ship'],
] as const;
const DELIVERY_STATUS = [
  ['', '—'],
  ['scheduled', 'Scheduled'],
  ['estimated', 'Estimated'],
  ['asap', 'ASAP'],
  ['will_call', 'Will call'],
] as const;
const ORDER_KIND = [
  ['sales_order', 'Sales order'],
  ['layaway', 'Layaway ($100 minimum deposit)'],
  ['exchange', 'Exchange order'],
] as const;

const textarea: React.CSSProperties = {
  width: '100%',
  font: 'inherit',
  padding: 8,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
};

/**
 * STORIS "Additional Order Detail" + Step 1 Basic Information + Marketing
 * Information + Order Source Entry + Assign Payment Terminal + Deposits,
 * on one form. Everything is PATCH /v1/orders/:id; the money fields
 * (deposit required) pass the same validation the writer uses.
 */
export function OrderHeaderDialog({
  order,
  locations,
  lists,
  editable,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  locations: { id: string; name: string }[];
  lists: OpsLists;
  /** False while locked: only the metadata fields save. */
  editable: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<MemberRow[]>('/v1/business/members')
      .then((rows) => setMembers(rows.filter((m) => m.status === 'active')))
      .catch(() => setMembers([]));
  }, []);
  const memberLabel = (m: MemberRow) => m.name || m.email;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const s = (k: string) => String(d.get(k) ?? '').trim() || null;
    const meta = {
      marketingCode: s('marketingCode'),
      marketingCode2: s('marketingCode2'),
      orderSource: s('orderSource'),
      paymentTerminal: s('paymentTerminal'),
      deliveryInstructions: s('deliveryInstructions'),
      notes: s('notes'),
    };
    const body: Record<string, unknown> = { ...meta };
    if (editable) {
      const second = s('secondSalesperson');
      const split = String(d.get('splitPct') ?? '').trim();
      Object.assign(body, {
        orderKind: s('orderKind') ?? order.orderKind,
        fulfillmentType: s('fulfillmentType') ?? order.fulfillmentType,
        stockLocationId: s('stockLocationId'),
        pickupLocationId: s('pickupLocationId'),
        deliveryStatus: s('deliveryStatus'),
        requestedDate: s('requestedDate'),
        salespersonMembershipId: s('salesperson'),
        secondSalespersonMembershipId: second,
        splitBps: second ? Math.round(Number(split || '50') * 100) : null,
        depositRequiredCents: Math.round(Number(String(d.get('deposit') ?? '0') || 0) * 100),
      });
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/v1/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await onSaved();
      toast.success('Order details saved');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDialog
      title={`Order details — ${order.number}`}
      onClose={onClose}
      wide
      testId="order-header-dialog"
    >
      <form onSubmit={submit}>
        {!editable && (
          <Alert tone="warning">
            This order is locked or finished: attribution, source, terminal, instructions and
            printed notes still save; the rest is read-only.
          </Alert>
        )}
        <strong>Basic information</strong>
        <FormGrid cols={3}>
          <Field label="Order type">
            <Select
              name="orderKind"
              defaultValue={order.orderKind}
              disabled={!editable}
              data-testid="hdr-order-kind"
            >
              {ORDER_KIND.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Written">
            <Input value={new Date(order.createdAt).toLocaleString()} readOnly />
          </Field>
          <Field label="Store (selling location)">
            <Input
              value={locations.find((l) => l.id === order.locationId)?.name ?? order.locationId}
              readOnly
            />
          </Field>
          <Field label="Salesperson">
            <Select
              name="salesperson"
              defaultValue={order.salespersonMembershipId ?? ''}
              disabled={!editable}
              data-testid="hdr-salesperson"
            >
              <option value="">— none —</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {memberLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="2nd salesperson">
            <Select
              name="secondSalesperson"
              defaultValue={order.secondSalespersonMembershipId ?? ''}
              disabled={!editable}
            >
              <option value="">— none —</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {memberLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Primary's share of commission (%)">
            <Input
              name="splitPct"
              type="number"
              min={0}
              max={100}
              step="1"
              defaultValue={order.splitBps != null ? String(order.splitBps / 100) : '50'}
              disabled={!editable}
            />
          </Field>
          <Field label="Fulfillment method">
            <Select
              name="fulfillmentType"
              defaultValue={order.fulfillmentType}
              disabled={!editable}
              data-testid="hdr-fulfillment"
            >
              {FULFILLMENT.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fulfill from (inventory)">
            <Select
              name="stockLocationId"
              defaultValue={order.stockLocationId ?? ''}
              disabled={!editable}
            >
              <option value="">Selling location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pickup location">
            <Select
              name="pickupLocationId"
              defaultValue={order.pickupLocationId ?? ''}
              disabled={!editable}
            >
              <option value="">—</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Promised / requested date">
            <Input
              name="requestedDate"
              type="date"
              defaultValue={order.requestedDate ?? ''}
              disabled={!editable}
              data-testid="hdr-requested-date"
            />
          </Field>
          <Field label="Delivery status">
            <Select
              name="deliveryStatus"
              defaultValue={order.deliveryStatus ?? ''}
              disabled={!editable}
            >
              {DELIVERY_STATUS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deposit required ($)">
            <Input
              name="deposit"
              type="number"
              min={0}
              step="0.01"
              defaultValue={(order.depositRequiredCents / 100).toFixed(2)}
              disabled={!editable}
              data-testid="hdr-deposit"
            />
          </Field>
        </FormGrid>
        <strong>Marketing information</strong>
        <FormGrid cols={3}>
          <Field label="Marketing code 1">
            <Input
              name="marketingCode"
              list="a20-mkt"
              defaultValue={order.marketingCode ?? ''}
              data-testid="hdr-marketing-1"
            />
          </Field>
          <Field label="Marketing code 2">
            <Input
              name="marketingCode2"
              list="a20-mkt"
              defaultValue={order.marketingCode2 ?? ''}
              data-testid="hdr-marketing-2"
            />
          </Field>
          <Field label="Order source">
            <Input
              name="orderSource"
              list="a20-src"
              defaultValue={order.orderSource ?? ''}
              placeholder="Walk-in, Phone, Web…"
              data-testid="hdr-order-source"
            />
          </Field>
          <Field label="Payment terminal (card reader)">
            <Input
              name="paymentTerminal"
              list="a20-term"
              defaultValue={order.paymentTerminal ?? ''}
              data-testid="hdr-terminal"
            />
          </Field>
        </FormGrid>
        <datalist id="a20-mkt">
          {(lists.marketingCodes ?? []).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <datalist id="a20-src">
          {(lists.orderSources ?? []).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <datalist id="a20-term">
          {(lists.paymentTerminals ?? []).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <FormGrid cols={2}>
          <Field label="Delivery / pickup instructions">
            <textarea
              name="deliveryInstructions"
              rows={3}
              defaultValue={order.deliveryInstructions ?? ''}
              style={textarea}
            />
          </Field>
          <Field label="Order notes (printed on the invoice)">
            <textarea
              name="notes"
              rows={3}
              defaultValue={order.notes ?? ''}
              style={textarea}
              data-testid="hdr-notes"
            />
          </Field>
        </FormGrid>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="dialog-foot" style={{ margin: '12px -18px -14px', borderRadius: 0 }}>
          <Button type="submit" variant="primary" disabled={saving} data-testid="hdr-save">
            {saving ? 'Saving…' : 'Save order details'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ActionDialog>
  );
}
