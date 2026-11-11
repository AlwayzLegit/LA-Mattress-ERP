'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import {
  CustomerPicker,
  customerDisplayName,
  type CustomerRow,
} from '@/components/customer-picker';
import { Money } from '@/components/money';
import { SecurityOverrideDialog } from '@/components/security-override-dialog';
import {
  Alert,
  Button,
  Card,
  Field,
  FormActions,
  FormGrid,
  Input,
  SectionHeading,
  Select,
  Stack,
  TableWrap,
  Toolbar,
} from '@/components/ui';

interface ReasonCode {
  id: string;
  code: string;
  description: string;
}

interface LocationRow {
  id: string;
  name: string;
  isActive: boolean;
}

interface DraftLine {
  variantId: string;
  description: string;
  quantity: string;
  refund: string;
}

interface OrderHit {
  id: string;
  number: string;
}

/** What `POST /v1/order-returns/no-original` hands back — enough to continue. */
export interface NoOriginalReturnCreated {
  id: string;
  rmaNumber: string;
  status: string;
  fulfillment: string;
  amountCents: number;
  pickupDate: string | null;
}

/** The order with exactly this number (case-insensitive), or null. */
export async function findOrderByNumber(number: string): Promise<OrderHit | null> {
  const n = number.trim();
  if (!n) return null;
  const page = await api<{ data: OrderHit[] }>(
    `/v1/orders?number=${encodeURIComponent(n)}&limit=1`,
  );
  return page.data[0] ?? null;
}

/**
 * Return without an original invoice (SEC-RTN-NOORIG): the customer has
 * no findable order — pre-cutover STORIS sale, lost paperwork. Store
 * credit only, goods to As-Is review, logged for loss prevention, and a
 * non-manager finishes through the override dialog.
 *
 * Two homes (dispatcher 2026-11-06, STORIS exchange 03109559 against
 * invoice 03108303 from before the cutover):
 *   - `mode="return"` on the Returns page: goods in hand, credit issued
 *     now ("Complete return").
 *   - `mode="exchange"` on New Exchange: the items coming back from the
 *     STORIS invoice, dropped off now or picked up by the truck on a
 *     date; the register then opens for the replacement and binds the
 *     two into one exchange. A pickup return waits (no credit until the
 *     goods are back) and its stop is booked when the exchange binds.
 */
export function NoOriginalReturnForm({
  mode,
  onCreated,
}: {
  mode: 'return' | 'exchange';
  onCreated: (ret: NoOriginalReturnCreated) => Promise<void> | void;
}) {
  const exchange = mode === 'exchange';
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [referenced, setReferenced] = useState('');
  /** The claimed number is a real order — this is not a no-invoice return. */
  const [claimedHit, setClaimedHit] = useState<OrderHit | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<
    { variantId: string; productName: string; variantName: string | null; sku: string | null }[]
  >([]);
  const [fulfillment, setFulfillment] = useState<'drop_off' | 'pickup'>(
    exchange ? 'pickup' : 'drop_off',
  );
  const [pickupDate, setPickupDate] = useState('');
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The document the override dialog wrote, handed on once it closes. */
  const created = useRef<NoOriginalReturnCreated | null>(null);

  useEffect(() => {
    api<LocationRow[]>('/v1/business/locations')
      .then((locs) => {
        const active = locs.filter((l) => l.isActive);
        setLocations(active);
        if (active[0]) setLocationId((prev) => prev || active[0]!.id);
      })
      .catch(() => setLocations([]));
    api<ReasonCode[]>('/v1/reason-codes?usageClass=return')
      .then(setReasonCodes)
      .catch(() => setReasonCodes([]));
  }, []);

  async function searchVariants() {
    if (!search.trim()) return;
    try {
      setResults(
        await api<
          {
            variantId: string;
            productName: string;
            variantName: string | null;
            sku: string | null;
          }[]
        >(`/v1/pos/lookup?q=${encodeURIComponent(search.trim())}&limit=200`),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const pickup = exchange && fulfillment === 'pickup';

  function buildBody() {
    return {
      customerId: customer?.id,
      locationId,
      referencedOrderNumber: referenced.trim() || null,
      reason: reason || null,
      ...(exchange ? { fulfillment, pickupDate: pickup ? pickupDate || null : null } : {}),
      lines: lines.map((l) => ({
        variantId: l.variantId,
        quantity: Number(l.quantity),
        unitRefundCents: Math.round(Number(l.refund) * 100),
        ...(reasonCodeId ? { reasonCodeId } : {}),
      })),
    };
  }

  function validate(): boolean {
    if (!customer) {
      toast.error('Pick (or create) the customer — they receive the store credit.');
      return false;
    }
    if (!locationId) {
      toast.error('Pick the location taking the goods back.');
      return false;
    }
    if (exchange && !referenced.trim()) {
      toast.error('Enter the STORIS invoice number — it prints on the exchange ticket.');
      return false;
    }
    if (lines.length === 0) {
      toast.error('Add at least one item.');
      return false;
    }
    for (const l of lines) {
      const q = Number(l.quantity);
      const r = Math.round(Number(l.refund) * 100);
      if (!Number.isInteger(q) || q <= 0 || !Number.isFinite(r) || r < 0) {
        toast.error(`Enter a quantity and refund amount for ${l.description}.`);
        return false;
      }
    }
    if (reasonCodes.length > 0 && !reasonCodeId) {
      toast.error('Select a return reason.');
      return false;
    }
    if (pickup && !pickupDate) {
      toast.error('Pick the pickup date — it books the stop on the drivers’ calendar.');
      return false;
    }
    return true;
  }

  function reset() {
    setCustomer(null);
    setReferenced('');
    setClaimedHit(null);
    setReason('');
    setLines([]);
    setPickupDate('');
  }

  async function finish(res: NoOriginalReturnCreated) {
    if (!exchange) {
      toast.success(
        `${res.rmaNumber} completed — ${(res.amountCents / 100).toFixed(2)} in store credit issued; goods staged in As-Is review.`,
      );
    }
    reset();
    await onCreated(res);
  }

  async function submit() {
    if (!validate() || busy) return;
    setBusy(true);
    try {
      const res = await api<NoOriginalReturnCreated>('/v1/order-returns/no-original', {
        method: 'POST',
        body: JSON.stringify(buildBody()),
      });
      await finish(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OVERRIDE_REQUIRED') {
        setOverrideOpen(true);
      } else {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const total = lines.reduce((s, l) => {
    const cents = Math.round(Number(l.refund) * 100);
    const q = Number(l.quantity);
    return s + (Number.isFinite(cents) && Number.isInteger(q) ? cents * q : 0);
  }, 0);

  return (
    <Card
      title={
        exchange ? 'Original invoice not on file (STORIS)' : 'Return without an original invoice'
      }
      description={
        exchange ? (
          <>
            The sale was written in STORIS before the cutover, so there is no order to pick lines
            from. Enter the STORIS invoice number and the items coming back with the credit each
            earns; say whether the truck picks them up or the customer brought them in. The register
            then opens for the replacement and the credit nets against it. Manager approval; store
            credit only; logged for loss prevention.
          </>
        ) : (
          <>
            For a customer whose invoice can&apos;t be found (pre-cutover sale, lost paperwork). If
            there is an invoice number, use <strong>Return from an invoice</strong> above. This path
            refunds as <strong>store credit only</strong>, stages the goods in As-Is review, and is
            logged for loss prevention.
          </>
        )
      }
      data-testid={exchange ? 'precutover-exchange-card' : undefined}
    >
      <SecurityOverrideDialog
        open={overrideOpen}
        title={
          exchange
            ? 'Pre-cutover exchange — manager approval needed'
            : 'No-original return — manager approval needed'
        }
        usageClass="exception"
        submitLabel={exchange ? 'Approve and continue' : 'Approve return'}
        perform={(payload) =>
          api<NoOriginalReturnCreated>('/v1/order-returns/no-original', {
            method: 'POST',
            body: JSON.stringify({ ...buildBody(), override: payload.override }),
          }).then((res) => {
            created.current = res;
          })
        }
        onClose={() => setOverrideOpen(false)}
        onSuccess={() => {
          const res = created.current;
          created.current = null;
          if (res) void finish(res);
        }}
      />
      {pickingCustomer && (
        <CustomerPicker
          onPick={(c) => {
            setCustomer(c);
            setPickingCustomer(false);
          }}
          onCancel={() => setPickingCustomer(false)}
        />
      )}

      <FormGrid cols={2}>
        <Field label="Customer (receives the credit)" required>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPickingCustomer(true)}
            data-testid="noorig-customer"
          >
            {customer ? customerDisplayName(customer) : 'Pick or create customer'}
          </Button>
        </Field>
        <Field label={exchange ? 'Store writing the exchange' : 'Location'} required>
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={exchange ? 'STORIS invoice number' : 'Order # the customer claims (optional)'}
          hint={
            exchange ? 'Prints on the exchange ticket as the original invoice' : 'Recorded verbatim'
          }
          required={exchange}
        >
          <Input
            value={referenced}
            onChange={(e) => {
              setReferenced(e.target.value);
              setClaimedHit(null);
            }}
            onBlur={() => {
              findOrderByNumber(referenced)
                .then(setClaimedHit)
                .catch(() => setClaimedHit(null));
            }}
            placeholder={exchange ? 'e.g. 03108303' : undefined}
            data-testid="noorig-claimed"
          />
        </Field>
        {reasonCodes.length > 0 ? (
          <Field label="Return reason" required>
            <Select value={reasonCodeId} onChange={(e) => setReasonCodeId(e.target.value)}>
              <option value="">— Pick —</option>
              {reasonCodes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} — {r.description}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {exchange && (
          <>
            <Field label="How the goods come back" required>
              <Select
                value={fulfillment}
                onChange={(e) => setFulfillment(e.target.value as 'drop_off' | 'pickup')}
                data-testid="noorig-fulfillment"
              >
                <option value="pickup">Our truck picks them up (with the delivery)</option>
                <option value="drop_off">Customer brought them in — goods in hand</option>
              </Select>
            </Field>
            {pickup && (
              <Field
                label="Pickup date"
                hint="Books a pickup stop on the drivers’ calendar once the exchange is written"
                required
              >
                <Input
                  type="date"
                  value={pickupDate}
                  onChange={(e) => setPickupDate(e.target.value)}
                  data-testid="noorig-pickup-date"
                />
              </Field>
            )}
          </>
        )}
      </FormGrid>

      {claimedHit && (
        <Alert tone="warning" data-testid="noorig-invoice-found">
          {claimedHit.number} is in the ERP —{' '}
          {exchange ? (
            <>
              exchange it from{' '}
              <Link href={`/exchanges/new?originalOrderId=${claimedHit.id}`}>
                the original order
              </Link>{' '}
              instead; the register picks the delivered lines from the invoice.
            </>
          ) : (
            <>
              return it from <Link href={`/orders/${claimedHit.id}/full#returns`}>the order</Link>{' '}
              instead. That form refunds against the invoice and has the restocking fee, pickup fee
              and driver pickup date.
            </>
          )}
        </Alert>
      )}

      <SectionHeading
        as="h3"
        title={exchange ? 'Items coming back from the STORIS invoice' : 'Items coming back'}
      />
      <Toolbar>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void searchVariants();
            }
          }}
          placeholder="Add item — name, SKU, or barcode"
          aria-label="Add item (name, SKU, or barcode)"
          data-testid="noorig-item-search"
        />
        <Button variant="secondary" size="sm" onClick={() => void searchVariants()}>
          Search
        </Button>
      </Toolbar>
      {results.length === 200 && (
        <Alert tone="info">Many items match — refine your search to find the right one.</Alert>
      )}
      <Stack>
        {results.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {results.slice(0, 8).map((r) => (
              <Button
                key={r.variantId}
                size="sm"
                variant="ghost"
                disabled={lines.some((l) => l.variantId === r.variantId)}
                onClick={() => {
                  setLines((prev) => [
                    ...prev,
                    {
                      variantId: r.variantId,
                      description: [r.productName, r.variantName].filter(Boolean).join(' — '),
                      quantity: '1',
                      refund: '0.00',
                    },
                  ]);
                  setResults([]);
                  setSearch('');
                }}
              >
                + {[r.productName, r.variantName].filter(Boolean).join(' — ')}
                {r.sku ? ` (${r.sku})` : ''}
              </Button>
            ))}
          </div>
        )}

        {lines.length > 0 && (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">{exchange ? 'Credit each ($)' : 'Refund each ($)'}</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.variantId}>
                    <td>{l.description}</td>
                    <td className="num">
                      <Input
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                          )
                        }
                        className="w-[70px]"
                        aria-label={`Quantity for ${l.description}`}
                      />
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        value={l.refund}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, refund: e.target.value } : x)),
                          )
                        }
                        className="w-[90px]"
                        aria-label={`${exchange ? 'Credit' : 'Refund'} each for ${l.description}`}
                        data-testid="noorig-refund-each"
                      />
                    </td>
                    <td className="actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Stack>

      <FormActions
        start={
          total > 0 ? (
            <span>
              {exchange ? 'Credit toward the replacement: ' : 'Store credit to issue: '}
              <Money cents={total} />
              {pickup ? ' — applied when the truck brings the goods back' : ''}
            </span>
          ) : undefined
        }
      >
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={busy}
          data-testid={exchange ? 'precutover-continue' : undefined}
        >
          <Undo2 size={14} />
          {busy ? 'Working…' : exchange ? 'Continue to the replacement' : 'Complete return'}
        </Button>
      </FormActions>
    </Card>
  );
}
