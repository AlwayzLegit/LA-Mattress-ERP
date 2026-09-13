'use client';

import Link from 'next/link';
import { toast } from 'sonner';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
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
  SectionHeading,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * Q1 (owner 2026-08-28): manifests without scanning. Build groups draft
 * transfers on one lane onto a truck/date manifest; the same open
 * (to-location, route, date) key appends. Complete ships the truck.
 */

interface ManifestRow {
  id: string;
  number: string;
  status: string;
  manifestDate: string;
  routeName: string | null;
  fromLocationName: string | null;
  toLocationName: string | null;
  transferCount: number;
  createdAt: string;
}

interface Location {
  id: string;
  name: string;
  locationType: string;
}

interface DraftTransfer {
  id: string;
  number: string;
  transferType: string;
  createdAt: string;
}

const MANIFEST_COLUMNS: ColumnDef<ManifestRow>[] = [
  {
    id: 'number',
    label: 'Manifest',
    sortValue: (m) => m.number,
    render: (m) => (
      <Link href={`/transfers/manifests/${m.id}`}>
        <code>{m.number}</code>
      </Link>
    ),
  },
  { id: 'date', label: 'Date', sortValue: (m) => m.manifestDate, render: (m) => m.manifestDate },
  {
    id: 'route',
    label: 'Route',
    sortValue: (m) => m.routeName,
    render: (m) => m.routeName ?? '—',
  },
  {
    id: 'lane',
    label: 'Lane',
    sortValue: (m) => `${m.fromLocationName ?? '—'} → ${m.toLocationName ?? '—'}`,
    render: (m) => (
      <>
        {m.fromLocationName ?? '—'} → {m.toLocationName ?? '—'}
      </>
    ),
  },
  {
    id: 'transfers',
    label: 'Transfers',
    num: true,
    sortValue: (m) => m.transferCount,
    render: (m) => m.transferCount,
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (m) => m.status,
    render: (m) => <StatusBadge status={m.status} />,
  },
];

export default function ManifestsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ManifestRow[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Build form
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [manifestDate, setManifestDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [routeName, setRouteName] = useState('');
  const [drafts, setDrafts] = useState<DraftTransfer[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [building, setBuilding] = useState(false);

  const draftColumns: ColumnDef<DraftTransfer>[] = [
    {
      id: 'select',
      label: <span className="sr-only">Select</span>,
      thClassName: 'w-8',
      fixed: true,
      render: (t) => (
        <input
          type="checkbox"
          aria-label={`Select ${t.number}`}
          checked={selected.has(t.id)}
          onChange={(e) => {
            const next = new Set(selected);
            if (e.target.checked) next.add(t.id);
            else next.delete(t.id);
            setSelected(next);
          }}
        />
      ),
    },
    {
      id: 'number',
      label: 'Transfer',
      sortValue: (t) => t.number,
      render: (t) => <code>{t.number}</code>,
    },
    {
      id: 'type',
      label: 'Type',
      sortValue: (t) => t.transferType,
      render: (t) => t.transferType.replace('_', ' '),
    },
    {
      id: 'created',
      label: 'Created',
      sortValue: (t) => t.createdAt,
      render: (t) => new Date(t.createdAt).toLocaleDateString(),
    },
  ];
  const draftCols = useListColumns('transfers-manifests-drafts', draftColumns, drafts);
  const cols = useListColumns('transfers-manifests', MANIFEST_COLUMNS, rows);

  async function load() {
    try {
      const res = await api<{ rows: ManifestRow[] }>('/v1/stock-manifests');
      setRows(res.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    api<Location[]>('/v1/business/locations')
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  // Eligible drafts refresh whenever the lane changes.
  useEffect(() => {
    setSelected(new Set());
    if (!fromId || !toId || fromId === toId) {
      setDrafts(null);
      return;
    }
    api<{ data: DraftTransfer[] }>(
      `/v1/stock-transfers?status=draft&unmanifested=true&fromLocationId=${fromId}&toLocationId=${toId}&limit=100`,
    )
      .then((res) => setDrafts(res.data))
      .catch((err) => {
        setDrafts([]);
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }, [fromId, toId]);

  async function build() {
    setBuilding(true);
    try {
      const created = await api<{ id: string }>('/v1/stock-manifests', {
        method: 'POST',
        body: JSON.stringify({
          fromLocationId: fromId,
          toLocationId: toId,
          manifestDate,
          routeName: routeName.trim() || null,
          transferIds: [...selected],
        }),
      });
      toast.success('Manifest built');
      router.push(`/transfers/manifests/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBuilding(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/transfers">All transfers</BackLink>}
        title="Transfer manifests"
        sub="One truck run on one lane — build, print, complete"
      />

      <Stack>
        <Card title="Build a manifest">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void build();
            }}
          >
            <FormGrid cols={2}>
              <Field label="From" required>
                <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                  <option value="">Select…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.locationType === 'warehouse' ? ' (warehouse)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To" required>
                <Select value={toId} onChange={(e) => setToId(e.target.value)}>
                  <option value="">Select…</option>
                  {locations
                    .filter((l) => l.id !== fromId)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.locationType === 'warehouse' ? ' (warehouse)' : ''}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Truck date" required>
                <Input
                  type="date"
                  value={manifestDate}
                  onChange={(e) => setManifestDate(e.target.value)}
                />
              </Field>
              <Field label="Route / truck (optional)">
                <Input
                  value={routeName}
                  onChange={(e) => setRouteName(e.target.value)}
                  placeholder="e.g. Truck 2 AM"
                />
              </Field>
            </FormGrid>

            {drafts ? (
              <>
                <SectionHeading
                  as="h3"
                  title="Draft transfers on this lane"
                  description="Tick the transfers riding this truck."
                />
                {drafts.length === 0 ? (
                  <EmptyState>No unmanifested draft transfers on this lane.</EmptyState>
                ) : (
                  <TableWrap>
                    <table className="table">
                      <thead>
                        <ColumnHeadRow list={draftCols} testIdPrefix="transfers-manifests-drafts" />
                      </thead>
                      <tbody>
                        {draftCols.sorted.map((t) => (
                          <tr key={t.id}>
                            <ColumnCells list={draftCols} row={t} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <ResetColumns list={draftCols} />
                  </TableWrap>
                )}
                <FormActions>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={building || selected.size === 0 || !manifestDate}
                  >
                    {building
                      ? 'Building…'
                      : `Build manifest (${selected.size} transfer${selected.size === 1 ? '' : 's'})`}
                  </Button>
                </FormActions>
              </>
            ) : (
              <p className="field-hint">
                Pick a From and To location to list the draft transfers on that lane.
              </p>
            )}
          </form>
        </Card>

        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && (
          <Card title="Manifests">
            <LoadingRows />
          </Card>
        )}
        {rows && (
          <Card title="Manifests" flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="transfers-manifests" />
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>No manifests yet.</TableEmpty>
                  )}
                  {cols.sorted.map((m) => (
                    <tr key={m.id}>
                      <ColumnCells list={cols} row={m} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
