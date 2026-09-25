'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  centsToInputString,
  FIRMNESS_LEVELS,
  MATTRESS_SIZES,
  PRODUCT_PURCHASE_STATUS_LABELS,
  PRODUCT_PURCHASE_STATUSES,
} from '@jetnine/shared';
import { api } from '@/lib/api';
import { useOptionalActingStore } from '@/lib/acting-store';
import { categoryList, categoryOptions, type CategoryFlat } from '@/lib/categories';
import { Money } from '@/components/money';
import {
  Button,
  Card,
  cx,
  Field,
  FormGrid,
  Input,
  Select,
  StatusBadge,
  TableEmpty,
  TableWrap,
} from '@/components/ui';
import { useSection } from './activity/kit';
import type { General, Shipping } from './activity/types';

/**
 * Edit product (owner 2026-09-25: "make the product edit screen more user
 * friendly, also need to be able to change the item cost").
 *
 * Before, the tab was eight cards that each saved a field the moment you
 * left it, with no sign anything happened, several values shown twice, and
 * cost read-only. Now it is one form: change anything, then Save changes
 * (or Discard). The bar at the bottom says when there is something unsaved,
 * and leaving the page or the tab asks first.
 */

export interface EditableVariant {
  id: string;
  sku: string | null;
  name: string | null;
  barcode: string | null;
  priceCents: number;
  costCents: number | null;
  size: string | null;
  firmness: string | null;
  isActive: boolean;
  reorderPoint: number | null;
  reorderQty: number | null;
  preferredVendorId: string | null;
  vendorSku: string | null;
}

export interface EditableProduct {
  id: string;
  name: string;
  secondDescription: string | null;
  categoryId: string | null;
  brandId: string | null;
  collectionId: string | null;
  taxClassId: string | null;
  purchaseStatus: string;
  suggestedRetailCents: number | null;
  boxesPerProduct: number;
  logisticalCartonQty: number;
  purchaseCartonQty: number;
  logisticalCartonTransfers: boolean;
  shipping: Shipping;
  group: string | null;
  vendorModel: string | null;
  variants: EditableVariant[];
}

export interface RefEntity {
  id: string;
  name: string;
  isActive: boolean;
}

interface TaxClass {
  id: string;
  name: string;
  rateBps: number;
}

interface Vendor {
  id: string;
  name: string;
}

interface VariantDraft {
  price: string;
  cost: string;
  size: string;
  firmness: string;
  barcode: string;
  reorderPoint: string;
  reorderQty: string;
  vendorId: string;
  vendorSku: string;
}

interface Draft {
  name: string;
  secondDescription: string;
  categoryId: string;
  brandId: string;
  collectionId: string;
  taxClassId: string;
  purchaseStatus: string;
  suggestedRetail: string;
  boxesPerProduct: string;
  logisticalCartonQty: string;
  purchaseCartonQty: string;
  logisticalCartonTransfers: boolean;
  shipping: Record<keyof Shipping, string>;
  variants: Record<string, VariantDraft>;
}

const SHIPPING_FIELDS: { key: keyof Shipping; label: string }[] = [
  { key: 'weightLb', label: 'Shipping weight (lb)' },
  { key: 'heightIn', label: 'Height (in)' },
  { key: 'widthIn', label: 'Width (in)' },
  { key: 'depthIn', label: 'Depth (in)' },
  { key: 'shippingVolume', label: 'Shipping volume' },
  { key: 'deliveryVolume', label: 'Delivery volume' },
];

const money = (cents: number | null) => (cents == null ? '' : centsToInputString(cents));
const num = (n: number | null) => (n == null ? '' : String(n));

function toDraft(p: EditableProduct): Draft {
  return {
    name: p.name,
    secondDescription: p.secondDescription ?? '',
    categoryId: p.categoryId ?? '',
    brandId: p.brandId ?? '',
    collectionId: p.collectionId ?? '',
    taxClassId: p.taxClassId ?? '',
    purchaseStatus: String(p.purchaseStatus),
    suggestedRetail: money(p.suggestedRetailCents),
    boxesPerProduct: String(p.boxesPerProduct),
    logisticalCartonQty: String(p.logisticalCartonQty),
    purchaseCartonQty: String(p.purchaseCartonQty),
    logisticalCartonTransfers: p.logisticalCartonTransfers,
    shipping: Object.fromEntries(
      SHIPPING_FIELDS.map(({ key }) => [key, num(p.shipping[key])]),
    ) as Record<keyof Shipping, string>,
    variants: Object.fromEntries(
      p.variants.map((v) => [
        v.id,
        {
          price: money(v.priceCents),
          cost: money(v.costCents),
          size: v.size ?? '',
          firmness: v.firmness ?? '',
          barcode: v.barcode ?? '',
          reorderPoint: num(v.reorderPoint),
          reorderQty: num(v.reorderQty),
          vendorId: v.preferredVendorId ?? '',
          vendorSku: v.vendorSku ?? '',
        },
      ]),
    ),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Dollars typed by a person → cents; `undefined` when it is not a valid amount. */
export function parseMoney(raw: string): number | null | undefined {
  const t = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function parseWhole(raw: string, min: number): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min) return undefined;
  return n;
}

function parseMeasure(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Gross margin as a whole percent of price, or null when it cannot be worked out. */
export function marginPercent(
  priceCents: number | null | undefined,
  costCents: number | null | undefined,
) {
  if (priceCents == null || costCents == null || priceCents <= 0) return null;
  return Math.round(((priceCents - costCents) / priceCents) * 100);
}

export function EditProductForm({
  product,
  taxClasses,
  brands,
  collections,
  onRefCreated,
  onSaved,
  onToggleVariant,
  onDirtyChange,
}: {
  product: EditableProduct;
  taxClasses: TaxClass[];
  brands: RefEntity[];
  collections: RefEntity[];
  onRefCreated: (kind: 'brand' | 'collection', ref: RefEntity) => void;
  onSaved: () => Promise<void>;
  onToggleVariant: (variantId: string, active: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  // Cost is editable for anyone who can see it; without
  // products.cost.view the column says "hidden" and is never sent.
  const canSeeCost = useOptionalActingStore()?.me?.canSeeCost;
  const costEditable = canSeeCost !== false;

  const baseline = useMemo(() => toDraft(product), [product]);
  const [draft, setDraft] = useState<Draft>(baseline);
  const prevBaseline = useRef(baseline);
  const resetOnReload = useRef(false);
  // A reload after someone else's change (a variant switched on, the header
  // Deactivate) keeps what is being typed; a reload after our own save
  // starts clean from what the server now holds.
  useEffect(() => {
    setDraft((cur) => (resetOnReload.current || same(cur, prevBaseline.current) ? baseline : cur));
    resetOnReload.current = false;
    prevBaseline.current = baseline;
  }, [baseline]);

  const dirty = !same(draft, baseline);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const [categories, setCategories] = useState<CategoryFlat[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  useEffect(() => {
    void api<CategoryFlat[] | { flat: CategoryFlat[] }>('/v1/categories')
      .then((r) => setCategories(categoryList(r)))
      .catch(() => setCategories([]));
    void api<Vendor[]>('/v1/vendors')
      .then(setVendors)
      .catch(() => setVendors([]));
  }, []);
  const catOptions = useMemo(() => categoryOptions(categories), [categories]);

  const { data: general } = useSection<General>(`/v1/products/${product.id}/activity/general`);
  const facts = general?.cost;

  const [saving, setSaving] = useState(false);
  const [newBrand, setNewBrand] = useState('');
  const [newCollection, setNewCollection] = useState('');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setVariant = (id: string, patch: Partial<VariantDraft>) =>
    setDraft((d) => ({
      ...d,
      variants: { ...d.variants, [id]: { ...d.variants[id]!, ...patch } },
    }));
  const setShipping = (key: keyof Shipping, value: string) =>
    setDraft((d) => ({ ...d, shipping: { ...d.shipping, [key]: value } }));

  // ---- Validation (shown inline; Save stays off until it is clean) ----
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = 'A product needs a description';
  if (parseMoney(draft.suggestedRetail) === undefined) errors.suggestedRetail = 'Enter an amount';
  for (const key of ['boxesPerProduct', 'logisticalCartonQty', 'purchaseCartonQty'] as const) {
    const n = parseWhole(draft[key], 1);
    if (n == null) errors[key] = 'A whole number, 1 or more';
  }
  for (const { key } of SHIPPING_FIELDS) {
    if (parseMeasure(draft.shipping[key]) === undefined) errors[`ship.${key}`] = 'Enter a number';
  }
  for (const v of product.variants) {
    const d = draft.variants[v.id];
    if (!d) continue;
    const price = parseMoney(d.price);
    if (price == null)
      errors[`${v.id}.price`] = price === null ? 'Needs a price' : 'Enter an amount';
    if (costEditable && parseMoney(d.cost) === undefined)
      errors[`${v.id}.cost`] = 'Enter an amount';
    if (parseWhole(d.reorderPoint, 0) === undefined) errors[`${v.id}.point`] = 'Whole number';
    if (parseWhole(d.reorderQty, 1) === undefined) errors[`${v.id}.qty`] = '1 or more';
  }
  const errorCount = Object.keys(errors).length;

  async function createRef(kind: 'brand' | 'collection') {
    const name = (kind === 'brand' ? newBrand : newCollection).trim();
    if (!name) return;
    try {
      const created = await api<{ id: string; name: string }>(
        kind === 'brand' ? '/v1/brands' : '/v1/collections',
        { method: 'POST', body: JSON.stringify({ name }) },
      );
      onRefCreated(kind, { id: created.id, name: created.name ?? name, isActive: true });
      if (kind === 'brand') {
        set('brandId', created.id);
        setNewBrand('');
      } else {
        set('collectionId', created.id);
        setNewCollection('');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    if (errorCount > 0 || !dirty) return;
    setSaving(true);
    let savedSomething = false;
    try {
      // 1. The product itself — one PATCH with only what changed.
      const patch: Record<string, unknown> = {};
      const b = baseline;
      if (draft.name.trim() !== b.name.trim()) patch.name = draft.name.trim();
      if (draft.secondDescription.trim() !== b.secondDescription.trim())
        patch.secondDescription = draft.secondDescription.trim() || null;
      for (const key of ['categoryId', 'brandId', 'collectionId', 'taxClassId'] as const) {
        if (draft[key] !== b[key]) patch[key] = draft[key] || null;
      }
      if (draft.purchaseStatus !== b.purchaseStatus) patch.purchaseStatus = draft.purchaseStatus;
      if (draft.suggestedRetail !== b.suggestedRetail)
        patch.suggestedRetailCents = parseMoney(draft.suggestedRetail);
      for (const key of ['boxesPerProduct', 'logisticalCartonQty', 'purchaseCartonQty'] as const) {
        if (draft[key] !== b[key]) patch[key] = parseWhole(draft[key], 1);
      }
      if (draft.logisticalCartonTransfers !== b.logisticalCartonTransfers)
        patch.logisticalCartonTransfers = draft.logisticalCartonTransfers;
      const shipping: Record<string, number | null> = {};
      for (const { key } of SHIPPING_FIELDS) {
        if (draft.shipping[key] !== b.shipping[key])
          shipping[key] = parseMeasure(draft.shipping[key]) ?? null;
      }
      if (Object.keys(shipping).length > 0) patch.shipping = shipping;
      if (Object.keys(patch).length > 0) {
        await api(`/v1/products/${product.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        savedSomething = true;
      }

      // 2. Each size: price, cost, size, firmness, barcode.
      for (const v of product.variants) {
        const d = draft.variants[v.id];
        const was = b.variants[v.id];
        if (!d || !was) continue;
        const vp: Record<string, unknown> = {};
        if (d.price !== was.price) vp.priceCents = parseMoney(d.price);
        if (costEditable && d.cost !== was.cost) vp.costCents = parseMoney(d.cost);
        if (d.size !== was.size) vp.size = d.size || null;
        if (d.firmness !== was.firmness) vp.firmness = d.firmness || null;
        if (d.barcode.trim() !== was.barcode.trim()) vp.barcode = d.barcode.trim() || null;
        if (Object.keys(vp).length > 0) {
          await api(`/v1/products/variants/${v.id}`, {
            method: 'PATCH',
            body: JSON.stringify(vp),
          });
          savedSomething = true;
        }
      }

      // 3. Reorder and vendor settings, per size.
      for (const v of product.variants) {
        const d = draft.variants[v.id];
        const was = b.variants[v.id];
        if (!d || !was) continue;
        if (
          d.reorderPoint === was.reorderPoint &&
          d.reorderQty === was.reorderQty &&
          d.vendorId === was.vendorId &&
          d.vendorSku.trim() === was.vendorSku.trim()
        )
          continue;
        const sentVendorSku = d.vendorSku.trim() === '' ? null : d.vendorSku.trim();
        const res = await api<{ vendorSku?: string | null }>(
          `/v1/products/variants/${v.id}/reorder`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              reorderPoint: parseWhole(d.reorderPoint, 0),
              reorderQty: parseWhole(d.reorderQty, 1),
              preferredVendorId: d.vendorId || null,
              vendorSku: sentVendorSku,
            }),
          },
        );
        savedSomething = true;
        // A backend that predates the field answers 200 and drops it; do
        // not tell a buyer the vendor's part number reached the PO.
        if (sentVendorSku !== null && (res.vendorSku ?? null) !== sentVendorSku) {
          throw new Error(
            'The server did not store the vendor SKU — the API may need an update. Everything else was saved.',
          );
        }
      }

      resetOnReload.current = true;
      await onSaved();
      toast.success('Changes saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      // Show what did land; the unsaved rest stays in the form.
      if (savedSomething) await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const activeVariants = product.variants.filter((v) => v.isActive);
  const factsLine = facts && (
    <div className="pe-cost-facts" data-testid="edit-cost-facts">
      <span>
        Average cost on hand:{' '}
        {facts.averageCents != null ? (
          <>
            <strong>
              <Money cents={facts.averageCents} />
            </strong>{' '}
            ({facts.layerUnits} units)
          </>
        ) : (
          <strong>none in stock</strong>
        )}
      </span>
      {facts.averageLandedCents != null && (
        <span>
          Average landed:{' '}
          <strong>
            <Money cents={facts.averageLandedCents} />
          </strong>
        </span>
      )}
      {facts.freightPerUnitCents != null && (
        <span>
          Freight per unit:{' '}
          <strong>
            <Money cents={facts.freightPerUnitCents} />
          </strong>
        </span>
      )}
      {facts.freightPercent != null && (
        <span>
          Freight: <strong>{facts.freightPercent}%</strong>
        </span>
      )}
    </div>
  );

  return (
    <form
      className="pe-form stack"
      data-testid="edit-product-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Card
        title="Product details"
        description="What the product is called and how it is filed."
        data-testid="edit-details"
      >
        <FormGrid cols={2}>
          <Field label="Description" required error={errors.name}>
            <Input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              data-testid="product-name"
            />
          </Field>
          <Field label="Second description">
            <Input
              value={draft.secondDescription}
              onChange={(e) => set('secondDescription', e.target.value)}
              data-testid="second-description"
            />
          </Field>
          <Field label="Category">
            <Select
              value={draft.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
              data-testid="edit-category"
            >
              <option value="">(no category)</option>
              {catOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Purchase status" hint="Whether buyers can still order it from the vendor.">
            <Select
              value={draft.purchaseStatus}
              onChange={(e) => set('purchaseStatus', e.target.value)}
              data-testid="purchase-status"
            >
              {PRODUCT_PURCHASE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {PRODUCT_PURCHASE_STATUS_LABELS[st]}
                </option>
              ))}
            </Select>
          </Field>
          <Field as="div" label="Brand" hint="Printed in the Brand column of the invoice.">
            <Select
              value={draft.brandId}
              aria-label="Brand"
              onChange={(e) => set('brandId', e.target.value)}
              data-testid="edit-brand"
            >
              <option value="">(no brand)</option>
              {brands
                .filter((x) => x.isActive || x.id === draft.brandId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Select>
            <div className="pe-inline-add">
              <Input
                placeholder="New brand…"
                aria-label="New brand"
                value={newBrand}
                onChange={(e) => setNewBrand(e.target.value)}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!newBrand.trim()}
                onClick={() => void createRef('brand')}
              >
                Add
              </Button>
            </div>
          </Field>
          <Field as="div" label="Collection">
            <Select
              value={draft.collectionId}
              aria-label="Collection"
              onChange={(e) => set('collectionId', e.target.value)}
              data-testid="edit-collection"
            >
              <option value="">(no collection)</option>
              {collections
                .filter((x) => x.isActive || x.id === draft.collectionId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Select>
            <div className="pe-inline-add">
              <Input
                placeholder="New collection…"
                aria-label="New collection"
                value={newCollection}
                onChange={(e) => setNewCollection(e.target.value)}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!newCollection.trim()}
                onClick={() => void createRef('collection')}
              >
                Add
              </Button>
            </div>
          </Field>
          {taxClasses.length > 0 && (
            <Field label="Tax class" hint="Blank uses the store's normal rate.">
              <Select
                value={draft.taxClassId}
                onChange={(e) => set('taxClassId', e.target.value)}
                data-testid="edit-tax-class"
              >
                <option value="">(store default)</option>
                {taxClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {(c.rateBps / 100).toFixed(2)}%
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </FormGrid>
        {(product.group || product.vendorModel) && (
          <p className="pe-readonly" data-testid="edit-import-facts">
            From the catalog import:{' '}
            {[
              product.group ? `Group ${product.group}` : null,
              product.vendorModel ? `Vendor model ${product.vendorModel}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </Card>

      <Card
        title="Price & cost"
        description="Cost is what one unit costs you from the vendor. It fills in new purchase orders and is the cost behind margin and commission. Stock already received keeps the cost it came in at."
        flush
        data-testid="edit-pricing"
      >
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Size</th>
                <th>Firmness</th>
                <th>Barcode</th>
                <th className="num">Selling price</th>
                <th className="num">Cost</th>
                <th className="num">Margin</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {product.variants.length === 0 && (
                <TableEmpty colSpan={8}>This product has no sizes to price.</TableEmpty>
              )}
              {product.variants.map((v) => {
                const d = draft.variants[v.id]!;
                const label = v.name ?? v.sku ?? 'item';
                const m = marginPercent(
                  parseMoney(d.price) ?? null,
                  costEditable ? (parseMoney(d.cost) ?? null) : v.costCents,
                );
                return (
                  <tr key={v.id} data-testid="edit-variant-row">
                    <td>
                      <div>{v.name ?? '—'}</div>
                      <code className="muted">{v.sku ?? '—'}</code>
                      {!v.isActive && (
                        <>
                          {' '}
                          <StatusBadge status="inactive" />
                        </>
                      )}
                    </td>
                    <td>
                      <Select
                        value={d.size}
                        aria-label={`Size for ${label}`}
                        data-testid="variant-size"
                        onChange={(e) => setVariant(v.id, { size: e.target.value })}
                      >
                        <option value="">—</option>
                        {MATTRESS_SIZES.map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <Select
                        value={d.firmness}
                        aria-label={`Firmness for ${label}`}
                        data-testid="variant-firmness"
                        onChange={(e) => setVariant(v.id, { firmness: e.target.value })}
                      >
                        <option value="">—</option>
                        {FIRMNESS_LEVELS.map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <Input
                        value={d.barcode}
                        aria-label={`Barcode for ${label}`}
                        onChange={(e) => setVariant(v.id, { barcode: e.target.value })}
                        className="w-36"
                      />
                    </td>
                    <td className="num">
                      <MoneyInput
                        value={d.price}
                        label={`Selling price for ${label}`}
                        error={errors[`${v.id}.price`]}
                        testId="variant-price"
                        onChange={(price) => setVariant(v.id, { price })}
                      />
                    </td>
                    <td className="num">
                      {costEditable ? (
                        <MoneyInput
                          value={d.cost}
                          label={`Cost for ${label}`}
                          error={errors[`${v.id}.cost`]}
                          placeholder="none"
                          testId="variant-cost"
                          onChange={(cost) => setVariant(v.id, { cost })}
                        />
                      ) : (
                        <em className="muted">hidden</em>
                      )}
                    </td>
                    <td className="num">
                      <span
                        className={cx('pe-margin', m != null && m < 0 && 'is-low')}
                        data-testid="variant-margin"
                        title={m != null && m < 0 ? 'Selling below cost' : undefined}
                      >
                        {m != null ? `${m}%` : '—'}
                      </span>
                    </td>
                    <td className="actions">
                      {v.isActive ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          onClick={() => onToggleVariant(v.id, false)}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => onToggleVariant(v.id, true)}
                          data-testid="variant-reactivate"
                        >
                          Reactivate
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        <div style={{ padding: '12px 14px' }}>
          <FormGrid cols={3}>
            <Field
              label="Suggested retail price"
              hint="The vendor's list price, for reference."
              error={errors.suggestedRetail}
            >
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={draft.suggestedRetail}
                onChange={(e) => set('suggestedRetail', e.target.value)}
                data-testid="suggested-retail"
              />
            </Field>
          </FormGrid>
        </div>
        {costEditable && factsLine}
      </Card>

      <Card
        title="Reordering & vendor"
        description="When available stock across all locations falls to the reorder point, the item shows in Purchasing → Reorder suggestions under its vendor. Leave the point blank to turn that off. Vendor SKU is the vendor's own part number, printed on purchase orders."
        flush
        data-testid="edit-reorder"
      >
        <TableWrap>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Preferred vendor</th>
                <th>Vendor SKU</th>
                <th className="num">Reorder point</th>
                <th className="num">Order qty</th>
              </tr>
            </thead>
            <tbody>
              {activeVariants.length === 0 && (
                <TableEmpty colSpan={5}>No active sizes to reorder.</TableEmpty>
              )}
              {activeVariants.map((v) => {
                const d = draft.variants[v.id]!;
                return (
                  <tr key={v.id}>
                    <td>{v.name ?? <code>{v.sku ?? v.id.slice(0, 8)}</code>}</td>
                    <td>
                      <Select
                        value={d.vendorId}
                        aria-label="Preferred vendor"
                        onChange={(e) => setVariant(v.id, { vendorId: e.target.value })}
                      >
                        <option value="">— none —</option>
                        {vendors.map((vd) => (
                          <option key={vd.id} value={vd.id}>
                            {vd.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <Input
                        value={d.vendorSku}
                        placeholder={v.sku ? `same as ${v.sku}` : 'vendor part #'}
                        aria-label="Vendor SKU"
                        onChange={(e) => setVariant(v.id, { vendorSku: e.target.value })}
                        className="w-44"
                        data-testid={`vendor-sku-${v.sku}`}
                      />
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        min={0}
                        value={d.reorderPoint}
                        placeholder="off"
                        aria-label="Reorder point"
                        aria-invalid={errors[`${v.id}.point`] ? true : undefined}
                        onChange={(e) => setVariant(v.id, { reorderPoint: e.target.value })}
                        className="w-20"
                        data-testid={`reorder-point-${v.sku}`}
                      />
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        min={1}
                        value={d.reorderQty}
                        placeholder="auto"
                        aria-label="Order quantity"
                        aria-invalid={errors[`${v.id}.qty`] ? true : undefined}
                        onChange={(e) => setVariant(v.id, { reorderQty: e.target.value })}
                        className="w-20"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card
        title="Packing & shipping"
        description="How it is boxed and shipped. Delivery capacity keeps using the item's capacity units."
        data-testid="edit-packing"
      >
        <FormGrid cols={3}>
          <Field label="Boxes per product" error={errors.boxesPerProduct}>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.boxesPerProduct}
              onChange={(e) => set('boxesPerProduct', e.target.value)}
              data-testid="boxes-per-product"
            />
          </Field>
          <Field label="Purchase carton quantity" error={errors.purchaseCartonQty}>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.purchaseCartonQty}
              onChange={(e) => set('purchaseCartonQty', e.target.value)}
            />
          </Field>
          <Field label="Logistical carton quantity" error={errors.logisticalCartonQty}>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.logisticalCartonQty}
              onChange={(e) => set('logisticalCartonQty', e.target.value)}
            />
          </Field>
          {SHIPPING_FIELDS.map(({ key, label }) => (
            <Field
              key={key}
              label={label}
              error={errors[`ship.${key}`]}
              hint={
                key === 'deliveryVolume' && general?.capacityUnits != null
                  ? `Capacity units: ${general.capacityUnits}`
                  : undefined
              }
            >
              <Input
                type="number"
                min={0}
                step="0.01"
                value={draft.shipping[key]}
                onChange={(e) => setShipping(key, e.target.value)}
                data-testid={`shipping-${key}`}
              />
            </Field>
          ))}
          <Field label="Carton transfers" as="div">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.logisticalCartonTransfers}
                onChange={(e) => set('logisticalCartonTransfers', e.target.checked)}
              />
              Transfer in whole cartons
            </label>
          </Field>
        </FormGrid>
      </Card>

      <div
        className={cx('pe-savebar', dirty && 'is-dirty')}
        role="region"
        aria-label="Save changes"
        data-testid="edit-savebar"
      >
        <span className="pe-savebar-note" data-testid="edit-save-state">
          {saving
            ? 'Saving…'
            : errorCount > 0
              ? `Fix ${errorCount === 1 ? 'the highlighted field' : `${errorCount} highlighted fields`} to save`
              : dirty
                ? 'You have unsaved changes'
                : 'All changes saved'}
        </span>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => setDraft(baseline)}
          data-testid="edit-discard"
        >
          Discard
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || saving || errorCount > 0}
          data-testid="edit-save"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function MoneyInput({
  value,
  label,
  error,
  placeholder,
  testId,
  onChange,
}: {
  value: string;
  label: string;
  error?: string;
  placeholder?: string;
  testId?: string;
  onChange: (value: string) => void;
}) {
  return (
    <span className="pe-money" title={error}>
      <span aria-hidden>$</span>
      <Input
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="w-24"
        data-testid={testId}
      />
    </span>
  );
}
