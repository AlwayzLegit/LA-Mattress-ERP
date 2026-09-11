'use client';

import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
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
} from '@/components/ui';
import { api } from '@/lib/api';

export default function NewCustomerPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = new FormData(e.currentTarget);
      const body = {
        firstName: blankToNull(data.get('firstName')),
        lastName: blankToNull(data.get('lastName')),
        email: blankToNull(data.get('email')),
        phone: blankToNull(data.get('phone')),
        notes: blankToNull(data.get('notes')),
        businessName: blankToNull(data.get('businessName')),
        contactName: blankToNull(data.get('contactName')),
        alternateName: blankToNull(data.get('alternateName')),
        alternateRelationship: blankToNull(data.get('alternateRelationship')),
        deliveryInstructions: blankToNull(data.get('deliveryInstructions')),
      };
      const created = await api<{ id: string }>('/v1/customers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      router.push(`/customers/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/customers">All customers</BackLink>}
        title="New customer"
      />
      <Card
        title="Details"
        description="At least one of name, email, or phone is required."
        className="form-narrow"
      >
        <form onSubmit={submit}>
          <FormGrid cols={2}>
            <Field label="First name">
              <Input name="firstName" autoComplete="off" />
            </Field>
            <Field label="Last name">
              <Input name="lastName" autoComplete="off" />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" autoComplete="off" />
            </Field>
            <Field label="Phone">
              <Input name="phone" type="tel" autoComplete="off" />
            </Field>
            <Field label="Business name" hint="Trade accounts">
              <Input name="businessName" autoComplete="off" />
            </Field>
            <Field label="Contact name">
              <Input name="contactName" autoComplete="off" />
            </Field>
            <Field label="Alternate contact">
              <Input name="alternateName" autoComplete="off" />
            </Field>
            <Field label="Relationship">
              <Input name="alternateRelationship" autoComplete="off" />
            </Field>
            <Field label="Delivery instructions" className="form-span">
              <textarea name="deliveryInstructions" rows={2} className="textarea" />
            </Field>
            <Field label="Notes" className="form-span">
              <textarea name="notes" rows={3} className="textarea" />
            </Field>
            {error && (
              <Alert tone="error" className="form-span">
                {error}
              </Alert>
            )}
          </FormGrid>
          <FormActions>
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              <UserPlus size={14} aria-hidden />
              {saving ? 'Saving…' : 'Create customer'}
            </Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}

function blankToNull(v: FormDataEntryValue | null): string | null {
  const s = v == null ? '' : String(v).trim();
  return s.length > 0 ? s : null;
}
