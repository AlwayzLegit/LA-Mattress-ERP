'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { lookupZip } from '@/lib/zip-lookup';
import { Alert, Button, Field, FormGrid, Input } from '@/components/ui';
import { ActionDialog, errorText } from './dialog';
import type { ActionOrder } from './types';

interface CustomerAddress {
  label?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}

export interface EditableCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  phone2?: string | null;
  workPhone?: string | null;
  workPhoneExt?: string | null;
  addressesJson?: CustomerAddress[] | null;
}

/**
 * STORIS Step 1 Billing Information + "Enter Customer Name" + "Update a
 * Customer Address": the customer record (name, email, home / cell / work
 * phone + ext, billing address) and the order's own ship-to snapshot.
 */
export function CustomerDialog({
  order,
  customer,
  orderEditable,
  onClose,
  onSaved,
}: {
  order: ActionOrder;
  customer: EditableCustomer;
  orderEditable: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const billing = customer.addressesJson?.[0] ?? {};
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zipFill, setZipFill] = useState<{ city: string; region: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const s = (k: string) => String(d.get(k) ?? '').trim() || null;
    const addr: CustomerAddress = {
      label: billing.label ?? 'Billing',
      line1: s('bLine1'),
      line2: s('bLine2'),
      city: s('bCity'),
      region: s('bRegion'),
      postalCode: s('bPostal'),
    };
    const rest = (customer.addressesJson ?? []).slice(1);
    const hasBilling = addr.line1 || addr.city || addr.postalCode;
    setSaving(true);
    setError(null);
    try {
      await api(`/v1/customers/${customer.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: s('firstName'),
          lastName: s('lastName'),
          email: s('email'),
          phone: s('phone'),
          phone2: s('phone2'),
          workPhone: s('workPhone'),
          workPhoneExt: s('workPhoneExt'),
          addressesJson: hasBilling ? [addr, ...rest] : rest,
        }),
      });
      if (orderEditable && d.get('editShip') === 'on') {
        await api(`/v1/orders/${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            address: {
              line1: s('sLine1'),
              line2: s('sLine2'),
              city: s('sCity'),
              region: s('sRegion'),
              postalCode: s('sPostal'),
              phone: s('sPhone'),
            },
          }),
        });
      }
      await onSaved();
      toast.success('Customer updated');
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDialog title="Customer information" onClose={onClose} wide testId="customer-dialog">
      <form onSubmit={submit}>
        <strong>Billing information</strong>
        <FormGrid cols={3}>
          <Field label="First name">
            <Input
              name="firstName"
              defaultValue={customer.firstName ?? ''}
              data-testid="cust-first"
            />
          </Field>
          <Field label="Last name">
            <Input name="lastName" defaultValue={customer.lastName ?? ''} data-testid="cust-last" />
          </Field>
          <Field label="Primary email">
            <Input name="email" type="email" defaultValue={customer.email ?? ''} />
          </Field>
          <Field label="Home phone">
            <Input name="phone" defaultValue={customer.phone ?? ''} />
          </Field>
          <Field label="Cell phone">
            <Input name="phone2" defaultValue={customer.phone2 ?? ''} />
          </Field>
          <Field label="Work phone · extension">
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
              <Input
                name="workPhone"
                defaultValue={customer.workPhone ?? ''}
                data-testid="cust-work-phone"
              />
              <Input
                name="workPhoneExt"
                defaultValue={customer.workPhoneExt ?? ''}
                placeholder="Ext"
              />
            </div>
          </Field>
          <Field label="Address 1">
            <Input name="bLine1" defaultValue={billing.line1 ?? ''} data-testid="cust-address1" />
          </Field>
          <Field label="Address 2">
            <Input name="bLine2" defaultValue={billing.line2 ?? ''} />
          </Field>
          <Field label="ZIP">
            <Input
              name="bPostal"
              defaultValue={billing.postalCode ?? ''}
              onChange={(e) => {
                void lookupZip(e.target.value).then((hit) => {
                  if (hit) setZipFill({ city: hit.city, region: hit.state });
                });
              }}
            />
          </Field>
          <Field label="City">
            <Input
              name="bCity"
              key={zipFill?.city ?? billing.city ?? 'c'}
              defaultValue={zipFill?.city ?? billing.city ?? ''}
            />
          </Field>
          <Field label="State">
            <Input
              name="bRegion"
              key={zipFill?.region ?? billing.region ?? 'r'}
              defaultValue={zipFill?.region ?? billing.region ?? ''}
            />
          </Field>
        </FormGrid>
        {orderEditable && (
          <>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
              <input type="checkbox" name="editShip" data-testid="cust-edit-ship" />
              <strong>Also update this order&apos;s ship-to address</strong>
            </label>
            <FormGrid cols={3}>
              <Field label="Ship to — address 1">
                <Input
                  name="sLine1"
                  defaultValue={order.addressLine1 ?? ''}
                  data-testid="ship-address1"
                />
              </Field>
              <Field label="Address 2">
                <Input name="sLine2" defaultValue={order.addressLine2 ?? ''} />
              </Field>
              <Field label="Phone at address">
                <Input name="sPhone" defaultValue={order.addressPhone ?? ''} />
              </Field>
              <Field label="City">
                <Input name="sCity" defaultValue={order.addressCity ?? ''} />
              </Field>
              <Field label="State">
                <Input name="sRegion" defaultValue={order.addressRegion ?? ''} />
              </Field>
              <Field label="ZIP">
                <Input name="sPostal" defaultValue={order.addressPostalCode ?? ''} />
              </Field>
            </FormGrid>
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="dialog-foot" style={{ margin: '12px -18px -14px', borderRadius: 0 }}>
          <Button type="submit" variant="primary" disabled={saving} data-testid="cust-save">
            {saving ? 'Saving…' : 'Save customer'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </ActionDialog>
  );
}
