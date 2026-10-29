'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { FIRMNESS_LEVELS, MATTRESS_SIZES } from '@jetnine/shared';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Button,
  Card,
  Field,
  FormActions,
  FormGrid,
  Input,
  PageHeader,
  Stack,
  Select,
} from '@/components/ui';

interface VariantInput {
  sku: string;
  name: string;
  priceDollars: string;
  costDollars: string;
  barcode: string;
  size: string;
  firmness: string;
}

const blankVariant: VariantInput = {
  sku: '',
  name: '',
  priceDollars: '',
  costDollars: '',
  barcode: '',
  size: '',
  firmness: '',
};

export default function NewProductPage() {
  const router = useRouter();
  const [variants, setVariants] = useState<VariantInput[]>([{ ...blankVariant }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Owner 2026-10-14: a new product can carry a product group too.
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  // Owner 2026-10-28: Vendor and Brand are picked when the product is
  // made, not found later on its page. The vendor becomes every item's
  // preferred vendor; the brand sits on the product.
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void api<{ groups: { value: string }[] }>('/v1/products/facets')
      .then((f) => setGroupOptions((f.groups ?? []).map((g) => g.value)))
      .catch(() => setGroupOptions([]));
    void api<{ vendors: { id: string; name: string }[] }>('/v1/pos/vendor-options')
      .then((r) => setVendors(r.vendors))
      .catch(() =>
        api<{ id: string; name: string }[]>('/v1/vendors')
          .then((r) => setVendors(Array.isArray(r) ? r : []))
          .catch(() => setVendors([])),
      );
    void api<{ id: string; name: string; isActive: boolean }[]>('/v1/brands')
      .then((r) => setBrands(r.filter((b) => b.isActive !== false)))
      .catch(() => setBrands([]));
  }, []);

  function setVariant(i: number, patch: Partial<VariantInput>) {
    setVariants((prev) => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = new FormData(e.currentTarget);
      const productSku = String(data.get('sku') ?? '').trim() || null;
      const body = {
        name: String(data.get('name') ?? ''),
        sku: productSku,
        description: String(data.get('description') ?? '') || null,
        group: String(data.get('group') ?? '').trim() || null,
        preferredVendorId: String(data.get('vendorId') ?? '') || null,
        brandId: String(data.get('brandId') ?? '') || null,
        // Owner 2026-09-28: a product saved with no priced row used to get
        // no item at all — unsellable, unstockable, no vendor, and nothing
        // on its page could fix it. Rows with a price, SKU or name are kept,
        // and the first row always is (at $0 until priced).
        variants: (variants.length > 0 ? variants : [{ ...blankVariant }])
          .filter((v, i) => i === 0 || Number(v.priceDollars) > 0 || v.sku.trim() || v.name.trim())
          .map((v, i) => ({
            // The first item takes the product's SKU when it has none of its own.
            sku: v.sku || (i === 0 ? productSku : null),
            name: v.name || null,
            priceCents: Math.max(0, Math.round(Number(v.priceDollars || 0) * 100)),
            costCents: v.costDollars ? Math.round(Number(v.costDollars) * 100) : null,
            barcode: v.barcode || null,
            // A22.2: blank → the API reads the size / firmness off the names.
            ...(v.size ? { size: v.size } : {}),
            ...(v.firmness ? { firmness: v.firmness } : {}),
          })),
      };
      const result = await api<{ id: string }>('/v1/products', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      router.push(`/products/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/products">All products</BackLink>}
        title="New product"
      />
      <form onSubmit={submit}>
        <Stack>
          <Card title="Basics">
            <FormGrid cols={2}>
              <Field label="Name" required>
                <Input name="name" required />
              </Field>
              <Field label="SKU (product-level, optional)">
                <Input name="sku" />
              </Field>
              <Field
                label="Product group"
                hint="QUEEN, CAKING, QUFND … Pick one in use or type a new one."
              >
                <Input
                  name="group"
                  list="new-product-groups"
                  maxLength={40}
                  placeholder="e.g. QUEEN"
                  style={{ textTransform: 'uppercase' }}
                  data-testid="new-product-group"
                />
                <datalist id="new-product-groups">
                  {groupOptions.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </Field>
              <Field label="Vendor" hint="Who we buy it from — set on every item of the product.">
                <Select name="vendorId" defaultValue="" data-testid="new-product-vendor">
                  <option value="">—</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Brand">
                <Select name="brandId" defaultValue="" data-testid="new-product-brand">
                  <option value="">—</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Description" className="form-span">
                <textarea className="textarea" name="description" rows={3} />
              </Field>
            </FormGrid>
          </Card>

          <Card
            title="Variants"
            description="The first row is always created (at $0 until you price it). Other rows are created when they have a price, SKU or name."
          >
            <Stack gap="sm">
              {variants.map((v, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(7,minmax(0,1fr))_auto]"
                >
                  <Field label="SKU">
                    <Input value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} />
                  </Field>
                  <Field label="Name">
                    <Input
                      value={v.name}
                      onChange={(e) => setVariant(i, { name: e.target.value })}
                    />
                  </Field>
                  <Field label="Price">
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={v.priceDollars}
                      onChange={(e) => setVariant(i, { priceDollars: e.target.value })}
                    />
                  </Field>
                  <Field label="Cost">
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={v.costDollars}
                      onChange={(e) => setVariant(i, { costDollars: e.target.value })}
                    />
                  </Field>
                  <Field label="Barcode">
                    <Input
                      value={v.barcode}
                      onChange={(e) => setVariant(i, { barcode: e.target.value })}
                    />
                  </Field>
                  <Field label="Size" hint="Blank: read off the name.">
                    <Select
                      value={v.size}
                      aria-label="Size"
                      onChange={(e) => setVariant(i, { size: e.target.value })}
                    >
                      <option value="">—</option>
                      {MATTRESS_SIZES.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Firmness">
                    <Select
                      value={v.firmness}
                      aria-label="Firmness"
                      onChange={(e) => setVariant(i, { firmness: e.target.value })}
                    >
                      <option value="">—</option>
                      {FIRMNESS_LEVELS.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={variants.length === 1}
                    title={variants.length === 1 ? 'A product keeps at least one item' : undefined}
                    onClick={() => setVariants((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setVariants((prev) => [...prev, { ...blankVariant }])}
                >
                  + Add variant
                </Button>
              </div>
            </Stack>
          </Card>

          {error && <Alert tone="error">{error}</Alert>}
          <FormActions>
            <Button type="submit" variant="primary" disabled={saving}>
              <Plus size={14} />
              {saving ? 'Saving…' : 'Create product'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </div>
  );
}
