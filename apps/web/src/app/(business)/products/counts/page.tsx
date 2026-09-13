'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ProductsNav } from '@/components/products-nav';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  FormActions,
  FormGrid,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  rowKeys,
  useListColumns,
} from '@/components/ui';

interface Location {
  id: string;
  name: string;
  isActive: boolean;
}

interface CountRow {
  id: string;
  locationId: string;
  locationName: string;
  status: string;
  countDate: string;
  frozenAt: string;
  postedAt: string | null;
  lineCount: number;
  countedCount: number;
}

const COUNT_COLUMNS: ColumnDef<CountRow>[] = [
  {
    id: 'date',
    label: 'Date',
    sortValue: (c) => c.countDate,
    render: (c) => new Date(`${c.countDate}T00:00:00`).toLocaleDateString(),
  },
  {
    id: 'location',
    label: 'Location',
    sortValue: (c) => c.locationName,
    render: (c) => c.locationName,
  },
  {
    id: 'status',
    label: 'Status',
    sortValue: (c) => c.status,
    render: (c) => <StatusBadge status={c.status} />,
  },
  {
    id: 'progress',
    label: 'Progress',
    num: true,
    sortValue: (c) => (c.lineCount > 0 ? c.countedCount / c.lineCount : 0),
    render: (c) => `${c.countedCount}/${c.lineCount} counted`,
  },
  {
    id: 'posted',
    label: 'Posted',
    sortValue: (c) => c.postedAt,
    render: (c) => (c.postedAt ? new Date(c.postedAt).toLocaleString() : '—'),
  },
  {
    id: 'actions',
    label: '',
    srLabel: 'Actions',
    className: 'actions',
    fixed: true,
    render: (c) => (
      <LinkButton
        size="sm"
        variant="ghost"
        href={`/products/counts/${c.id}`}
        onClick={(e) => e.stopPropagation()}
      >
        Open
      </LinkButton>
    ),
  },
];

export default function PhysicalCountsPage() {
  const router = useRouter();
  const list = useCursorList<CountRow>('/v1/inventory/counts');
  const [locations, setLocations] = useState<Location[]>([]);
  const [newLocationId, setNewLocationId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counts = list.rows;
  const cols = useListColumns('products-counts', COUNT_COLUMNS, counts);

  useEffect(() => {
    void list.load();
    api<Location[]>('/v1/business/locations')
      .then((locs) => {
        const active = locs.filter((l) => l.isActive);
        setLocations(active);
        setNewLocationId((prev) => prev || (active[0]?.id ?? ''));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCount() {
    if (!newLocationId || creating) return;
    setCreating(true);
    try {
      const res = await api<{ id: string; lineCount: number }>('/v1/inventory/counts', {
        method: 'POST',
        body: JSON.stringify({ locationId: newLocationId }),
      });
      toast.success(`Count started — ${res.lineCount} line(s) frozen`);
      router.push(`/products/counts/${res.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/products">Products</BackLink>}
        title="Physical counts"
      />
      <ProductsNav />

      <Stack>
        <Card
          title="Start a count"
          description="Freezes a snapshot of stock at the chosen location. The store keeps selling during the count — mid-count sales are netted out at post time."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void startCount();
            }}
          >
            <FormGrid cols={3}>
              <Field label="Location" required>
                <Select value={newLocationId} onChange={(e) => setNewLocationId(e.target.value)}>
                  <option value="">— Pick a location —</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormGrid>
            <FormActions>
              <Button type="submit" variant="primary" disabled={!newLocationId || creating}>
                {creating ? 'Freezing…' : 'Start count'}
              </Button>
            </FormActions>
          </form>
        </Card>

        {(error ?? list.error) && <Alert tone="error">{error ?? list.error}</Alert>}

        {counts == null ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="products-counts" />
                </thead>
                <tbody>
                  {counts.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      No physical counts yet. Start one above.
                    </TableEmpty>
                  )}
                  {cols.sorted.map((c) => (
                    <tr
                      {...rowKeys}
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/products/counts/${c.id}`)}
                    >
                      <ColumnCells list={cols} row={c} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
            <LoadMore state={list} noun="counts" />
          </Card>
        )}
      </Stack>
    </div>
  );
}
