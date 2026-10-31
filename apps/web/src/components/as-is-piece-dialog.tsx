'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import { Alert, Button, Dialog, LoadingRows } from '@/components/ui';

/**
 * Owner 2026-10-30: pick the specific As-Is piece a line sells or moves.
 * The As-Is queue tracks returned / warranty / floor units by the piece
 * (number, condition, as-is price, where it sits), so "sell it as-is"
 * means choosing one of them — the line then holds that piece instead
 * of new stock. Used from the Add product search, the register and
 * order lines, and the transfer builder.
 */

export interface AsIsPiece {
  id: string;
  pieceNumber: string | null;
  condition: string | null;
  asIsPriceCents: number | null;
  storageLocation: string | null;
  source: string;
  notes: string | null;
  createdAt: string;
  sellable: boolean;
}

export function pieceLabel(p: { id: string; pieceNumber: string | null }): string {
  return p.pieceNumber ?? p.id.slice(0, 8).toUpperCase();
}

export function AsIsPieceDialog({
  variantId,
  locationId,
  locationName,
  productName,
  listPriceCents,
  onPick,
  onClose,
  verb = 'Sell',
}: {
  variantId: string;
  locationId: string;
  locationName: string | null;
  productName: string;
  /** The item's list price — what a piece sells at when no as-is price is set. */
  listPriceCents?: number;
  onPick: (piece: AsIsPiece) => void;
  onClose: () => void;
  /** "Sell" on an order, "Move" on a transfer. */
  verb?: 'Sell' | 'Move';
}) {
  const [pieces, setPieces] = useState<AsIsPiece[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPieces(null);
    void api<AsIsPiece[]>(`/v1/pos/as-is-pieces?variantId=${variantId}&locationId=${locationId}`)
      .then(setPieces)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setPieces([]);
      });
  }, [variantId, locationId]);

  const where = locationName ?? 'this location';
  return (
    <Dialog
      title={`${verb} as-is — ${productName}`}
      description={`As-Is pieces of this item at ${where}. ${
        verb === 'Sell'
          ? 'The line holds the piece you pick and sells it at its as-is price (list price when none is set).'
          : 'The piece you pick rides the transfer and lands in the destination’s As-Is queue.'
      }`}
      onClose={onClose}
      size="lg"
      testId="as-is-piece-dialog"
    >
      {error && <Alert tone="error">{error}</Alert>}
      {pieces == null ? (
        <LoadingRows rows={3} what="As-Is pieces" />
      ) : pieces.length === 0 ? (
        <p className="muted m-0 text-[13px]" data-testid="as-is-piece-empty">
          No As-Is pieces of this item at {where}.
        </p>
      ) : (
        <table className="table table-dense" data-testid="as-is-piece-table">
          <thead>
            <tr>
              <th>Piece</th>
              <th>Condition</th>
              <th>Where</th>
              <th className="num">As-is price</th>
              <th>Received</th>
              <th className="actions">
                <span className="sr-only">{verb}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pieces.map((p) => (
              <tr key={p.id} data-testid="as-is-piece-row">
                <td>
                  <code>{pieceLabel(p)}</code>
                  {p.notes && <div className="muted text-xs">{p.notes}</div>}
                </td>
                <td>
                  {p.condition ? (
                    <span className={`badge ${p.sellable ? 'badge-neutral' : 'badge-danger'}`}>
                      {p.condition.replace(/_/g, ' ')}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{p.storageLocation ?? <span className="muted">—</span>}</td>
                <td className="num mono">
                  {p.asIsPriceCents != null ? (
                    <Money cents={p.asIsPriceCents} />
                  ) : listPriceCents != null ? (
                    <span className="muted" title="No as-is price set — sells at list">
                      <Money cents={listPriceCents} /> list
                    </span>
                  ) : (
                    <span className="muted">not set</span>
                  )}
                </td>
                <td className="nowrap">{new Date(p.createdAt).toLocaleDateString()}</td>
                <td className="actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!p.sellable}
                    title={p.sellable ? undefined : 'Not sellable in this condition'}
                    onClick={() => onPick(p)}
                    data-testid="as-is-piece-pick"
                  >
                    {verb}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
