'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
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
  Select,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * STORIS Logistical Scheduling → "Search for schedules" (A22 slice 5):
 * one list across sales-order deliveries, stock transfers and service
 * calls — deliver from, route, truck, transfer to, date range, past
 * dates — with the Stops / Units / Dollars / Volume strip.
 */

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}
interface Row {
  kind: 'order' | 'transfer' | 'service';
  id: string;
  documentId: string;
  number: string;
  date: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  contactStatus: string | null;
  fromLocationName: string | null;
  toLocationName: string | null;
  route: string | null;
  truck: string | null;
  crewName: string | null;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  postalCode: string | null;
  units: number;
  dollarsCents: number;
  balanceDueCents: number | null;
  volume: number;
}
interface Result {
  kind: 'orders' | 'transfers' | 'service';
  range: { start: string | null; end: string };
  rows: Row[];
  totals: { stops: number; units: number; dollarsCents: number; volume: number };
}

const KINDS: { key: Result['kind']; label: string }[] = [
  { key: 'orders', label: 'Sales orders' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'service', label: 'Service orders' },
];

function fmtDay(d: string | null): string {
  if (!d) return '—';
  const [y, m, dd] = d.split('-');
  return `${m}/${dd}/${y}`;
}
function href(r: Row): string {
  return r.kind === 'order'
    ? `/deliveries/${r.id}`
    : r.kind === 'transfer'
      ? `/transfers/${r.documentId}`
      : `/service/${r.documentId}`;
}

/** A few header labels read differently per schedule kind; the ids stay put. */
function searchColumns(kind: Result['kind']): ColumnDef<Row>[] {
  return [
    { id: 'date', label: 'Date', sortValue: (r) => r.date, render: (r) => fmtDay(r.date) },
    {
      id: 'window',
      label: 'Window',
      sortValue: (r) => r.windowStart,
      render: (r) => (r.windowStart ? `${r.windowStart}–${r.windowEnd ?? ''}` : '—'),
    },
    {
      id: 'number',
      label: 'Number',
      sortValue: (r) => r.number,
      render: (r) => <Link href={href(r)}>{r.number}</Link>,
    },
    {
      id: 'customer',
      label: kind === 'transfers' ? 'Manifest' : 'Customer',
      sortValue: (r) => r.customerName,
      render: (r) => r.customerName ?? '—',
    },
    {
      id: 'from',
      label: kind === 'transfers' ? 'From → To' : 'From',
      sortValue: (r) => r.fromLocationName,
      render: (r) => (
        <>
          {r.fromLocationName ?? '—'}
          {r.toLocationName ? ` → ${r.toLocationName}` : ''}
        </>
      ),
    },
    { id: 'route', label: 'Route', sortValue: (r) => r.route, render: (r) => r.route ?? '—' },
    { id: 'truck', label: 'Truck', sortValue: (r) => r.truck, render: (r) => r.truck ?? '—' },
    {
      id: 'crew',
      label: kind === 'service' ? 'Technician' : 'Driver',
      sortValue: (r) => r.crewName,
      render: (r) => r.crewName ?? '—',
    },
    { id: 'city', label: 'City', sortValue: (r) => r.city, render: (r) => r.city ?? '—' },
    {
      id: 'zip',
      label: 'Zip',
      sortValue: (r) => r.postalCode,
      render: (r) => r.postalCode ?? '—',
    },
    { id: 'phone', label: 'Phone', sortValue: (r) => r.phone, render: (r) => r.phone ?? '—' },
    { id: 'units', label: 'Units', num: true, sortValue: (r) => r.units, render: (r) => r.units },
    {
      id: 'dollars',
      label: 'Dollars',
      num: true,
      sortValue: (r) => r.dollarsCents,
      render: (r) => <Money cents={r.dollarsCents} />,
    },
    {
      id: 'due',
      label: 'Due',
      num: true,
      sortValue: (r) => r.balanceDueCents,
      render: (r) => (r.balanceDueCents != null ? <Money cents={r.balanceDueCents} /> : '—'),
    },
    {
      id: 'volume',
      label: 'Volume',
      num: true,
      sortValue: (r) => r.volume,
      render: (r) => r.volume,
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (r) => r.status,
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      id: 'contact',
      label: 'Contact',
      sortValue: (r) => r.contactStatus,
      render: (r) => (r.contactStatus ? r.contactStatus.replace(/_/g, ' ') : '—'),
    },
  ];
}

export default function ScheduleSearchPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [kind, setKind] = useState<Result['kind']>('orders');
  const [locationId, setLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [route, setRoute] = useState('');
  const [truck, setTruck] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [includePast, setIncludePast] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cols = useListColumns(
    'deliveries-search',
    searchColumns(result?.kind ?? kind),
    result?.rows ?? null,
  );

  useEffect(() => {
    api<Location[]>('/v1/business/locations')
      .then((rows) => setLocations(rows.filter((l) => l.isActive)))
      .catch(() => setLocations([]));
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const p = new URLSearchParams({ kind });
      if (locationId) p.set('locationId', locationId);
      if (kind === 'transfers' && toLocationId) p.set('toLocationId', toLocationId);
      if (route.trim()) p.set('route', route.trim());
      if (truck.trim()) p.set('truck', truck.trim());
      if (start) p.set('start', start);
      if (end) p.set('end', end);
      if (includePast) p.set('includePast', '1');
      if (status.trim()) p.set('status', status.trim());
      setResult(await api<Result>(`/v1/scheduling/search?${p.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="schedule-search">
      <PageHeader
        eyebrow={<BackLink href="/deliveries">Deliveries</BackLink>}
        title="Search for schedules"
        sub="Every scheduled stop — deliveries, transfers and service calls — by location, route, truck and date."
        actions={
          <div className="seg seg-lg" role="tablist" aria-label="Schedule kind">
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                role="tab"
                aria-selected={kind === k.key}
                className={`seg-btn${kind === k.key ? ' is-active' : ''}`}
                onClick={() => {
                  setKind(k.key);
                  setResult(null);
                }}
                data-testid={`schedule-kind-${k.key}`}
              >
                {k.label}
              </button>
            ))}
          </div>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        <Card title="Criteria">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <FormGrid cols={3}>
              <Field label={kind === 'transfers' ? 'Transfer from' : 'Deliver from'}>
                <Select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  data-testid="schedule-location"
                >
                  <option value="">All locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {kind === 'transfers' && (
                <Field label="Transfer to">
                  <Select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
                    <option value="">All locations</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {kind !== 'service' && (
                <>
                  <Field label="Route" hint="Contains">
                    <Input value={route} onChange={(e) => setRoute(e.target.value)} />
                  </Field>
                  <Field label="Truck" hint="Contains">
                    <Input value={truck} onChange={(e) => setTruck(e.target.value)} />
                  </Field>
                </>
              )}
              <Field label="From date" hint="Blank = today">
                <Input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  disabled={includePast}
                />
              </Field>
              <Field label="To date" hint="Blank = 35 days out">
                <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </Field>
              <Field label="Status" hint="Blank = open schedules only">
                <Input
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  placeholder={kind === 'orders' ? 'scheduled, delivered…' : ''}
                />
              </Field>
              <Field label="Past dates" as="div">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={includePast}
                    onChange={(e) => setIncludePast(e.target.checked)}
                    data-testid="schedule-past"
                  />
                  Include past dates
                </label>
              </Field>
            </FormGrid>
            <FormActions>
              <Button type="submit" variant="primary" disabled={busy} data-testid="schedule-run">
                {busy ? 'Searching…' : 'Search'}
              </Button>
            </FormActions>
          </form>
        </Card>

        {busy && !result ? (
          <Card>
            <LoadingRows rows={4} />
          </Card>
        ) : result ? (
          <>
            <StatGrid cols={4} data-testid="schedule-totals">
              <StatTile label="Stops" value={result.totals.stops} />
              <StatTile label="Units" value={result.totals.units} />
              <StatTile label="Dollars" value={<Money cents={result.totals.dollarsCents} />} />
              <StatTile label="Volume" value={result.totals.volume} sub="capacity units" />
            </StatGrid>
            <Card
              title={`${KINDS.find((k) => k.key === result.kind)?.label} · ${
                result.range.start ? fmtDay(result.range.start) : 'earliest'
              } → ${fmtDay(result.range.end)}`}
              flush
            >
              {result.rows.length === 0 ? (
                <EmptyState title="Nothing scheduled in that range" />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <ColumnHeadRow list={cols} testIdPrefix="deliveries-search" />
                    </thead>
                    <tbody>
                      {cols.sorted.map((r) => (
                        <tr key={`${r.kind}-${r.id}`} data-testid="schedule-row">
                          <ColumnCells list={cols} row={r} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ResetColumns list={cols} />
                </TableWrap>
              )}
            </Card>
          </>
        ) : (
          <Card>
            <EmptyState title="Set the criteria and search" />
          </Card>
        )}
      </Stack>
    </div>
  );
}
