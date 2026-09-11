'use client';

import Link from 'next/link';
import { Download, FileText, Play } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingRows,
  PageHeader,
  Select,
  StatusBadge,
  TableWrap,
} from '@/components/ui';

/**
 * Report Transfers by Location (STORIS TE.324, A22 slice 2): every
 * transfer line grouped by the receiving store — From / To location,
 * transfer dates, reserve level and Include instructions — with the
 * Basic PDF spool, a text spool and CSV.
 */

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}
interface Line {
  lineId: string;
  sku: string | null;
  productName: string;
  vendorModel: string | null;
  brand: string | null;
  orderQty: number;
  resQty: number;
  heldQty: number;
}
interface Transfer {
  id: string;
  number: string;
  date: string;
  status: string;
  transferFor: string;
  fromLocationName: string;
  manifestNumber: string | null;
  instructions: string | null;
  notes: string | null;
  lines: Line[];
}
interface Group {
  locationId: string;
  locationName: string;
  transfers: Transfer[];
  totals: { transfers: number; orderQty: number; resQty: number; heldQty: number };
}
interface Report {
  generatedAt: string;
  range: { start: string | null; end: string | null };
  filters: { reserveLevel: string; includeInstructions: boolean };
  groups: Group[];
  totals: { transfers: number; lines: number; orderQty: number; resQty: number; heldQty: number };
}

function fmtDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

export default function TransfersByLocationPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reserveLevel, setReserveLevel] = useState<'all' | 'partial' | 'full'>('all');
  const [includeInstructions, setIncludeInstructions] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Location[]>('/v1/business/locations')
      .then((rows) => setLocations(rows.filter((l) => l.isActive)))
      .catch(() => setLocations([]));
  }, []);

  function query(): string {
    const p = new URLSearchParams();
    if (fromLocationId) p.set('fromLocationId', fromLocationId);
    if (toLocationId) p.set('toLocationId', toLocationId);
    if (start) p.set('start', start);
    if (end) p.set('end', end);
    if (reserveLevel !== 'all') p.set('reserveLevel', reserveLevel);
    if (includeInstructions) p.set('includeInstructions', '1');
    return p.toString();
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const qs = query();
      setReport(await api<Report>(`/v1/reports/transfers-by-location${qs ? `?${qs}` : ''}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function exportAs(format: 'csv' | 'pdf' | 'txt') {
    setExporting(true);
    try {
      const qs = query();
      await downloadFile(
        `/v1/reports/transfers-by-location?${qs ? `${qs}&` : ''}format=${format}`,
        `transfers-by-location-${start || 'earliest'}-to-${end || 'latest'}.${format}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div data-testid="transfers-by-location">
      <p style={{ margin: '0 0 12px' }}>
        <Link href="/reports">← Reports</Link>
      </p>
      <PageHeader
        title="Report Transfers by Location"
        sub="Every transfer line under its receiving store — what was ordered, what is moving, what is still held — with the manifest it rides on."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => void exportAs('pdf')}
              disabled={exporting}
              title="Download the STORIS-layout Basic PDF"
            >
              <FileText size={14} />
              PDF
            </Button>
            <Button variant="secondary" onClick={() => void exportAs('txt')} disabled={exporting}>
              <FileText size={14} />
              Text
            </Button>
            <Button variant="secondary" onClick={() => void exportAs('csv')} disabled={exporting}>
              <Download size={14} />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <Card title="Parameters" data-testid="tbl-params">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="From location">
                <Select
                  value={fromLocationId}
                  onChange={(e) => setFromLocationId(e.target.value)}
                  data-testid="tbl-from"
                >
                  <option value="">All locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To location">
                <Select
                  value={toLocationId}
                  onChange={(e) => setToLocationId(e.target.value)}
                  data-testid="tbl-to"
                >
                  <option value="">All locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reserve level">
                <Select
                  value={reserveLevel}
                  onChange={(e) => setReserveLevel(e.target.value as typeof reserveLevel)}
                  data-testid="tbl-reserve-level"
                >
                  <option value="all">All</option>
                  <option value="partial">Partial reserve (units still held)</option>
                  <option value="full">Full reserve (nothing held)</option>
                </Select>
              </Field>
              <Field label="From date" hint="Blank = earliest">
                <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="To date" hint="Blank = latest">
                <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </Field>
              <Field label="Include instructions" as="div">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={includeInstructions}
                    onChange={(e) => setIncludeInstructions(e.target.checked)}
                  />
                  Print fulfillment instructions and notes under each transfer
                </label>
              </Field>
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="primary" disabled={busy} data-testid="tbl-run">
                <Play size={14} />
                {busy ? 'Running…' : 'Run'}
              </Button>
            </div>
          </form>
        </Card>

        {error && <Card>{error}</Card>}

        {busy && !report ? (
          <Card>
            <LoadingRows rows={4} />
          </Card>
        ) : report ? (
          report.groups.length === 0 ? (
            <Card>
              <EmptyState title="No transfers match the parameters" />
            </Card>
          ) : (
            <>
              {report.groups.map((g) => (
                <Card
                  key={g.locationId}
                  title={`Receiving store: ${g.locationName}`}
                  description={`${g.totals.transfers} transfer(s) · ordered ${g.totals.orderQty} · reserved ${g.totals.resQty} · held ${g.totals.heldQty}`}
                  flush
                  data-testid="tbl-group"
                >
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Transfer</th>
                          <th>Date</th>
                          <th>Sending location</th>
                          <th>Transfer for</th>
                          <th>Product</th>
                          <th>Brand</th>
                          <th className="num">Order qty</th>
                          <th className="num">Res qty</th>
                          <th className="num">Held qty</th>
                          <th>Manifest</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.transfers.map((t) => (
                          <Fragment key={t.id}>
                            {t.lines.map((l, i) => (
                              <tr key={l.lineId} data-testid="tbl-line">
                                <td>
                                  {i === 0 ? (
                                    <Link href={`/transfers/${t.id}`}>{t.number}</Link>
                                  ) : (
                                    ''
                                  )}
                                </td>
                                <td>{i === 0 ? fmtDate(t.date) : ''}</td>
                                <td>{i === 0 ? t.fromLocationName : ''}</td>
                                <td>{i === 0 ? t.transferFor : ''}</td>
                                <td>
                                  <code>{l.sku ?? l.productName}</code>
                                  {l.vendorModel && (
                                    <div className="muted text-xs">
                                      Vendor model: {l.vendorModel}
                                    </div>
                                  )}
                                </td>
                                <td>{l.brand ?? '—'}</td>
                                <td className="num">{l.orderQty}</td>
                                <td className="num">{l.resQty}</td>
                                <td className="num">{l.heldQty}</td>
                                <td>{i === 0 ? (t.manifestNumber ?? '—') : ''}</td>
                                <td>{i === 0 ? <StatusBadge status={t.status} /> : ''}</td>
                              </tr>
                            ))}
                            {report.filters.includeInstructions && (t.instructions || t.notes) && (
                              <tr className="muted">
                                <td />
                                <td colSpan={10}>
                                  {t.instructions && <div>Instructions: {t.instructions}</div>}
                                  {t.notes && <div>Notes: {t.notes}</div>}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </Card>
              ))}
              <Card title="Grand total" data-testid="tbl-grand">
                {report.totals.transfers} transfers · {report.totals.lines} lines · ordered{' '}
                {report.totals.orderQty} · reserved {report.totals.resQty} · held{' '}
                {report.totals.heldQty}
              </Card>
            </>
          )
        ) : (
          <Card>
            <EmptyState title="Set the parameters and run the report" />
          </Card>
        )}
      </div>
    </div>
  );
}
