'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Repeat, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Money } from '@/components/money';
import {
  Alert,
  BackLink,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  Input,
  KeyValue,
  LoadingRows,
  PageHeader,
  Select,
  Stack,
  TableWrap,
  Toolbar,
} from '@/components/ui';

interface OrderLine {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  qtyFulfilled: number;
  qtyReturned: number;
  unitPriceCents: number;
  totalCents: number;
  taxCents: number;
}
interface OrderDetail {
  id: string;
  number: string;
  status: string;
  customerId: string;
  locationId: string;
  lines: OrderLine[];
}
interface VariantHit {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  priceCents: number;
}
interface SaleLine {
  variantId: string;
  description: string;
  quantity: number;
  /** List price for the on-screen estimate; the order prices server-side. */
  priceCents: number;
  /** '' = the order's location; anything else ships as sourceLocationId. */
  sourceLocationId: string;
}
interface ReasonCode {
  id: string;
  code: string;
  description: string | null;
}
interface LocationRow {
  id: string;
  name: string;
  locationType?: string;
}
const TENDERS = [
  { value: 'card', label: 'Credit card' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'zelle', label: 'Zelle' },
] as const;

/**
 * Enter an Exchange (docs/erp-exchange): pick what comes back from the
 * original order, pick the replacement, and the credit nets against the
 * new sale in one settlement. Composes the existing surfaces: the
 * replacement order, the return authorization, and the exchange
 * container that binds them.
 */
function NewExchangeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const originalOrderId = params.get('originalOrderId') ?? '';

  const [orderNumberQuery, setOrderNumberQuery] = useState('');
  const [original, setOriginal] = useState<OrderDetail | null>(null);
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [saleLines, setSaleLines] = useState<SaleLine[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<VariantHit[]>([]);
  const [evenExchange, setEvenExchange] = useState(false);
  const [feeOverride, setFeeOverride] = useState('');
  const [goodsInHand, setGoodsInHand] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Owner 2026-08-30: the typed reason is the record — no coded-reason
  // picker on exchanges; the server accepts free text.
  const [reasonText, setReasonText] = useState('');
  // Locations for "return goods to" and per-line "inventory from".
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [returnToId, setReturnToId] = useState(''); // '' = the order's location
  // Collect the remaining balance (server-computed, exact) right after
  // the settlement applies the return credit.
  const [collectNow, setCollectNow] = useState(true);
  const [payMethod, setPayMethod] = useState<(typeof TENDERS)[number]['value']>('card');
  // A22 slice 6 (STORIS Enter an Exchange): the return salesperson and
  // how any credit left after the replacement goes back to the customer.
  const [members, setMembers] = useState<{ membershipId: string; name: string | null }[]>([]);
  const [returnSalespersonId, setReturnSalespersonId] = useState('');
  const [refundTender, setRefundTender] = useState<'store_credit' | 'original' | 'cash' | 'check'>(
    'store_credit',
  );
  useEffect(() => {
    api<LocationRow[]>('/v1/business/locations')
      .then(setLocations)
      .catch(() => setLocations([]));
    api<{ membershipId: string; name: string | null }[]>('/v1/business/members')
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);
  const locationName = (id: string) => locations.find((l) => l.id === id)?.name ?? 'this store';

  async function loadOriginal(id: string) {
    try {
      setError(null);
      const detail = await api<OrderDetail>(`/v1/orders/${id}`);
      setOriginal(detail);
      setReturnQty({});
      setSaleLines([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    if (originalOrderId) void loadOriginal(originalOrderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalOrderId]);

  async function findByNumber() {
    const q = orderNumberQuery.trim();
    if (!q) return;
    try {
      const page = await api<{ data: { id: string; number: string }[] }>(
        `/v1/orders?number=${encodeURIComponent(q)}`,
      );
      const hit = page.data?.[0];
      if (!hit) {
        setError(`No order matches "${q}". Pre-cutover exchange? Use Returns > No original first.`);
        return;
      }
      await loadOriginal(hit.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const returnable = (l: OrderLine) => l.qtyFulfilled - l.qtyReturned;
  const pickedReturns = original
    ? original.lines
        .filter((l) => (returnQty[l.id] ?? 0) > 0)
        .map((l) => ({ line: l, quantity: returnQty[l.id]! }))
    : [];
  // The credit is what the customer actually paid per unit — line total
  // (after discounts) plus its tax share — matching the server's
  // per-unit computation at return authorization exactly.
  const perUnitCredit = (l: OrderLine) => Math.round((l.totalCents + l.taxCents) / l.quantity);
  const returnCreditCents = pickedReturns.reduce(
    (s, p) => s + perUnitCredit(p.line) * p.quantity,
    0,
  );

  function copyReturnsToSale() {
    setSaleLines(
      pickedReturns
        .filter((p) => p.line.variantId)
        .map((p) => ({
          variantId: p.line.variantId!,
          description: p.line.description,
          quantity: p.quantity,
          priceCents: p.line.unitPriceCents,
          sourceLocationId: '',
        })),
    );
  }

  // On-screen estimate only — the replacement order prices at list
  // server-side and the collected balance is read back exactly.
  const replacementEstCents = saleLines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
  const feeEstCents = feeOverride.trim() !== '' ? Math.round(Number(feeOverride) * 100) : 0;
  const estNetCents = replacementEstCents - Math.max(0, returnCreditCents - feeEstCents);

  async function searchVariants() {
    if (!search.trim()) return setResults([]);
    try {
      setResults(
        await api<VariantHit[]>(`/v1/pos/lookup?q=${encodeURIComponent(search.trim())}&limit=200`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Steps 1–2 create real documents; if a later step fails, remember
  // them so a retry binds the SAME documents instead of writing a
  // duplicate order and RMA.
  const [createdLegs, setCreatedLegs] = useState<{
    saleOrderId: string | null;
    returnId: string | null;
  }>({ saleOrderId: null, returnId: null });

  async function submit() {
    if (!original) return;
    if (pickedReturns.length === 0) return setError('Pick at least one item to return.');
    if (saleLines.length === 0) return setError('Add at least one replacement item.');
    setSaving(true);
    setError(null);
    let saleOrderId = createdLegs.saleOrderId;
    let returnId = createdLegs.returnId;
    try {
      // 1. The replacement order, written against the original (reused
      // on retry after a failed bind).
      if (!saleOrderId) {
        const replacement = await api<{ id: string }>(`/v1/orders/${original.id}/exchange`, {
          method: 'POST',
          body: JSON.stringify({
            locationId: original.locationId,
            confirm: true,
            lines: saleLines.map((l) => ({
              variantId: l.variantId,
              quantity: l.quantity,
              // The price on screen is the price charged — an edited
              // price below list hits the same discount gates as New
              // Sale when the order is written.
              unitPriceCents: l.priceCents,
              ...(l.sourceLocationId && l.sourceLocationId !== original.locationId
                ? { sourceLocationId: l.sourceLocationId }
                : {}),
            })),
          }),
        });
        saleOrderId = replacement.id;
        setCreatedLegs((prev) => ({ ...prev, saleOrderId }));
      }
      // 2. The return authorization (pickup keeps it open until settle).
      if (!returnId) {
        // store_credit: the exchange settlement diverts the money anyway,
        // this skips the cash-refund cap on partially-paid originals, and
        // if the exchange is later split the fallback is credit — never
        // cash out the door.
        await api(`/v1/orders/${original.id}/return`, {
          method: 'POST',
          body: JSON.stringify({
            fulfillment: 'pickup',
            refundMethod: 'store_credit',
            ...(reasonText.trim() ? { reason: reasonText.trim() } : {}),
            lines: pickedReturns.map((p) => ({
              lineId: p.line.id,
              quantity: p.quantity,
            })),
          }),
        });
        const returns = await api<{ data: { id: string }[] }>(
          `/v1/order-returns?orderId=${original.id}&status=authorized`,
        );
        if (!returns.data[0]) throw new Error('Return authorization not found');
        returnId = returns.data[0].id;
        setCreatedLegs((prev) => ({ ...prev, returnId }));
      }
      // 3. Bind the container.
      const fee = feeOverride.trim();
      const exchange = await api<{ id: string; status: string }>('/v1/exchanges', {
        method: 'POST',
        body: JSON.stringify({
          saleOrderId,
          returnId,
          evenExchange,
          fulfillment: goodsInHand ? 'drop_off' : 'pickup',
          refundTender,
          ...(returnSalespersonId ? { returnSalespersonMembershipId: returnSalespersonId } : {}),
          ...(fee !== '' ? { restockingFeeCents: Math.round(Number(fee) * 100) } : {}),
        }),
      });
      // 4. Goods in hand → settle now. A held (E1) exchange settles
      // after approval instead, and a receive hiccup must not strand
      // the cashier — the exchange exists; its page has the buttons.
      if (goodsInHand && exchange.status !== 'on_hold') {
        try {
          await api(`/v1/order-returns/${returnId}/receive`, {
            method: 'POST',
            body: JSON.stringify(
              returnToId && returnToId !== original.locationId ? { locationId: returnToId } : {},
            ),
          });
          // 5. Customer owes the difference → take it now, for the exact
          // balance the server computed (credit and tax included). A
          // payment hiccup must not strand the exchange — the
          // replacement order's page collects too.
          if (collectNow) {
            const settled = await api<{
              settlement: { saleBalanceDueCents: number };
            }>(`/v1/exchanges/${exchange.id}`);
            const due = settled.settlement.saleBalanceDueCents;
            if (due > 0) {
              await api(`/v1/orders/${saleOrderId}/payments`, {
                method: 'POST',
                body: JSON.stringify({ method: payMethod, amountCents: due, kind: 'balance' }),
              });
            }
          }
        } catch {
          // Settle (and collect) from the exchange page once whatever
          // blocked it clears.
        }
      }
      router.push(`/exchanges/${exchange.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        saleOrderId || returnId
          ? `${msg} — the replacement order and return are saved; fix the issue and press Write exchange again to bind them (no duplicates will be created).`
          : msg,
      );
      setSaving(false);
    }
  }

  const returnableLines = original ? original.lines.filter((l) => returnable(l) > 0) : [];

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/exchanges">All exchanges</BackLink>}
        title="New exchange"
        sub="The return credits the replacement in one settlement — the customer pays (or keeps as store credit) only the difference."
      />

      {!original && (
        <Card
          title="Original order"
          description="Pre-cutover sale with no order on file? Write the no-original return on the Returns page first, then bind it to a new order from the exchange detail — or ask a manager."
        >
          <Toolbar>
            <Input
              value={orderNumberQuery}
              onChange={(e) => setOrderNumberQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void findByNumber();
                }
              }}
              placeholder="Order number (SO-…)"
              aria-label="Order number"
              data-testid="exchange-original-query"
            />
            <Button type="button" variant="primary" size="sm" onClick={() => void findByNumber()}>
              <Search size={14} />
              Find
            </Button>
          </Toolbar>
          {error && <Alert tone="error">{error}</Alert>}
        </Card>
      )}

      {original && (
        <Stack>
          <Card title={`Return — from ${original.number}`}>
            <Stack>
              {returnableLines.length === 0 ? (
                <EmptyState title="Nothing returnable">
                  Nothing on this order is returnable (only delivered units can come back).
                </EmptyState>
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Delivered</th>
                        <th className="num">Return qty</th>
                        <th className="num">Unit credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnableLines.map((l) => (
                        <tr key={l.id}>
                          <td>{l.description}</td>
                          <td className="num">{returnable(l)}</td>
                          <td className="num">
                            <Input
                              type="number"
                              min={0}
                              max={returnable(l)}
                              value={returnQty[l.id] ?? 0}
                              onChange={(e) =>
                                setReturnQty((prev) => ({
                                  ...prev,
                                  [l.id]: Math.max(
                                    0,
                                    Math.min(returnable(l), Number(e.target.value)),
                                  ),
                                }))
                              }
                              className="w-[70px]"
                              aria-label={`Return quantity for ${l.description}`}
                            />
                          </td>
                          <td className="num">
                            <Money cents={perUnitCredit(l)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
              <FormGrid cols={2}>
                <Field label="Return reason">
                  <Input
                    value={reasonText}
                    onChange={(e) => setReasonText(e.target.value)}
                    placeholder="Why is it coming back?"
                    data-testid="return-reason-text"
                  />
                </Field>
                <Field label="Return goods to">
                  <Select
                    value={returnToId}
                    onChange={(e) => setReturnToId(e.target.value)}
                    data-testid="return-to-location"
                  >
                    <option value="">{locationName(original.locationId)} — this store</option>
                    {locations
                      .filter((l) => l.id !== original.locationId)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                          {l.locationType === 'warehouse' ? ' (warehouse)' : ''}
                        </option>
                      ))}
                  </Select>
                </Field>
              </FormGrid>
            </Stack>
          </Card>

          <Card title="Replacement">
            <Toolbar>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pickedReturns.length === 0}
                onClick={copyReturnsToSale}
                title="Even exchange: replace like for like"
              >
                <Repeat size={14} />
                Same items (even exchange)
              </Button>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={evenExchange}
                  onChange={(e) => setEvenExchange(e.target.checked)}
                />
                Mark as even exchange (required when the original was financed)
              </label>
            </Toolbar>
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
                placeholder="Search replacement by name, SKU, or barcode"
                aria-label="Search replacement by name, SKU, or barcode"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void searchVariants()}
              >
                <Search size={14} />
                Search
              </Button>
            </Toolbar>
            {results.length === 200 && (
              <Alert tone="info">
                Many items match — refine your search to find the right one.
              </Alert>
            )}
            <Stack>
              {results.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {results.map((r) => (
                    <Button
                      key={r.variantId}
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={saleLines.some((l) => l.variantId === r.variantId)}
                      onClick={() => {
                        setSaleLines((prev) =>
                          prev.some((l) => l.variantId === r.variantId)
                            ? prev
                            : [
                                ...prev,
                                {
                                  variantId: r.variantId,
                                  description: [r.productName, r.variantName]
                                    .filter(Boolean)
                                    .join(' — '),
                                  quantity: 1,
                                  priceCents: r.priceCents,
                                  sourceLocationId: '',
                                },
                              ],
                        );
                        setSearch('');
                        setResults([]);
                      }}
                    >
                      + {r.productName}
                      {r.variantName ? ` — ${r.variantName}` : ''}
                      {r.sku ? ` (${r.sku})` : ''}
                    </Button>
                  ))}
                </div>
              )}
              {saleLines.length > 0 && (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="num">Qty</th>
                        <th className="num">Unit price</th>
                        <th>Inventory from</th>
                        <th className="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {saleLines.map((l, i) => (
                        <tr key={l.variantId}>
                          <td>{l.description}</td>
                          <td className="num">
                            <Input
                              type="number"
                              min={1}
                              value={l.quantity}
                              onChange={(e) =>
                                setSaleLines((prev) =>
                                  prev.map((x, j) =>
                                    j === i
                                      ? { ...x, quantity: Math.max(1, Number(e.target.value)) }
                                      : x,
                                  ),
                                )
                              }
                              className="w-[70px]"
                              aria-label={`Quantity for ${l.description}`}
                            />
                          </td>
                          <td className="num">
                            {/* Editable — this is what the replacement bills at,
                                so a wrong or $0 list price is fixed right here. */}
                            <Input
                              type="number"
                              step="0.01"
                              min={0}
                              key={`${l.variantId}-price`}
                              defaultValue={(l.priceCents / 100).toFixed(2)}
                              onBlur={(e) => {
                                const n = Number(String(e.target.value).replace(/[$,\s]/g, ''));
                                const cents = Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
                                setSaleLines((prev) =>
                                  prev.map((x, j) => (j === i ? { ...x, priceCents: cents } : x)),
                                );
                              }}
                              className="w-[90px]"
                              data-testid="exchange-line-price"
                              aria-label={`Unit price for ${l.description}`}
                            />
                          </td>
                          <td>
                            <Select
                              value={l.sourceLocationId}
                              onChange={(e) =>
                                setSaleLines((prev) =>
                                  prev.map((x, j) =>
                                    j === i ? { ...x, sourceLocationId: e.target.value } : x,
                                  ),
                                )
                              }
                              data-testid="exchange-line-source"
                              aria-label={`Inventory source for ${l.description}`}
                            >
                              <option value="">
                                {original ? locationName(original.locationId) : 'This store'} — this
                                store
                              </option>
                              {locations
                                .filter((loc) => loc.id !== original?.locationId)
                                .map((loc) => (
                                  <option key={loc.id} value={loc.id}>
                                    {loc.name}
                                    {loc.locationType === 'warehouse' ? ' (warehouse)' : ''}
                                  </option>
                                ))}
                            </Select>
                          </td>
                          <td className="actions">
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              onClick={() => setSaleLines((prev) => prev.filter((_, j) => j !== i))}
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
          </Card>

          <Card
            title="Settlement"
            description="Estimates exclude tax and any configured restocking percent — the exact numbers come from the written orders, and the collected payment uses the exact balance."
          >
            <Stack>
              <KeyValue
                rows={[
                  {
                    label: 'Replacement (before tax)',
                    value: <Money cents={replacementEstCents} />,
                  },
                  {
                    label: 'Return credit',
                    value: (
                      <>
                        <Money cents={returnCreditCents} />
                        {feeEstCents > 0 && (
                          <>
                            {' '}
                            − restocking fee <Money cents={feeEstCents} />
                          </>
                        )}
                      </>
                    ),
                  },
                  {
                    label:
                      estNetCents > 0
                        ? 'Estimated balance the customer owes'
                        : 'Estimated store credit the customer keeps',
                    value: (
                      <strong data-testid="exchange-est-due">
                        <Money cents={estNetCents > 0 ? estNetCents : -estNetCents} />
                      </strong>
                    ),
                  },
                ]}
              />
              <FormGrid cols={2}>
                <Field label="Return salesperson" hint="Who is credited with the return leg">
                  <Select
                    value={returnSalespersonId}
                    onChange={(e) => setReturnSalespersonId(e.target.value)}
                    data-testid="exchange-return-salesperson"
                  >
                    <option value="">—</option>
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name ?? m.membershipId}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Refund tender"
                  hint={
                    estNetCents < 0
                      ? 'The return is worth more than the replacement — how the difference goes back'
                      : 'Only used when the return exceeds the replacement'
                  }
                >
                  <Select
                    value={refundTender}
                    onChange={(e) => setRefundTender(e.target.value as typeof refundTender)}
                    data-testid="exchange-refund-tender"
                  >
                    <option value="store_credit">Store credit (stays on account)</option>
                    <option value="original">Original tenders</option>
                    <option value="cash">Cash</option>
                    <option value="check">Check</option>
                  </Select>
                </Field>
                <Field label="Restocking fee override ($)" hint="Blank = calculated from settings">
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={feeOverride}
                    onChange={(e) => setFeeOverride(e.target.value)}
                  />
                </Field>
                <div className="field">
                  <span className="field-label">When to settle</span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={goodsInHand}
                      onChange={(e) => setGoodsInHand(e.target.checked)}
                    />
                    Goods are in hand — settle immediately (uncheck for a truck pickup; the exchange
                    records the fulfillment either way)
                  </label>
                </div>
                {goodsInHand && (
                  <div className="field">
                    <span className="field-label">Balance</span>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={collectNow}
                        onChange={(e) => setCollectNow(e.target.checked)}
                        data-testid="collect-balance-now"
                      />
                      Collect the remaining balance now (charged for the exact amount due after the
                      credit applies)
                    </label>
                  </div>
                )}
                {goodsInHand && collectNow && (
                  <Field label="Payment method">
                    <Select
                      value={payMethod}
                      onChange={(e) =>
                        setPayMethod(e.target.value as (typeof TENDERS)[number]['value'])
                      }
                      data-testid="exchange-pay-method"
                    >
                      {TENDERS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </FormGrid>
              {error && <Alert tone="error">{error}</Alert>}
            </Stack>
            <FormActions>
              <Button
                type="button"
                variant="primary"
                disabled={saving}
                onClick={() => void submit()}
                data-testid="create-exchange"
              >
                <Repeat size={14} />
                {saving ? 'Writing…' : 'Write exchange'}
              </Button>
            </FormActions>
          </Card>
        </Stack>
      )}
    </div>
  );
}

export default function NewExchangePage() {
  return (
    <Suspense fallback={<LoadingRows rows={4} />}>
      <NewExchangeInner />
    </Suspense>
  );
}
