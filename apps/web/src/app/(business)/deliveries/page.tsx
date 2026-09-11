'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  Button,
  LinkButton,
  PageHeader,
  SectionHeading,
  Stack,
  StatusBadge,
} from '@/components/ui';

/**
 * Delivery calendar (STORIS cutover Day 3; owner ask 2026-08-30: a full
 * month on screen, no paging). Five week-rows of seven day columns — 35
 * days starting from the current week — each cell one day, each card one
 * truck stop. Click through for the day-sheet (print) or the delivery
 * itself. Drag a card onto any visible day to reschedule it.
 */

interface DeliveryRow {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  routePosition: number | null;
  addressLine1: string | null;
  addressCity: string | null;
  balanceDueCents: number;
  fulfillmentType: string;
  /** A22 slice 6: 'delivery' | 'return_pickup' (the truck collects a return). */
  kind?: string;
  rmaNumber?: string | null;
  lines: { id: string; description: string; quantity: number }[];
}

const STATUS_COLOR: Record<string, string> = {
  scheduled: 'var(--info)',
  loaded: 'var(--brand)',
  out_for_delivery: 'var(--warning)',
  delivered: 'var(--success)',
  failed: 'var(--danger)',
  cancelled: 'var(--text-muted)',
};

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setDate(out.getDate() - out.getDay()); // Sunday start
  out.setHours(0, 0, 0, 0);
  return out;
}
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DeliveriesPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  // 5 week-rows × 7 days = 35 days on screen (owner: "30 days worth"),
  // aligned to full Sunday–Saturday weeks so the grid stays readable.
  const days = useMemo(
    () =>
      Array.from({ length: 35 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return d;
      }),
    [weekStart],
  );
  const weeks = useMemo(() => {
    const out: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [days]);

  async function load() {
    try {
      const from = fmtDate(days[0]!);
      const to = fmtDate(days[days.length - 1]!);
      setRows(await api<DeliveryRow[]>(`/v1/deliveries?from=${from}&to=${to}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, DeliveryRow[]>();
    for (const d of days) map.set(fmtDate(d), []);
    for (const r of rows) map.get(r.scheduledDate)?.push(r);
    return map;
  }, [rows, days]);

  async function reschedule(id: string, date: string) {
    try {
      await api(`/v1/deliveries/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduledDate: date }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function shiftWeek(deltaDays: number) {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + deltaDays);
    setWeekStart(next);
  }

  const today = fmtDate(new Date());
  const rangeLabel = `${days[0]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${days[
    days.length - 1
  ]!.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div>
      <PageHeader
        title="Deliveries"
        meta={<span>{rangeLabel}</span>}
        sub={
          <>
            Drag a card to another day to reschedule. Schedule new deliveries from an order&apos;s
            page. Click a day&apos;s heading for its printable day-sheet.
          </>
        }
        actions={
          <>
            <LinkButton href="/deliveries/search" variant="secondary" size="sm">
              Search schedules
            </LinkButton>
            <LinkButton href="/deliveries/confirm" variant="secondary" size="sm">
              Confirm schedule
            </LinkButton>
            <LinkButton href="/deliveries/dispatch" variant="secondary" size="sm">
              Dispatch
            </LinkButton>
            <Button size="sm" variant="secondary" onClick={() => shiftWeek(-7)}>
              ← Prev week
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setWeekStart(startOfWeek(new Date()))}
            >
              Today
            </Button>
            <Button size="sm" variant="secondary" onClick={() => shiftWeek(7)}>
              Next week →
            </Button>
          </>
        }
      />
      <Stack gap="sm">
        {error && <Alert tone="error">{error}</Alert>}

        {weeks.map((week) => (
          <div key={fmtDate(week[0]!)} className="overflow-x-auto">
            <div className="flex gap-2 lg:grid lg:grid-cols-7">
              {week.map((d) => {
                const key = fmtDate(d);
                const list = byDay.get(key) ?? [];
                const isToday = key === today;
                return (
                  <div
                    key={key}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragId) void reschedule(dragId, key);
                      setDragId(null);
                    }}
                    className="min-w-[160px] flex-1 rounded-[var(--radius)] p-2 lg:min-w-0"
                    style={{
                      // Today is the one data-driven cell colour.
                      background: isToday ? 'var(--brand-soft)' : 'var(--neutral-soft)',
                      minHeight: 130,
                    }}
                  >
                    <SectionHeading
                      as="h3"
                      title={
                        <Link
                          href={`/deliveries/day/${key}`}
                          title="Open the printable day-sheet"
                          className="no-underline"
                          style={{
                            // Today's heading takes the brand-soft text colour (data-driven).
                            color: isToday ? 'var(--brand-soft-text)' : 'inherit',
                          }}
                        >
                          {d.toLocaleDateString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </Link>
                      }
                      actions={<span className="muted">{list.length || ''}</span>}
                    />
                    <div className="flex flex-col gap-1.5">
                      {list.map((r) => (
                        <Link
                          key={r.id}
                          href={`/deliveries/${r.id}`}
                          draggable={r.status === 'scheduled' || r.status === 'loaded'}
                          onDragStart={() => setDragId(r.id)}
                          data-testid="delivery-card"
                          className="card card-hover block cursor-pointer text-inherit no-underline"
                          style={{
                            // Status colour on the left edge is data-driven.
                            borderLeft: `4px solid ${STATUS_COLOR[r.status] ?? 'var(--text-muted)'}`,
                          }}
                        >
                          <div className="font-semibold">
                            {r.kind === 'return_pickup' ? (
                              <>
                                <span className="badge badge-warning" data-testid="pickup-badge">
                                  Pickup
                                </span>{' '}
                                {r.rmaNumber ?? r.orderNumber}
                              </>
                            ) : (
                              r.orderNumber
                            )}
                          </div>
                          <div className="text-[var(--text-secondary)]">
                            {r.customerName ?? '—'}
                            {r.addressCity ? ` · ${r.addressCity}` : ''}
                          </div>
                          {(r.windowStart || r.windowEnd) && (
                            <div className="text-[var(--text-secondary)]">
                              {r.windowStart?.slice(0, 5)}–{r.windowEnd?.slice(0, 5)}
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-2">
                            <StatusBadge status={r.status} />
                            {r.balanceDueCents > 0 && (
                              <span className="text-[var(--warning)]">
                                <Money cents={r.balanceDueCents} /> due
                              </span>
                            )}
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </Stack>
    </div>
  );
}
