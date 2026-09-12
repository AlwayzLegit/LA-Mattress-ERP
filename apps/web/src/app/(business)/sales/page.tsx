'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { type DateRange } from '@/lib/date-range';
import { DateRangePicker, useUrlDateRange } from '@/components/date-range-picker';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
  rowKeys,
} from '@/components/ui';

interface SaleRow {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  customerId: string | null;
  customerName: string | null;
  associateUserId: string | null;
  locationId: string;
  completedAt: string | null;
  createdAt: string;
}

interface SalesPageData {
  data: SaleRow[];
  nextCursor: string | null;
}

const PAGE_LIMIT = 50;

export default function SalesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<SaleRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Created-date window (owner 2026-09-02), kept in the URL as
  // `?range=` / `?start=&end=`. "All time" sends no bounds.
  const [range, setRange, rangeReady] = useUrlDateRange('all');

  const buildUrl = useCallback((query: string, dateRange: DateRange, cursor?: string | null) => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_LIMIT));
    if (query.trim()) params.set('q', query.trim());
    if (dateRange.preset !== 'all') {
      params.set('start', dateRange.start);
      params.set('end', dateRange.end);
    }
    if (cursor) params.set('cursor', cursor);
    return `/v1/sales?${params.toString()}`;
  }, []);

  const load = useCallback(
    async (query: string, dateRange: DateRange) => {
      setError(null);
      setRows(null);
      try {
        const res = await api<SalesPageData>(buildUrl(query, dateRange));
        setRows(res.data);
        setNextCursor(res.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    },
    [buildUrl],
  );

  // First load waits for the URL to be read; every window change reloads.
  // The search text is applied on submit, not per keystroke, so it is
  // read at call time rather than listed as a dependency.
  useEffect(() => {
    if (!rangeReady) return;
    void load(q, range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeReady, range.preset, range.start, range.end, load]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api<SalesPageData>(buildUrl(q, range, nextCursor));
      setRows((prev) => [...(prev ?? []), ...res.data]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void load(q, range);
  }

  const filtered = q.trim() !== '' || range.preset !== 'all';

  return (
    <div>
      {/* P-018: no duplicate "Open register" — the global top bar has it.
          The picker lives in the header, outside the search form, so none
          of its buttons (calendar navigation included) can submit it. */}
      <PageHeader
        title="Sales"
        actions={
          <DateRangePicker
            allowAllTime
            align="right"
            value={range}
            onChange={setRange}
            testid="sales-range"
          />
        }
      />

      <Toolbar>
        <form onSubmit={search} className="flex min-w-0 flex-1 flex-wrap gap-2">
          {/* autoFocus is scanner-friendly: a scanned receipt barcode types
              the number + Enter and finds the sale without the mouse. */}
          <Input
            autoFocus
            name="q"
            aria-label="Find a sale by invoice number or customer name"
            placeholder="Invoice # (scan a receipt) or customer name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-[200px] flex-1 sm:max-w-[340px]"
          />
          <Button type="submit" variant="primary" size="sm">
            Search
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setQ('');
              void load('', range);
            }}
          >
            Clear
          </Button>
        </form>
      </Toolbar>

      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && (
          <Card>
            <LoadingRows rows={5} />
          </Card>
        )}
        {rows && rows.length === 0 && !filtered ? (
          <Card>
            <EmptyState title="No sales yet">
              Ring one up at the register to see it here.
            </EmptyState>
          </Card>
        ) : rows ? (
          <Card flush>
            <TableWrap maxHeight="calc(100vh - 240px)">
              <table className="table table-dense table-sticky">
                <thead>
                  <tr>
                    <th>Sale</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th className="num">Total</th>
                    <th>Date</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <TableEmpty colSpan={6}>
                      {q.trim() ? `No sales match "${q.trim()}".` : 'No sales in this window.'}
                    </TableEmpty>
                  )}
                  {rows.map((s) => (
                    <tr
                      {...rowKeys}
                      key={s.id}
                      onClick={() => router.push(`/sales/${s.id}`)}
                      className="cursor-pointer"
                    >
                      <td>
                        <code>{s.number}</code>
                      </td>
                      <td>
                        {s.customerName ??
                          (s.customerId ? '—' : <span className="muted">Walk-in</span>)}
                      </td>
                      <td>
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="num">
                        <Money cents={s.totalCents} />
                      </td>
                      <td className="nowrap">
                        {new Date(s.completedAt ?? s.createdAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}{' '}
                        {new Date(s.completedAt ?? s.createdAt).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="actions">
                        <LinkButton size="sm" href={`/sales/${s.id}`}>
                          Open
                        </LinkButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        ) : null}

        {nextCursor && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Stack>
    </div>
  );
}
