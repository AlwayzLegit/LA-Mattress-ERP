'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Alert, Button, Card, LoadingRows, TableWrap } from '@/components/ui';

/**
 * Owner 2026-10-28: reservations drift when the real world and the
 * paperwork disagree (a count correction and a PO both covering one
 * sale, a receipt at one store delivered from another). The report
 * lists every SKU whose stock-level reservation differs from what its
 * order lines hold; Repair releases what closed or delivered lines
 * still hold and sets each level to its lines' sum, in the stock ledger
 * as `reservation_repair`.
 */

interface DriftRow {
  variantId: string;
  sku: string | null;
  locationId: string;
  lineReserved: number;
  levelReserved: number;
  driftUnits: number;
}
interface ReleasedLine {
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  variantId: string;
  locationId: string;
  released: number;
}
interface RepairResult {
  dryRun: boolean;
  releasedLines: ReleasedLine[];
  levels: DriftRow[];
}

export function ReservationCheckCard() {
  const [rows, setRows] = useState<DriftRow[] | null>(null);
  const [locations, setLocations] = useState<Map<string, string>>(new Map());
  const [preview, setPreview] = useState<RepairResult | null>(null);
  const [done, setDone] = useState<RepairResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api<DriftRow[]>('/v1/orders/reservation-drift'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
  }
  useEffect(() => {
    void load();
    void api<{ id: string; name: string }[]>('/v1/business/locations')
      .then((l) => setLocations(new Map(l.map((x) => [x.id, x.name]))))
      .catch(() => undefined);
  }, []);

  async function run(dryRun: boolean) {
    setWorking(true);
    setError(null);
    try {
      const r = await api<RepairResult>('/v1/orders/reservation-drift/repair', {
        method: 'POST',
        body: JSON.stringify({ dryRun }),
      });
      if (dryRun) setPreview(r);
      else {
        setDone(r);
        setPreview(null);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  const loc = (id: string) => locations.get(id) ?? id.slice(0, 8);

  return (
    <Card
      title="Reservation check"
      description="Each SKU and store where the stock level's reserved count disagrees with what its order lines hold. Repair releases what delivered or closed lines still hold and sets every level to its lines' sum — logged in the stock ledger as a reservation repair."
      className="form-narrow"
      data-testid="reservation-check"
    >
      {rows === null ? (
        <LoadingRows rows={2} />
      ) : rows.length === 0 ? (
        <p className="muted m-0 text-[13px]" data-testid="reservation-check-clean">
          Reservations match the orders.
        </p>
      ) : (
        <TableWrap>
          <table className="table" data-testid="reservation-check-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Store</th>
                <th className="num">Lines hold</th>
                <th className="num">Level says</th>
                <th className="num">Drift</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.variantId}:${r.locationId}`}>
                  <td>
                    <code>{r.sku ?? r.variantId.slice(0, 8)}</code>
                  </td>
                  <td>{loc(r.locationId)}</td>
                  <td className="num">{r.lineReserved}</td>
                  <td className="num">{r.levelReserved}</td>
                  <td className="num">{r.driftUnits > 0 ? `+${r.driftUnits}` : r.driftUnits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {preview && (
        <Alert tone="info" className="mt-3" data-testid="reservation-check-preview">
          Repair would release {preview.releasedLines.length} line
          {preview.releasedLines.length === 1 ? '' : 's'}
          {preview.releasedLines.length > 0 && (
            <> ({preview.releasedLines.map((l) => `${l.orderNumber} ×${l.released}`).join(', ')})</>
          )}{' '}
          and reset {preview.levels.length} level{preview.levels.length === 1 ? '' : 's'}.
        </Alert>
      )}
      {done && (
        <Alert tone="success" className="mt-3" data-testid="reservation-check-done">
          Released {done.releasedLines.length} line{done.releasedLines.length === 1 ? '' : 's'},
          reset {done.levels.length} level{done.levels.length === 1 ? '' : 's'}.
        </Alert>
      )}
      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={working}
          onClick={() => load()}
        >
          Re-check
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={working || (rows?.length ?? 0) === 0}
          onClick={() => run(true)}
        >
          Preview repair
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={working || (rows?.length ?? 0) === 0}
          onClick={() => run(false)}
          data-testid="reservation-check-repair"
        >
          {working ? 'Working…' : 'Repair'}
        </Button>
      </div>
    </Card>
  );
}
