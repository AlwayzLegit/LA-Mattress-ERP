'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
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

  function setVariant(i: number, patch: Partial<VariantInput>) {
    setVariants((prev) => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = new FormData(e.currentTarget);
      const body = {
        name: String(data.get('name') ?? ''),
        sku: String(data.get('sku') ?? '') || null,
        description: String(data.get('description') ?? '') || null,
        variants: variants
          .filter((v) => Number(v.priceDollars) > 0)
          .map((v) => ({
            sku: v.sku || null,
            name: v.name || null,
            priceCents: Math.round(Number(v.priceDollars) * 100),
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
              <Field label="Description" className="form-span">
                <textarea className="textarea" name="description" rows={3} />
              </Field>
            </FormGrid>
          </Card>

          <Card
            title="Variants"
            description="Only variants with a price above $0 are created; leave the rest blank."
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
