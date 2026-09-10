'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Paperclip, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { Alert, Button, Field, FormGrid, Input, Select, TableWrap } from '@/components/ui';
import { ActionDialog, errorText, money } from './dialog';
import { LinePicker } from './line-picker';
import type { ActionLine, ActionOrder, AttachmentRow, OpsLists } from './types';

const textarea: React.CSSProperties = {
  width: '100%',
  font: 'inherit',
  padding: 8,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
};

function DataList({ id, items }: { id: string; items: string[] | null | undefined }) {
  return (
    <datalist id={id}>
      {(items ?? []).map((x) => (
        <option key={x} value={x} />
      ))}
    </datalist>
  );
}

async function patchOrder(orderId: string, body: unknown): Promise<void> {
  await api(`/v1/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** STORIS "Miscellaneous Fees" (Step 4 Charges and Fees). */
export function FeesDialog({
  order,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const cents = (k: string) => Math.round(Number(String(data.get(k) ?? '0') || 0) * 100);
    setSaving(true);
    setError(null);
    try {
      await patchOrder(order.id, {
        deliveryFeeCents: cents('delivery'),
        installFeeCents: cents('install'),
        otherFeeCents: cents('other'),
        otherFeeLabel: String(data.get('otherLabel') ?? '').trim() || null,
      });
      await onSaved();
      toast.success('Fees updated');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDialog title={`Charges and fees — ${order.number}`} onClose={onClose}>
      <form onSubmit={submit} data-testid="fees-form">
        <FormGrid cols={2}>
          <Field label="Delivery fee ($)">
            <Input
              name="delivery"
              type="number"
              step="0.01"
              min={0}
              defaultValue={((order.deliveryFeeCents ?? 0) / 100).toFixed(2)}
              data-testid="fee-delivery"
            />
          </Field>
          <Field label="Installation fee ($)">
            <Input
              name="install"
              type="number"
              step="0.01"
              min={0}
              defaultValue={((order.installFeeCents ?? 0) / 100).toFixed(2)}
              data-testid="fee-install"
            />
          </Field>
          <Field label="Other fee ($)">
            <Input
              name="other"
              type="number"
              step="0.01"
              min={0}
              defaultValue={((order.otherFeeCents ?? 0) / 100).toFixed(2)}
              data-testid="fee-other"
            />
          </Field>
          <Field label="Other fee label (prints on the invoice)">
            <Input
              name="otherLabel"
              defaultValue={order.otherFeeLabel ?? ''}
              placeholder="e.g. Haul-away, Setup"
              data-testid="fee-other-label"
            />
          </Field>
        </FormGrid>
        <p className="muted">
          Fees join the total after tax and are never taxed. Recycling, removal and
          declined-foundation lines live on the Lines card.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="dialog-foot" style={{ margin: '12px -18px -14px', borderRadius: 0 }}>
          <Button type="submit" variant="primary" disabled={saving} data-testid="fees-save">
            {saving ? 'Saving…' : 'Save fees'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ActionDialog>
  );
}

/** STORIS "Enter a Discount on Multiple Lines" / "Group Pricing". */
export function MultiLineDiscountDialog({
  order,
  lines,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  lines: ActionLine[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(lines.map((l) => l.id)));
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = Number(value);
  const preview = (l: ActionLine) => {
    if (!Number.isFinite(v) || value === '') return null;
    const gross = l.quantity * l.unitPriceCents;
    return mode === 'percent'
      ? Math.min(gross, Math.round((gross * v) / 100))
      : Math.min(gross, Math.round(v * 100));
  };
  async function submit() {
    if (sel.size === 0) return setError('Pick at least one line');
    if (!Number.isFinite(v) || v < 0) return setError('Enter a discount');
    setSaving(true);
    setError(null);
    try {
      await api(`/v1/orders/${order.id}/lines/discount-multiple`, {
        method: 'POST',
        body: JSON.stringify({
          lineIds: [...sel],
          mode,
          value: mode === 'percent' ? v : Math.round(v * 100),
        }),
      });
      await onSaved();
      toast.success(`Discount applied to ${sel.size} line${sel.size === 1 ? '' : 's'}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDialog
      title="Discount on multiple lines"
      onClose={onClose}
      wide
      foot={
        <>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={saving}
            data-testid="multi-discount-apply"
          >
            {saving ? 'Applying…' : 'Apply discount'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <FormGrid cols={2}>
        <Field label="Discount as">
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'percent' | 'amount')}
            data-testid="multi-discount-mode"
          >
            <option value="percent">% of each line&apos;s price (group pricing)</option>
            <option value="amount">$ off each line</option>
          </Select>
        </Field>
        <Field label={mode === 'percent' ? 'Percent (0–100)' : 'Dollars off each line'}>
          <Input
            type="number"
            min={0}
            max={mode === 'percent' ? 100 : undefined}
            step={mode === 'percent' ? '0.5' : '0.01'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="multi-discount-value"
          />
        </Field>
      </FormGrid>
      <TableWrap>
        <table className="table" data-testid="multi-discount-lines">
          <thead>
            <tr>
              <th />
              <th>Line</th>
              <th className="num">Price</th>
              <th className="num">Current discount</th>
              <th className="num">New discount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const p = preview(l);
              return (
                <tr key={l.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={sel.has(l.id)}
                      aria-label={`Include ${l.description}`}
                      onChange={(e) =>
                        setSel((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(l.id);
                          else next.delete(l.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td>
                    {l.description} × {l.quantity}
                  </td>
                  <td className="num">{money(l.quantity * l.unitPriceCents)}</td>
                  <td className="num">{money(l.discountCents)}</td>
                  <td className="num">{sel.has(l.id) && p != null ? money(p) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      {error && <Alert tone="error">{error}</Alert>}
    </ActionDialog>
  );
}

/** STORIS "Additional Comments" (internal) and "View/Edit Exception Comments". */
export function NotesDialog({
  order,
  kind,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  kind: 'internal' | 'exception' | 'printed';
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial =
    kind === 'internal'
      ? order.internalNotes
      : kind === 'exception'
        ? order.exceptionNotes
        : order.notes;
  const [text, setText] = useState(initial ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title =
    kind === 'internal'
      ? 'Additional comments (internal — never printed)'
      : kind === 'exception'
        ? 'Exception comments'
        : 'Order notes (printed on the invoice)';
  const field =
    kind === 'internal' ? 'internalNotes' : kind === 'exception' ? 'exceptionNotes' : 'notes';
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await patchOrder(order.id, { [field]: text.trim() || null });
      await onSaved();
      toast.success('Saved');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDialog
      title={`${title} — ${order.number}`}
      onClose={onClose}
      foot={
        <>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
            data-testid={`notes-save-${kind}`}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {kind === 'exception' && (
        <p className="muted">
          Why this order&apos;s exceptions happened — price overrides, discounts, unlocks. The
          exception register shows these on the order&apos;s rows.
        </p>
      )}
      <textarea
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={textarea}
        data-testid={`notes-text-${kind}`}
      />
      {error && <Alert tone="error">{error}</Alert>}
    </ActionDialog>
  );
}

/** STORIS "Custom Order Information": label / value rows printed on the invoice. */
export function CustomInfoDialog({
  order,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<{ label: string; value: string }[]>(
    order.customInfoJson && order.customInfoJson.length > 0
      ? order.customInfoJson.map((r) => ({ ...r }))
      : [{ label: '', value: '' }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const clean = rows.filter((r) => r.label.trim() || r.value.trim());
      await patchOrder(order.id, { customInfo: clean.length > 0 ? clean : null });
      await onSaved();
      toast.success('Custom order information saved');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDialog
      title={`Custom order information — ${order.number}`}
      onClose={onClose}
      foot={
        <>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
            data-testid="custom-info-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <p className="muted">
        Fabric, dimensions, monogram, special instructions — printed under the lines.
      </p>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 8, marginBottom: 8 }}
        >
          <Input
            placeholder="Label"
            value={r.label}
            onChange={(e) =>
              setRows((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
            }
            data-testid="custom-info-label"
          />
          <Input
            placeholder="Value"
            value={r.value}
            onChange={(e) =>
              setRows((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }
            data-testid="custom-info-value"
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Remove row"
            onClick={() =>
              setRows((prev) =>
                prev.length === 1 ? [{ label: '', value: '' }] : prev.filter((_, j) => j !== i),
              )
            }
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setRows((prev) => [...prev, { label: '', value: '' }])}
        disabled={rows.length >= 40}
      >
        + Add row
      </Button>
      {error && <Alert tone="error">{error}</Alert>}
    </ActionDialog>
  );
}

/** STORIS "Trade/Designer Information". */
export function TradeDesignerDialog({
  order,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const td = order.tradeDesignerJson ?? {};
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const s = (k: string) => String(d.get(k) ?? '').trim() || null;
    const body = {
      name: s('name'),
      company: s('company'),
      phone: s('phone'),
      email: s('email'),
      note: s('note'),
    };
    setSaving(true);
    setError(null);
    try {
      await patchOrder(order.id, {
        tradeDesigner: Object.values(body).some(Boolean) ? body : null,
      });
      await onSaved();
      toast.success('Trade / designer saved');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDialog title={`Trade / designer information — ${order.number}`} onClose={onClose}>
      <form onSubmit={submit} data-testid="trade-form">
        <FormGrid cols={2}>
          <Field label="Designer / trade contact">
            <Input name="name" defaultValue={td.name ?? ''} data-testid="trade-name" />
          </Field>
          <Field label="Company">
            <Input name="company" defaultValue={td.company ?? ''} />
          </Field>
          <Field label="Phone">
            <Input name="phone" defaultValue={td.phone ?? ''} />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" defaultValue={td.email ?? ''} />
          </Field>
        </FormGrid>
        <Field label="Note (referral terms, project)">
          <textarea name="note" rows={3} defaultValue={td.note ?? ''} style={textarea} />
        </Field>
        <p className="muted">
          Trade pricing tiers are still an open decision; this records who referred the sale.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="dialog-foot" style={{ margin: '12px -18px -14px', borderRadius: 0 }}>
          <Button type="submit" variant="primary" disabled={saving} data-testid="trade-save">
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ActionDialog>
  );
}

/**
 * STORIS "Additional Line Item Details" — also Line Comments, Assign Rooms,
 * Assign Pieces, Prep Codes, Customer's Own Material, Direct Ship Details
 * and Maintain Linked Installation Line, all on one line.
 */
export function LineDetailsDialog({
  order,
  lines,
  initialLineId,
  lists,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  lines: ActionLine[];
  initialLineId?: string;
  lists: OpsLists;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [lineId, setLineId] = useState(initialLineId ?? '');
  const line = lines.find((l) => l.id === lineId) ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState<string[]>([]);
  const [prepInput, setPrepInput] = useState('');
  const [com, setCom] = useState(false);
  useEffect(() => {
    setPrep(line?.prepCodes ?? []);
    setCom(!!line?.comJson?.supplied);
    setPrepInput('');
  }, [line?.id, line?.prepCodes, line?.comJson?.supplied]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!line) return;
    const d = new FormData(e.currentTarget);
    const s = (k: string) => String(d.get(k) ?? '').trim() || null;
    const pieces = String(d.get('pieces') ?? '').trim();
    const body = {
      description: s('description') ?? line.description,
      comment: s('comment'),
      room: s('room'),
      pieces: pieces ? Number(pieces) : null,
      prepCodes: prep.length > 0 ? prep : null,
      com: com ? { description: s('comDescription') } : null,
      directShip:
        line.lineType === 'direct_ship'
          ? {
              vendorName: s('vendorName'),
              vendorOrderRef: s('vendorOrderRef'),
              trackingNumber: s('trackingNumber'),
              expectedDate: s('expectedDate'),
            }
          : undefined,
      needsInstall: d.get('needsInstall') === 'on',
    };
    setSaving(true);
    setError(null);
    try {
      await api(`/v1/orders/${order.id}/lines/${line.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await onSaved();
      toast.success('Line details saved');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  const addPrep = (code: string) => {
    const c = code.trim();
    if (!c) return;
    setPrep((p) => (p.some((x) => x.toLowerCase() === c.toLowerCase()) ? p : [...p, c]));
    setPrepInput('');
  };
  return (
    <ActionDialog title="Line details" onClose={onClose} wide testId="line-details-dialog">
      <LinePicker lines={lines} value={lineId} onChange={setLineId} />
      {line && (
        <form key={line.id} onSubmit={submit} data-testid="line-details-form">
          <FormGrid cols={2}>
            <Field label="Description (as printed)">
              <Input
                name="description"
                defaultValue={line.description}
                data-testid="line-description"
              />
            </Field>
            <Field label="Room (where it goes in the home)">
              <Input
                name="room"
                list="a20-rooms"
                defaultValue={line.room ?? ''}
                data-testid="line-room"
              />
              <DataList id="a20-rooms" items={lists.rooms} />
            </Field>
            <Field label="Pieces per unit (for the truck)">
              <Input
                name="pieces"
                type="number"
                min={1}
                max={99}
                defaultValue={line.pieces ?? ''}
                data-testid="line-pieces"
              />
            </Field>
            <Field label="Prep codes (warehouse instructions)">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {prep.map((c) => (
                  <span
                    key={c}
                    className="chip"
                    style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                  >
                    {c}
                    <button
                      type="button"
                      aria-label={`Remove ${c}`}
                      onClick={() => setPrep((p) => p.filter((x) => x !== c))}
                      style={{ border: 0, background: 'none', cursor: 'pointer' }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Input
                  list="a20-prep"
                  value={prepInput}
                  onChange={(e) => setPrepInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addPrep(prepInput);
                    }
                  }}
                  placeholder="Add a code"
                  data-testid="line-prep-input"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => addPrep(prepInput)}
                >
                  Add
                </Button>
              </div>
              <DataList id="a20-prep" items={lists.prepCodes} />
            </Field>
          </FormGrid>
          <Field label="Line comment (prints under the line on the invoice and delivery ticket)">
            <textarea
              name="comment"
              rows={3}
              defaultValue={line.comment ?? ''}
              style={textarea}
              data-testid="line-comment"
            />
          </Field>
          <FormGrid cols={2}>
            <Field label="Installation">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  name="needsInstall"
                  defaultChecked={line.needsInstall ?? false}
                  data-testid="line-install"
                />
                The order&apos;s installation fee covers this line
              </label>
            </Field>
            <Field label="Customer's own material (COM)">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={com}
                  onChange={(e) => setCom(e.target.checked)}
                  data-testid="line-com"
                />
                The customer supplies material for this line
              </label>
              {com && (
                <Input
                  name="comDescription"
                  defaultValue={line.comJson?.description ?? ''}
                  placeholder="What they supply (fabric, yardage, received on…)"
                  data-testid="line-com-description"
                  style={{ marginTop: 6 }}
                />
              )}
            </Field>
          </FormGrid>
          {line.lineType === 'direct_ship' && (
            <>
              <strong>Direct ship details</strong>
              <FormGrid cols={2}>
                <Field label="Vendor">
                  <Input
                    name="vendorName"
                    defaultValue={line.directShipJson?.vendorName ?? ''}
                    data-testid="ds-vendor"
                  />
                </Field>
                <Field label="Vendor order / confirmation #">
                  <Input
                    name="vendorOrderRef"
                    defaultValue={line.directShipJson?.vendorOrderRef ?? ''}
                  />
                </Field>
                <Field label="Tracking number">
                  <Input
                    name="trackingNumber"
                    defaultValue={line.directShipJson?.trackingNumber ?? ''}
                  />
                </Field>
                <Field label="Expected delivery">
                  <Input
                    name="expectedDate"
                    type="date"
                    defaultValue={line.directShipJson?.expectedDate ?? ''}
                  />
                </Field>
              </FormGrid>
            </>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="dialog-foot" style={{ margin: '12px -18px -14px', borderRadius: 0 }}>
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
              data-testid="line-details-save"
            >
              {saving ? 'Saving…' : 'Save line details'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </ActionDialog>
  );
}

/** STORIS "Split Merchandise Lines" — one line's quantity onto a new line. */
export function SplitLineDialog({
  order,
  lines,
  initialLineId,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  lines: ActionLine[];
  initialLineId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [lineId, setLineId] = useState(initialLineId ?? '');
  const line = lines.find((l) => l.id === lineId) ?? null;
  const [qty, setQty] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = line ? line.quantity - Math.max(1, line.qtyFulfilled) : 0;
  async function submit() {
    if (!line) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/v1/orders/${order.id}/lines/${line.id}/split`, {
        method: 'POST',
        body: JSON.stringify({ quantity: Number(qty) }),
      });
      await onSaved();
      toast.success("Line split — set the new line's fulfillment, date or room");
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDialog
      title="Split merchandise line"
      onClose={onClose}
      foot={
        <>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={saving || !line || line.quantity < 2}
            data-testid="split-line-apply"
          >
            {saving ? 'Splitting…' : 'Split line'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <LinePicker
        lines={lines}
        value={lineId}
        onChange={setLineId}
        filter={(l) => l.quantity > 1}
      />
      {line && (
        <Field label={`Units to move to a new line (1–${Math.max(1, line.quantity - 1)})`}>
          <Input
            type="number"
            min={1}
            max={Math.max(1, line.quantity - 1)}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            data-testid="split-line-qty"
          />
          <p className="muted">
            {line.quantity - Number(qty || 0)} stay on this line
            {line.qtyFulfilled > 0
              ? ` (${line.qtyFulfilled} already fulfilled must stay)`
              : ''}; {max > 0 ? '' : ''}
            reservations follow the units that leave only when this line holds more than it keeps.
            To move lines onto a separate order, use Split order… on the Lines card.
          </p>
        </Field>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </ActionDialog>
  );
}

/** STORIS "Add / Edit / View Attachments". */
export function AttachmentsDialog({
  order,
  lines,
  canEdit,
  onClose,
  onChanged,
}: {
  order: ActionOrder;
  lines: ActionLine[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: (count: number) => void;
}) {
  const [rows, setRows] = useState<AttachmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lineId, setLineId] = useState('');
  const [note, setNote] = useState('');
  const load = async () => {
    try {
      const r = await api<AttachmentRow[]>(`/v1/orders/${order.id}/attachments`);
      setRows(r);
      onChanged(r.length);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  async function upload(file: File) {
    if (file.size > 5 * 1024 * 1024) return setError('Attachments are limited to 5 MB each');
    setBusy(true);
    setError(null);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsDataURL(file);
      });
      await api(`/v1/orders/${order.id}/attachments`, {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          dataBase64,
          lineId: lineId || null,
          note: note.trim() || null,
        }),
      });
      setNote('');
      await load();
      toast.success(`Attached ${file.name}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove(att: AttachmentRow) {
    if (!confirm(`Remove ${att.name}?`)) return;
    setBusy(true);
    try {
      await api(`/v1/orders/${order.id}/attachments/${att.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      title={`Attachments — ${order.number}`}
      onClose={onClose}
      wide
      testId="attachments-dialog"
    >
      {error && <Alert tone="error">{error}</Alert>}
      {rows == null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nothing attached yet.</p>
      ) : (
        <TableWrap>
          <table className="table" data-testid="attachments-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Line</th>
                <th>Note</th>
                <th>By</th>
                <th className="num">Size</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      style={{
                        background: 'none',
                        border: 0,
                        padding: 0,
                        cursor: 'pointer',
                        color: 'var(--brand)',
                      }}
                      onClick={() =>
                        void downloadFile(
                          `/v1/orders/${order.id}/attachments/${a.id}`,
                          a.name,
                        ).catch((err) => setError(errorText(err)))
                      }
                      data-testid="attachment-open"
                    >
                      <Paperclip size={12} aria-hidden /> {a.name}
                    </button>
                  </td>
                  <td className="muted">
                    {lines.find((l) => l.id === a.lineId)?.description ?? '—'}
                  </td>
                  <td className="muted">{a.note ?? '—'}</td>
                  <td className="muted">
                    {a.uploadedBy ?? '—'} · {a.createdAt.slice(0, 10)}
                  </td>
                  <td className="num">{(a.sizeBytes / 1024).toFixed(0)} KB</td>
                  <td className="actions">
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${a.name}`}
                        onClick={() => void remove(a)}
                        disabled={busy}
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {canEdit && (
        <>
          <strong style={{ display: 'block', marginTop: 12 }}>Add attachment</strong>
          <FormGrid cols={2}>
            <LinePicker
              lines={lines}
              value={lineId}
              onChange={setLineId}
              label="Pin to a line (optional)"
            />
            <Field label="Note (optional)">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Signed quote, floor plan…"
              />
            </Field>
          </FormGrid>
          <input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.txt,.csv,.doc,.docx,.xls,.xlsx"
            disabled={busy || (rows?.length ?? 0) >= 25}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
            data-testid="attachment-file"
          />
          <p className="muted">PDF, images, text, Word or Excel; 5 MB each, 25 per order.</p>
        </>
      )}
    </ActionDialog>
  );
}
