'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
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
 * STORIS Logistical Scheduling → "Confirm schedule" (A22 slice 5): the
 * day's deliveries with the confirmation call's contact status, the
 * Stops / Units / Dollars / Volume strip, zip / city / contact, and the
 * T D F P OO flags. Set the contact status inline as the calls go out.
 */

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}
interface Row {
  deliveryId: string;
  orderId: string;
  orderNumber: string;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  contactStatus: string | null;
  contactedAt: string | null;
  route: string | null;
  truck: string | null;
  routePosition: number | null;
  driverName: string | null;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  postalCode: string | null;
  fulfillmentType: string;
  units: number;
  dollarsCents: number;
  balanceDueCents: number;
  volume: number;
  flags: { T: boolean; D: boolean; F: boolean; P: boolean; OO: boolean };
  notes: string | null;
}
interface Result {
  range: { start: string; end: string };
  rows: Row[];
  totals: { stops: number; units: number; dollarsCents: number; volume: number; confirmed: number };
}

const DELIVERY_STATUSES = ['scheduled', 'loaded', 'out_for_delivery', 'delivered', 'failed'];
const CONTACT_STATUSES: { key: string; label: string }[] = [
  { key: 'none', label: 'Not called' },
  { key: 'not_contacted', label: 'Not contacted' },
  { key: 'left_message', label: 'Left message' },
  { key: 'no_answer', label: 'No answer' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'reschedule_requested', label: 'Reschedule requested' },
];
const FLAGS: { key: keyof Row['flags']; label: string; title: string }[] = [
  { key: 'T', label: 'T', title: 'Delivery ticket printed' },
  { key: 'D', label: 'D', title: 'Dollars due at the door (balance owed)' },
  { key: 'F', label: 'F', title: 'Fully reserved — every unit is in stock' },
  { key: 'P', label: 'P', title: 'Pick list printed' },
  { key: 'OO', label: 'OO', title: 'On open purchase order (special order not yet received)' },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The Contact cell writes through `setContact`, so the columns are built per render. */
function confirmColumns(setContact: (row: Row, contactStatus: string) => void): ColumnDef<Row>[] {
  return [
    {
      id: 'position',
      label: '#',
      num: true,
      sortValue: (r) => r.routePosition,
      render: (r) => r.routePosition ?? '—',
    },
    {
      id: 'window',
      label: 'Window',
      sortValue: (r) => r.windowStart,
      render: (r) => (r.windowStart ? `${r.windowStart}–${r.windowEnd ?? ''}` : '—'),
    },
    {
      id: 'order',
      label: 'Order',
      sortValue: (r) => r.orderNumber,
      render: (r) => (
        <>
          <Link href={`/deliveries/${r.deliveryId}`}>{r.orderNumber}</Link>
          {r.fulfillmentType === 'pickup' && <span className="muted text-xs"> pickup</span>}
        </>
      ),
    },
    {
      id: 'customer',
      label: 'Customer',
      sortValue: (r) => r.customerName,
      render: (r) => r.customerName ?? '—',
    },
    { id: 'phone', label: 'Phone', sortValue: (r) => r.phone, render: (r) => r.phone ?? '—' },
    { id: 'city', label: 'City', sortValue: (r) => r.city, render: (r) => r.city ?? '—' },
    {
      id: 'zip',
      label: 'Zip',
      sortValue: (r) => r.postalCode,
      render: (r) => r.postalCode ?? '—',
    },
    { id: 'route', label: 'Route', sortValue: (r) => r.route, render: (r) => r.route ?? '—' },
    {
      id: 'truck',
      label: 'Truck / driver',
      sortValue: (r) => [r.truck, r.driverName].filter(Boolean).join(' · ') || null,
      render: (r) => [r.truck, r.driverName].filter(Boolean).join(' · ') || '—',
    },
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
      render: (r) => <Money cents={r.balanceDueCents} />,
    },
    {
      id: 'volume',
      label: 'Vol',
      num: true,
      sortValue: (r) => r.volume,
      render: (r) => r.volume,
    },
    ...FLAGS.map(
      (f): ColumnDef<Row> => ({
        id: `flag${f.key}`,
        label: f.label,
        num: true,
        title: f.title,
        sortValue: (r) => r.flags[f.key],
        render: (r) => (
          <span title={f.title} data-testid={`confirm-flag-${f.key}`}>
            {r.flags[f.key] ? <strong>{f.label}</strong> : <span className="muted">·</span>}
          </span>
        ),
      }),
    ),
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
      render: (r) => (
        <Select
          value={r.contactStatus ?? ''}
          onChange={(e) => setContact(r, e.target.value)}
          aria-label={`Contact status for ${r.orderNumber}`}
          data-testid="confirm-contact-select"
        >
          <option value="">Not called</option>
          {CONTACT_STATUSES.filter((c) => c.key !== 'none').map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </Select>
      ),
    },
  ];
}

export default function ConfirmSchedulePage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState(today());
  const [route, setRoute] = useState('');
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [contacts, setContacts] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Location[]>('/v1/business/locations')
      .then((rows) => setLocations(rows.filter((l) => l.isActive)))
      .catch(() => setLocations([]));
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const p = new URLSearchParams({ date });
      if (locationId) p.set('locationId', locationId);
      if (route.trim()) p.set('route', route.trim());
      if (statuses.size) p.set('deliveryStatus', [...statuses].join(','));
      if (contacts.size) p.set('contactStatus', [...contacts].join(','));
      setResult(await api<Result>(`/v1/scheduling/confirm?${p.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [date, locationId, route, statuses, contacts]);

  useEffect(() => {
    void load();
    // Reload on the date and location; the checkbox filters wait for Run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, locationId]);

  async function setContact(row: Row, contactStatus: string) {
    try {
      await api(`/v1/deliveries/${row.deliveryId}/contact`, {
        method: 'PATCH',
        body: JSON.stringify({ contactStatus: contactStatus || null }),
      });
      toast.success(
        `${row.orderNumber}: ${contactStatus ? contactStatus.replace(/_/g, ' ') : 'contact cleared'}`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const cols = useListColumns(
    'deliveries-confirm',
    confirmColumns((row, s) => void setContact(row, s)),
    result?.rows ?? null,
  );

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  return (
    <div data-testid="confirm-schedule">
      <PageHeader
        eyebrow={<BackLink href="/deliveries">Deliveries</BackLink>}
        title="Confirm schedule"
        sub="The day's stops with the confirmation call's status. T ticket printed · D dollars due · F fully reserved · P pick list printed · OO on open PO."
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        <Card title="Day">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <FormGrid cols={3}>
              <Field label="Date" required>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-testid="confirm-date"
                />
              </Field>
              <Field label="Deliver from">
                <Select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  data-testid="confirm-location"
                >
                  <option value="">All locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Route" hint="Contains">
                <Input value={route} onChange={(e) => setRoute(e.target.value)} />
              </Field>
              <Field label="Delivery status" as="div" hint="None ticked = open stops">
                <div className="flex flex-wrap gap-3 text-sm">
                  {DELIVERY_STATUSES.map((s) => (
                    <label key={s} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={statuses.has(s)}
                        onChange={() => setStatuses((prev) => toggle(prev, s))}
                      />
                      {s.replace(/_/g, ' ')}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Contact status" as="div" hint="None ticked = all" className="form-span">
                <div className="flex flex-wrap gap-3 text-sm">
                  {CONTACT_STATUSES.map((c) => (
                    <label key={c.key} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={contacts.has(c.key)}
                        onChange={() => setContacts((prev) => toggle(prev, c.key))}
                        data-testid={`confirm-contact-${c.key}`}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </Field>
            </FormGrid>
            <FormActions>
              <Button type="submit" variant="primary" disabled={busy} data-testid="confirm-run">
                {busy ? 'Loading…' : 'Run'}
              </Button>
            </FormActions>
          </form>
        </Card>

        {!result ? (
          <Card>
            <LoadingRows rows={4} />
          </Card>
        ) : (
          <>
            <StatGrid cols={5} data-testid="confirm-totals">
              <StatTile label="Stops" value={result.totals.stops} />
              <StatTile label="Units" value={result.totals.units} />
              <StatTile label="Dollars" value={<Money cents={result.totals.dollarsCents} />} />
              <StatTile label="Volume" value={result.totals.volume} sub="capacity units" />
              <StatTile
                label="Confirmed"
                value={result.totals.confirmed}
                sub={`of ${result.totals.stops}`}
              />
            </StatGrid>
            <Card flush>
              {result.rows.length === 0 ? (
                <EmptyState title="No stops match" />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <ColumnHeadRow list={cols} testIdPrefix="deliveries-confirm" />
                    </thead>
                    <tbody>
                      {cols.sorted.map((r) => (
                        <tr key={r.deliveryId} data-testid="confirm-row">
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
        )}
      </Stack>
    </div>
  );
}
