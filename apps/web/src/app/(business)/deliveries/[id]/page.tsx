'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PackageCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  KeyValue,
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  StatusBadge,
} from '@/components/ui';

/**
 * One truck stop (Day 3). The driver-facing verbs live here: loaded,
 * out for delivery, delivered (which moves the stock and advances the
 * order), failed. Collecting the balance happens on the order page —
 * money and trucks stay separate concerns.
 */

interface DeliveryDetail {
  id: string;
  orderId: string;
  orderNumber: string;
  /** A22 slice 6: 'delivery' | 'return_pickup'. */
  kind?: string;
  rmaNumber?: string | null;
  returnId?: string | null;
  customerName: string | null;
  scheduledDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  notes: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressPhone: string | null;
  balanceDueCents: number;
  lines: { id: string; description: string; quantity: number; lineType: string }[];
}

export default function DeliveryDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const router = useRouter();
  const [d, setD] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setD(await api<DeliveryDetail>(`/v1/deliveries/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/deliveries/${id}${path}`, {
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !d) {
    return (
      <div>
        <PageHeader
          eyebrow={<BackLink href="/deliveries">Calendar</BackLink>}
          title="Delivery not found"
        />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!d) {
    return (
      <div>
        <PageHeader eyebrow={<BackLink href="/deliveries">Calendar</BackLink>} title="Delivery" />
        <LoadingRows rows={4} />
      </div>
    );
  }

  const live = !['delivered', 'failed', 'cancelled'].includes(d.status);
  const address = d.addressLine1
    ? [
        `${d.addressLine1}${d.addressLine2 ? `, ${d.addressLine2}` : ''}`,
        [d.addressCity, d.addressRegion, d.addressPostalCode].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join(' — ')
    : '—';

  return (
    <div className="max-w-[640px]">
      <PageHeader
        eyebrow={<BackLink href="/deliveries">Calendar</BackLink>}
        title={`Delivery — ${d.orderNumber}`}
        meta={
          <span data-testid="delivery-status">
            <StatusBadge status={d.status} />
          </span>
        }
        sub={
          <>
            {d.scheduledDate}
            {d.windowStart
              ? ` · ${d.windowStart.slice(0, 5)}–${d.windowEnd?.slice(0, 5) ?? ''}`
              : ''}
          </>
        }
        actions={
          <LinkButton href={`/orders/${d.orderId}`} variant="secondary" size="sm">
            Open order
          </LinkButton>
        }
      />
      <Stack>
        <Card title="Drop-off">
          <Stack gap="sm">
            <KeyValue
              rows={[
                { label: 'Customer', value: <strong>{d.customerName ?? '—'}</strong> },
                { label: 'Address', value: address },
                { label: 'Phone', value: d.addressPhone ?? '—' },
              ]}
            />
            {d.balanceDueCents > 0 && (
              <Alert tone="warning">
                Collect on delivery: <Money cents={d.balanceDueCents} /> (record it on the order
                page)
              </Alert>
            )}
          </Stack>
        </Card>

        <Card title="On the truck">
          <Stack gap="sm">
            <ul className="m-0 list-disc pl-[18px] text-[13px]">
              {d.lines.map((l) => (
                <li key={l.id}>
                  {l.quantity} × {l.description}
                  {l.lineType === 'special_order' && (
                    <span className="muted"> (special order)</span>
                  )}
                </li>
              ))}
            </ul>
            {d.notes && <p className="muted m-0 text-[12.5px]">{d.notes}</p>}
          </Stack>
        </Card>

        {live && (
          <Card title="Driver actions">
            <Stack gap="sm" className="max-w-[360px]">
              {error && <Alert tone="error">{error}</Alert>}
              {d.status === 'scheduled' && (
                <Button
                  variant="secondary"
                  onClick={() => void act('/status', { status: 'loaded' })}
                  disabled={busy}
                >
                  Mark loaded
                </Button>
              )}
              {(d.status === 'scheduled' || d.status === 'loaded') && (
                <Button
                  variant="secondary"
                  onClick={() => void act('/status', { status: 'out_for_delivery' })}
                  disabled={busy}
                >
                  Out for delivery
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => void act('/complete', {})}
                disabled={busy}
                aria-busy={busy}
                data-testid="mark-delivered"
              >
                <PackageCheck size={16} aria-hidden />
                {d.kind === 'return_pickup'
                  ? `Picked up — goods received back (${d.rmaNumber ?? 'return'})`
                  : 'Delivered — hand over the goods'}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const notes = prompt('What happened? (optional)');
                  if (notes === null) return;
                  void act('/complete', { failed: true, notes: notes || null });
                }}
                disabled={busy}
              >
                Failed — bring it back
              </Button>
              {(d.status === 'scheduled' || d.status === 'loaded') && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await act('/cancel');
                    router.push('/deliveries');
                  }}
                  disabled={busy}
                >
                  Cancel this delivery
                </Button>
              )}
            </Stack>
          </Card>
        )}
      </Stack>
    </div>
  );
}
