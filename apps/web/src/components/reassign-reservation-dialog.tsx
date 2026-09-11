'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ModalDialog } from '@/components/modal-dialog';
import {
  Alert,
  Button,
  Field,
  FormActions,
  FormGrid,
  Input,
  LoadingRows,
  Select,
  StatGrid,
  StatTile,
  StatusBadge,
  TableEmpty,
  TableWrap,
} from '@/components/ui';

/**
 * STORIS "Reassign Reservation" (A22 slice 3): one product at one
 * location, every open order line that wants it, and the two moves —
 * reserve available units onto a line, or back-order a line's reserved
 * units so another customer can have the piece today. Reserving when
 * nothing is free lets the manager pick the order to take the units
 * from; both sides update in one request.
 */

export interface ReservationBoardRow {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  orderKind: string;
  fulfillmentType: string | null;
  deliveryStatus: string | null;
  orderDate: string;
  fillBy: string | null;
  customerName: string | null;
  lineId: string;
  description: string;
  quantity: number;
  qtyReserved: number;
  qtyFulfilled: number;
  shortfall: number;
}

export interface ReservationBoard {
  strip: { onHand: number; reserved: number; floorSample: number; available: number };
  rows: ReservationBoardRow[];
}

type Action = 'reserve' | 'back_order';

export function fmtDay(d: string | null | undefined): string {
  if (!d) return '—';
  const day = d.length >= 10 ? d.slice(0, 10) : d;
  const [y, m, dd] = day.split('-');
  return y && m && dd ? `${m}/${dd}/${y}` : d;
}

export function ReassignReservationDialog({
  open,
  variantId,
  locationId,
  itemLabel,
  onClose,
  onChanged,
}: {
  open: boolean;
  variantId: string;
  locationId: string;
  /** "SKU — product name" for the title. */
  itemLabel: string;
  onClose: () => void;
  /** Stock changed hands — the caller refreshes its own numbers. */
  onChanged?: () => void;
}) {
  const [board, setBoard] = useState<ReservationBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<{ row: ReservationBoardRow; action: Action } | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [fromLineId, setFromLineId] = useState('');

  const load = useCallback(async () => {
    try {
      setBoard(
        await api<ReservationBoard>(
          `/v1/inventory/reservation-board?variantId=${variantId}&locationId=${locationId}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [variantId, locationId]);

  useEffect(() => {
    if (!open) {
      setBoard(null);
      setPick(null);
      return;
    }
    void load();
  }, [open, load]);

  if (!open) return null;

  function start(row: ReservationBoardRow, action: Action) {
    setPick({ row, action });
    setQuantity(String(action === 'reserve' ? row.shortfall : row.qtyReserved));
    setFromLineId('');
  }

  async function submit() {
    if (!pick || !board) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      toast.error('Enter a whole number of units');
      return;
    }
    setBusy(true);
    try {
      const next = await api<ReservationBoard>('/v1/inventory/reservations/move', {
        method: 'POST',
        body: JSON.stringify({
          variantId,
          locationId,
          quantity: qty,
          action: pick.action,
          ...(pick.action === 'reserve'
            ? { toLineId: pick.row.lineId, ...(fromLineId ? { fromLineId } : {}) }
            : { fromLineId: pick.row.lineId }),
        }),
      });
      setBoard(next);
      setPick(null);
      toast.success(
        pick.action === 'reserve'
          ? `Reserved ${qty} on ${pick.row.orderNumber}`
          : `Back-ordered ${qty} on ${pick.row.orderNumber} — the units are available again`,
      );
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const qty = Number(quantity) || 0;
  const needsSource =
    pick?.action === 'reserve' && board != null && qty > board.strip.available && !fromLineId;
  const donors =
    board?.rows.filter((r) => r.qtyReserved > 0 && r.lineId !== pick?.row.lineId) ?? [];

  return (
    <ModalDialog
      title={`Reassign reservation — ${itemLabel}`}
      onClose={onClose}
      wide
      testId="reassign-reservation-dialog"
      foot={
        <>
          <span className="muted" style={{ flex: 1, fontSize: 12 }}>
            Back order frees a line&apos;s units; Reserve commits free units to a line. Reserving
            more than is free takes the difference from the order you pick.
          </span>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {!board ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="space-y-4">
          <StatGrid cols={4} data-testid="reassign-strip">
            <StatTile label="On hand" value={board.strip.onHand} />
            <StatTile label="Reserved" value={board.strip.reserved} />
            <StatTile label="Floor" value={board.strip.floorSample} />
            <StatTile label="Available" value={board.strip.available} />
          </StatGrid>

          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Kind</th>
                  <th>Ordered</th>
                  <th>Fill by</th>
                  <th className="num">Qty</th>
                  <th className="num">Reserved</th>
                  <th className="num">Short</th>
                  <th>Status</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {board.rows.length === 0 && (
                  <TableEmpty colSpan={10}>No open order line wants this item here.</TableEmpty>
                )}
                {board.rows.map((r) => (
                  <tr key={r.lineId} data-testid="reassign-row">
                    <td>
                      <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>
                    </td>
                    <td>{r.customerName ?? '—'}</td>
                    <td>
                      {r.orderKind}
                      {r.fulfillmentType ? ` · ${r.fulfillmentType}` : ''}
                    </td>
                    <td>{fmtDay(r.orderDate)}</td>
                    <td>{fmtDay(r.fillBy)}</td>
                    <td className="num">{r.quantity}</td>
                    <td className="num">{r.qtyReserved}</td>
                    <td className="num">{r.shortfall}</td>
                    <td>
                      <StatusBadge status={r.orderStatus} />
                    </td>
                    <td className="actions">
                      {r.qtyReserved > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => start(r, 'back_order')}
                          data-testid="reassign-back-order"
                        >
                          Back order
                        </Button>
                      )}
                      {r.shortfall > 0 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => start(r, 'reserve')}
                          data-testid="reassign-reserve"
                        >
                          Reserve
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          {pick && (
            <form
              className="card"
              style={{ padding: 14 }}
              data-testid="reassign-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <p className="card-title" style={{ marginTop: 0 }}>
                {pick.action === 'reserve' ? 'Reserve units on' : 'Back order units from'}{' '}
                {pick.row.orderNumber}
                {pick.row.customerName ? ` · ${pick.row.customerName}` : ''}
              </p>
              <FormGrid cols={2}>
                <Field
                  label="Units"
                  hint={
                    pick.action === 'reserve'
                      ? `Line still lacks ${pick.row.shortfall}; ${board.strip.available} free here`
                      : `Line holds ${pick.row.qtyReserved} reserved`
                  }
                  required
                >
                  <Input
                    type="number"
                    min={1}
                    max={pick.action === 'reserve' ? pick.row.shortfall : pick.row.qtyReserved}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    data-testid="reassign-qty"
                  />
                </Field>
                {pick.action === 'reserve' && qty > board.strip.available && (
                  <Field
                    label="Take the units from"
                    hint="Only orders holding a reservation on this item here"
                    required
                  >
                    <Select
                      value={fromLineId}
                      onChange={(e) => setFromLineId(e.target.value)}
                      data-testid="reassign-from"
                    >
                      <option value="">Choose an order…</option>
                      {donors.map((d) => (
                        <option key={d.lineId} value={d.lineId}>
                          {d.orderNumber}
                          {d.customerName ? ` · ${d.customerName}` : ''} — {d.qtyReserved} reserved
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </FormGrid>
              <FormActions>
                <Button variant="secondary" onClick={() => setPick(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={pick.action === 'reserve' ? 'primary' : 'danger'}
                  disabled={busy || qty <= 0 || needsSource}
                  data-testid="reassign-submit"
                >
                  {busy
                    ? 'Working…'
                    : pick.action === 'reserve'
                      ? 'Reserve'
                      : 'Back order (release)'}
                </Button>
              </FormActions>
            </form>
          )}
        </div>
      )}
    </ModalDialog>
  );
}
