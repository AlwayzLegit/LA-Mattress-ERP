'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import { LoadMore } from '@/components/load-more';
import { useCursorList } from '@/lib/use-cursor-list';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
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
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * Service board (STORIS cutover G6): every open ticket by status, plus
 * the intake form. Tickets flow intake → awaiting parts → in service →
 * ready (customer emailed) → completed.
 */

interface Ticket {
  id: string;
  number: string;
  status: string;
  customerName: string | null;
  itemDescription: string | null;
  issue: string;
  warranty: boolean;
  totalCents: number;
  balanceDueCents: number;
  createdAt: string;
}
interface LocationRow {
  id: string;
  name: string;
}
interface CustomerRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

const COLUMNS = [
  { key: 'intake', label: 'Intake' },
  { key: 'awaiting_parts', label: 'Awaiting parts' },
  { key: 'in_service', label: 'In service' },
  { key: 'ready', label: 'Ready for pickup' },
] as const;

/** The "Recently completed" list under the board. */
const COMPLETED_COLUMNS: ColumnDef<Ticket>[] = [
  {
    id: 'number',
    label: 'Ticket',
    sortValue: (t) => t.number,
    render: (t) => <Link href={`/service/${t.id}`}>{t.number}</Link>,
  },
  {
    id: 'customer',
    label: 'Customer',
    sortValue: (t) => t.customerName,
    render: (t) => t.customerName,
  },
  {
    id: 'item',
    label: 'Item',
    sortValue: (t) => t.itemDescription ?? t.issue,
    render: (t) => t.itemDescription ?? t.issue,
  },
  {
    id: 'total',
    label: 'Total',
    num: true,
    sortValue: (t) => t.totalCents,
    render: (t) => formatMoney(t.totalCents),
  },
];

export default function ServiceBoardPage() {
  const router = useRouter();
  const list = useCursorList<Ticket>('/v1/service-orders');
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [showIntake, setShowIntake] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [customerQ, setCustomerQ] = useState('');
  const [customerHits, setCustomerHits] = useState<CustomerRow[]>([]);
  const [customerHasMore, setCustomerHasMore] = useState(false);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [itemDescription, setItemDescription] = useState('');
  const [issue, setIssue] = useState('');
  const [warranty, setWarranty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tickets = list.rows;

  async function load() {
    void list.load();
    try {
      const locs = await api<LocationRow[]>('/v1/pos/locations');
      setLocations(locs);
      if (locs[0] && !locationId) setLocationId(locs[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function searchCustomers(q: string) {
    setCustomerQ(q);
    if (q.trim().length < 2) {
      setCustomerHits([]);
      setCustomerHasMore(false);
      return;
    }
    try {
      const res = await api<{ data: CustomerRow[]; nextCursor: string | null }>(
        `/v1/customers?q=${encodeURIComponent(q)}&limit=20`,
      );
      setCustomerHits(res.data);
      setCustomerHasMore(res.nextCursor != null);
    } catch {
      setCustomerHits([]);
      setCustomerHasMore(false);
    }
  }

  async function createTicket() {
    if (!customer || !issue.trim() || !locationId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<Ticket>('/v1/service-orders', {
        method: 'POST',
        body: JSON.stringify({
          locationId,
          customerId: customer.id,
          itemDescription: itemDescription.trim() || undefined,
          issue: issue.trim(),
          warranty,
        }),
      });
      router.push(`/service/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const completed = tickets?.filter((t) => t.status === 'completed').slice(0, 10) ?? [];
  const completedCols = useListColumns('service', COMPLETED_COLUMNS, completed);

  return (
    <div>
      <PageHeader
        title="Service"
        actions={
          <Button
            variant="primary"
            onClick={() => setShowIntake((v) => !v)}
            data-testid="new-ticket"
          >
            {showIntake ? <X size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
            {showIntake ? 'Close intake' : '+ New ticket'}
          </Button>
        }
      />
      <Stack>
        {(error ?? list.error) && <Alert tone="error">{error ?? list.error}</Alert>}

        {showIntake && (
          <Card title="Intake" data-testid="intake-form">
            <FormGrid cols={2}>
              <Field label="Location">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* `as="div"`, not a <label>: label activation would forward the
                  click on a result row to whatever control renders next
                  (the "change" button), instantly un-picking the customer. */}
              <Field label="Customer" as="div">
                {customer ? (
                  // Wrapped so `.field > .input` (block, for real inputs)
                  // does not flatten this flex row.
                  <div>
                    <div className="input flex items-center justify-between gap-2">
                      <span data-testid="intake-customer">
                        {customer.firstName} {customer.lastName}
                      </span>
                      <button type="button" className="btn-link" onClick={() => setCustomer(null)}>
                        change
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Input
                      value={customerQ}
                      onChange={(e) => void searchCustomers(e.target.value)}
                      placeholder="Search name / email / phone…"
                      data-testid="intake-customer-search"
                    />
                    {customerHits.length > 0 && (
                      <div className="mt-1 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)]">
                        {customerHits.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="popover-option"
                            data-testid="intake-customer-hit"
                            onClick={() => {
                              setCustomer(c);
                              setCustomerHits([]);
                              setCustomerHasMore(false);
                            }}
                          >
                            {c.firstName} {c.lastName} {c.email ? `· ${c.email}` : ''}
                          </button>
                        ))}
                        {customerHasMore && (
                          <p
                            className="muted m-0 px-2.5 py-1.5 text-xs"
                            data-testid="intake-customer-more"
                          >
                            more matches — keep typing to narrow
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </Field>
              <Field label="Item">
                <Input
                  value={itemDescription}
                  onChange={(e) => setItemDescription(e.target.value)}
                  placeholder="e.g. Queen adjustable base"
                  data-testid="intake-item"
                />
              </Field>
              <Field label="Issue" required>
                <Input
                  value={issue}
                  onChange={(e) => setIssue(e.target.value)}
                  placeholder="What's wrong?"
                  data-testid="intake-issue"
                />
              </Field>
            </FormGrid>
            <FormActions
              start={
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={warranty}
                    onChange={(e) => setWarranty(e.target.checked)}
                    data-testid="intake-warranty"
                  />
                  Warranty work (parts &amp; labor price at $0)
                </label>
              }
            >
              <Button
                variant="primary"
                onClick={() => void createTicket()}
                disabled={busy || !customer || !issue.trim()}
                data-testid="create-ticket"
              >
                {busy ? 'Creating…' : 'Create ticket'}
              </Button>
            </FormActions>
          </Card>
        )}

        {!tickets && !error && !list.error && <LoadingRows rows={4} />}

        {tickets && (
          <div className="overflow-x-auto pb-2">
            <div className="flex gap-3 lg:grid lg:grid-cols-4">
              {COLUMNS.map((col) => {
                const rows = tickets.filter((t) => t.status === col.key);
                return (
                  <div
                    key={col.key}
                    className="min-w-[240px] flex-1 rounded-[var(--radius)] bg-[var(--neutral-soft)] p-2 lg:min-w-0"
                  >
                    <SectionHeading as="h3" title={`${col.label} (${rows.length})`} />
                    <Stack gap="sm">
                      {rows.map((t) => (
                        <Link
                          key={t.id}
                          href={`/service/${t.id}`}
                          className="card card-hover block text-inherit no-underline"
                          data-testid={`ticket-${t.number}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <strong>{t.number}</strong>
                            {t.warranty && <span className="badge badge-warning">WARRANTY</span>}
                          </div>
                          <p className="card-desc">{t.customerName}</p>
                          <p className="card-desc muted">{t.itemDescription ?? t.issue}</p>
                          {t.balanceDueCents > 0 && (
                            <p className="card-desc text-[var(--danger)]">
                              due {formatMoney(t.balanceDueCents)}
                            </p>
                          )}
                        </Link>
                      ))}
                      {rows.length === 0 && <p className="field-hint">No tickets</p>}
                    </Stack>
                  </div>
                );
              })}
            </div>
            <LoadMore state={list} noun="tickets" />
          </div>
        )}

        {completed.length > 0 && (
          <Card title="Recently completed" flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={completedCols} testIdPrefix="service" />
                </thead>
                <tbody>
                  {completedCols.sorted.map((t) => (
                    <tr key={t.id}>
                      <ColumnCells list={completedCols} row={t} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={completedCols} />
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
