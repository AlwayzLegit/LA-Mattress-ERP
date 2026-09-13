'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import { Money } from '@/components/money';
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
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableWrap,
  useListColumns,
} from '@/components/ui';

interface ShiftRow {
  id: string;
  locationId: string;
  locationName: string | null;
  openedByEmail: string | null;
  openedAt: string;
  openingFloatCents: number;
  closedAt: string | null;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
  notes: string | null;
}
interface LocationRow {
  id: string;
  name: string;
}

const SHIFT_COLUMNS: ColumnDef<ShiftRow>[] = [
  {
    id: 'opened',
    label: 'Opened',
    className: 'nowrap',
    sortValue: (r) => r.openedAt,
    render: (r) => new Date(r.openedAt).toLocaleString(),
  },
  {
    id: 'location',
    label: 'Location',
    sortValue: (r) => r.locationName,
    render: (r) => r.locationName ?? '—',
  },
  {
    id: 'float',
    label: 'Float',
    num: true,
    sortValue: (r) => r.openingFloatCents,
    render: (r) => <Money cents={r.openingFloatCents} />,
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (r) => (r.closedAt ? 'closed' : 'open'),
    render: (r) => (
      <>
        <StatusBadge status={r.closedAt ? 'closed' : 'open'} />
        {r.closedAt && <span className="muted"> {new Date(r.closedAt).toLocaleString()}</span>}
      </>
    ),
  },
  {
    id: 'variance',
    label: 'Variance',
    num: true,
    sortValue: (r) => r.varianceCents,
    render: (r) => (r.varianceCents == null ? '—' : <Money cents={r.varianceCents} />),
  },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (r) => (
      <LinkButton size="sm" href={`/shifts/${r.id}`}>
        Open
      </LinkButton>
    ),
  },
];

export default function ShiftsPage() {
  const list = useCursorList<ShiftRow>('/v1/cash-shifts');
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openLocationId, setOpenLocationId] = useState('');
  const [floatStr, setFloatStr] = useState('');
  const [openNotes, setOpenNotes] = useState('');
  const { rows } = list;
  const cols = useListColumns('shifts', SHIFT_COLUMNS, rows);

  useEffect(() => {
    void list.load();
    void (async () => {
      try {
        const locs = await api<LocationRow[]>('/v1/pos/locations');
        setLocations(locs);
        setOpenLocationId((prev) => prev || (locs[0]?.id ?? ''));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openShift() {
    if (!openLocationId) return;
    setError(null);
    setOpening(true);
    try {
      const cents = Math.round(Number(floatStr) * 100);
      if (!Number.isFinite(cents) || cents < 0) throw new Error('Float must be ≥ 0');
      await api('/v1/cash-shifts', {
        method: 'POST',
        body: JSON.stringify({
          locationId: openLocationId,
          openingFloatCents: cents,
          notes: openNotes || null,
        }),
      });
      setFloatStr('');
      setOpenNotes('');
      void list.load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  const hasRows = rows != null && rows.length > 0;

  return (
    <div>
      <PageHeader title="Cash drawer" />
      <Stack>
        {list.error && <Alert tone="error">{list.error}</Alert>}

        <Card title="Open new shift">
          <FormGrid cols={3}>
            <Field label="Location" required>
              <Select value={openLocationId} onChange={(e) => setOpenLocationId(e.target.value)}>
                {locations.length === 0 && <option value="">No locations available</option>}
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Opening float ($)" required>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={floatStr}
                onChange={(e) => setFloatStr(e.target.value)}
              />
            </Field>
            <Field label="Notes">
              <Input value={openNotes} onChange={(e) => setOpenNotes(e.target.value)} />
            </Field>
          </FormGrid>
          {error && (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          )}
          <FormActions>
            <Button
              variant="primary"
              onClick={openShift}
              disabled={opening || !floatStr || !openLocationId}
            >
              {opening ? 'Opening…' : 'Open shift'}
            </Button>
          </FormActions>
        </Card>

        <Card title="Shifts" flush={hasRows}>
          {rows == null ? (
            <LoadingRows />
          ) : rows.length === 0 ? (
            <EmptyState title="No shifts yet">
              Open one above to start tracking the drawer.
            </EmptyState>
          ) : (
            <>
              <TableWrap>
                <table className="table">
                  <thead>
                    <ColumnHeadRow list={cols} testIdPrefix="shifts" />
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
              <LoadMore state={list} noun="shifts" />
            </>
          )}
        </Card>
      </Stack>
    </div>
  );
}
