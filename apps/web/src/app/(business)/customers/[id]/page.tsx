'use client';

import Link from 'next/link';
import { Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
  LinkButton,
  LoadingRows,
  PageHeader,
  SectionHeading,
  Stack,
  StatGrid,
  StatTile,
  StatusBadge,
  TableWrap,
} from '@/components/ui';
import { api } from '@/lib/api';
import { autofillFormFromZip, type ZipHit } from '@/lib/zip-lookup';
import { downloadFile } from '@/lib/download';
import { Money } from '@/components/money';

interface CustomerSummary {
  lifetime: { documents: number; totalCents: number };
  ytd: { documents: number; totalCents: number };
  openOrders: {
    id: string;
    number: string;
    status: string;
    totalCents: number;
    paidCents: number;
    balanceCents: number;
    requestedDate: string | null;
  }[];
}

interface SaleSummary {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  completedAt: string | null;
  createdAt: string;
}
interface CustomerAddress {
  label?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}
interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  phone2: string | null;
  firstName: string | null;
  lastName: string | null;
  customerNumber: string | null;
  prefix: string | null;
  middleName: string | null;
  suffix: string | null;
  businessName: string | null;
  contactName: string | null;
  alternateName: string | null;
  alternateRelationship: string | null;
  deliveryInstructions: string | null;
  notes: string | null;
  addressesJson: CustomerAddress[] | null;
  referralSource: string | null;
  createdAt: string;
  updatedAt: string;
  recentSales: SaleSummary[];
}

/** Entry labeled `delivery` (or the first) / labeled `billing` (or the second). */
function pickAddress(
  list: CustomerAddress[] | null,
  kind: 'delivery' | 'billing',
): CustomerAddress {
  const arr = Array.isArray(list) ? list : [];
  const labeled = arr.find((a) => a?.label === kind);
  if (labeled) return labeled;
  return (kind === 'delivery' ? arr.find((a) => a?.label !== 'billing') : arr[1]) ?? {};
}
interface HistoryLine {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxCents: number;
  qtyFulfilled: number;
  qtyReturned: number;
  fulfillmentMethod: string | null;
}
interface HistoryOrder {
  id: string;
  docType: 'order' | 'sale';
  number: string;
  status: string;
  orderKind: string;
  fulfillmentType: string;
  requestedDate: string | null;
  importedAt: string | null;
  createdAt: string;
  totalCents: number;
  paidCents: number;
  balanceDueCents: number;
  lines: HistoryLine[];
}

function lineStateLabel(l: HistoryLine): string {
  const parts: string[] = [];
  if (l.qtyFulfilled >= l.quantity) parts.push('delivered');
  else if (l.qtyFulfilled > 0) parts.push(`delivered ${l.qtyFulfilled}/${l.quantity}`);
  else parts.push('pending');
  if (l.qtyReturned > 0) parts.push(`returned ${l.qtyReturned}`);
  if (l.fulfillmentMethod === 'take_with' || l.fulfillmentMethod === 'pickup')
    parts.push('take-with');
  return parts.join(' · ');
}

/** "receipt · imported from STORIS · 3/2/2024 · promised 2024-03-05" */
function historyFacts(o: HistoryOrder): string {
  return [
    o.docType === 'sale' ? 'receipt' : null,
    o.orderKind === 'exchange' ? 'exchange' : null,
    o.importedAt ? 'imported from STORIS' : null,
    new Date(o.createdAt).toLocaleDateString(),
    o.requestedDate ? `promised ${o.requestedDate}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = (params?.id ?? '') as string;
  const [c, setC] = useState<Customer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  // ZIP → city/state autofill memory per address block (delivery/billing).
  const zipMemos = useRef<Record<'d' | 'b', { current: ZipHit | null }>>({
    d: { current: null },
    b: { current: null },
  });
  const zipMemo = (prefix: 'd' | 'b') => zipMemos.current[prefix];
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [credit, setCredit] = useState<{
    balanceCents: number;
    entries: { id: string; deltaCents: number; reason: string | null; createdAt: string }[];
  } | null>(null);
  const [history, setHistory] = useState<HistoryOrder[] | null>(null);
  const [dupes, setDupes] = useState<
    {
      id: string;
      firstName: string | null;
      lastName: string | null;
      phone: string | null;
      email: string | null;
      matchedBy: string;
      docCount: number;
    }[]
  >([]);
  const [merging, setMerging] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function load() {
    setError(null);
    try {
      setC(await api<Customer>(`/v1/customers/${id}`));
      void api<{
        balanceCents: number;
        entries: { id: string; deltaCents: number; reason: string | null; createdAt: string }[];
      }>(`/v1/customers/${id}/store-credit`)
        .then(setCredit)
        .catch(() => setCredit(null));
      void api<HistoryOrder[]>(`/v1/customers/${id}/order-history?limit=25`)
        .then(setHistory)
        .catch(() => setHistory(null));
      void api<typeof dupes>(`/v1/customers/${id}/duplicates`)
        .then(setDupes)
        .catch(() => setDupes([]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function mergeDupe(sourceId: string) {
    const d = dupes.find((x) => x.id === sourceId);
    const label = d ? [d.firstName, d.lastName].filter(Boolean).join(' ') || 'this duplicate' : '';
    if (
      !window.confirm(
        `Merge ${label} into this record? Their orders, receipts, and credit move here, and the duplicate is deleted. This cannot be undone.`,
      )
    ) {
      return;
    }
    setMerging(true);
    try {
      await api(`/v1/customers/${id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ sourceCustomerId: sourceId }),
      });
      toast.success('Merged — one customer, one history.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }
  useEffect(() => {
    if (!id) return;
    api<CustomerSummary>(`/v1/customers/${id}/summary`)
      .then(setSummary)
      .catch(() => setSummary(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const data = new FormData(e.currentTarget);
      const addrFrom = (prefix: string, label: string) => {
        const entry = {
          label,
          line1: blankToNull(data.get(`${prefix}_line1`)),
          line2: blankToNull(data.get(`${prefix}_line2`)),
          city: blankToNull(data.get(`${prefix}_city`)),
          region: blankToNull(data.get(`${prefix}_region`)),
          postalCode: blankToNull(data.get(`${prefix}_postalCode`)),
        };
        return entry.line1 || entry.city ? entry : null;
      };
      const delivery = addrFrom('d', 'delivery');
      const billing = addrFrom('b', 'billing');
      const addresses = [...(delivery ? [delivery] : []), ...(billing ? [billing] : [])];
      await api(`/v1/customers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: blankToNull(data.get('firstName')),
          lastName: blankToNull(data.get('lastName')),
          email: blankToNull(data.get('email')),
          phone: blankToNull(data.get('phone')),
          phone2: blankToNull(data.get('phone2')),
          notes: blankToNull(data.get('notes')),
          referralSource: blankToNull(data.get('referralSource')),
          addressesJson: addresses.length > 0 ? addresses : null,
          prefix: blankToNull(data.get('prefix')),
          middleName: blankToNull(data.get('middleName')),
          suffix: blankToNull(data.get('suffix')),
          businessName: blankToNull(data.get('businessName')),
          contactName: blankToNull(data.get('contactName')),
          alternateName: blankToNull(data.get('alternateName')),
          alternateRelationship: blankToNull(data.get('alternateRelationship')),
          deliveryInstructions: blankToNull(data.get('deliveryInstructions')),
        }),
      });
      setSaved(true);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    if (!confirm('Delete this customer? Past sales remain but lose the link.')) return;
    try {
      await api(`/v1/customers/${id}`, { method: 'DELETE' });
      router.push('/customers');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportPurchases() {
    const start = '2000-01-01';
    const end = new Date().toISOString().slice(0, 10);
    setExporting(true);
    try {
      await downloadFile(
        `/v1/reports/customer-purchases?customerId=${id}&start=${start}&end=${end}&format=csv`,
        `purchases-${id}.csv`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const backLink = <BackLink href="/customers">All customers</BackLink>;

  if (error && !c) {
    return (
      <div>
        <PageHeader eyebrow={backLink} title="Customer not found" />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!c) {
    return (
      <div>
        <PageHeader eyebrow={backLink} title="Customer" />
        <LoadingRows />
      </div>
    );
  }

  const name =
    [c.prefix, c.firstName, c.middleName, c.lastName, c.suffix].filter(Boolean).join(' ') ||
    c.businessName ||
    '(no name)';

  return (
    <div>
      <PageHeader
        eyebrow={backLink}
        title={name}
        sub={`${c.customerNumber ? `${c.customerNumber} · ` : ''}${c.businessName ? `${c.businessName} · ` : ''}Customer since ${new Date(c.createdAt).toLocaleDateString()}`}
        actions={
          <LinkButton size="sm" href={`/customers/${id}/activity`} data-testid="view-activity">
            View customer activity
          </LinkButton>
        }
      />

      <Stack>
        <Card title="Details">
          <form onSubmit={save}>
            <FormGrid cols={2}>
              <Field label="Customer #" hint="Assigned automatically">
                <Input value={c.customerNumber ?? '—'} readOnly data-testid="customer-number" />
              </Field>
              <Field label="Prefix" hint="Mr., Ms., Dr.">
                <Input name="prefix" defaultValue={c.prefix ?? ''} />
              </Field>
              <Field label="First name">
                <Input name="firstName" defaultValue={c.firstName ?? ''} />
              </Field>
              <Field label="Middle name">
                <Input name="middleName" defaultValue={c.middleName ?? ''} />
              </Field>
              <Field label="Last name">
                <Input name="lastName" defaultValue={c.lastName ?? ''} />
              </Field>
              <Field label="Suffix" hint="Jr., Sr., III">
                <Input name="suffix" defaultValue={c.suffix ?? ''} />
              </Field>
              <Field label="Business name" hint="Trade accounts">
                <Input name="businessName" defaultValue={c.businessName ?? ''} />
              </Field>
              <Field label="Contact name" hint="Who to ask for at the business">
                <Input name="contactName" defaultValue={c.contactName ?? ''} />
              </Field>
              <Field label="Alternate contact">
                <Input name="alternateName" defaultValue={c.alternateName ?? ''} />
              </Field>
              <Field label="Relationship" hint="Spouse, partner, assistant…">
                <Input name="alternateRelationship" defaultValue={c.alternateRelationship ?? ''} />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" defaultValue={c.email ?? ''} />
              </Field>
              <Field label="Phone">
                <Input name="phone" type="tel" defaultValue={c.phone ?? ''} />
              </Field>
              <Field label="2nd phone (optional)">
                <Input name="phone2" type="tel" defaultValue={c.phone2 ?? ''} />
              </Field>
              <Field label="How did they hear about us?">
                <Input name="referralSource" defaultValue={c.referralSource ?? ''} />
              </Field>
              {(['d', 'b'] as const).map((prefix) => {
                const kind = prefix === 'd' ? 'delivery' : 'billing';
                const a = pickAddress(c.addressesJson, kind);
                const groupLabel =
                  kind === 'delivery' ? 'Delivery address' : 'Billing address (if different)';
                return (
                  <Fragment key={prefix}>
                    <SectionHeading as="h3" title={groupLabel} />
                    <Input
                      name={`${prefix}_line1`}
                      placeholder="Street address"
                      aria-label={`${groupLabel}: street address`}
                      defaultValue={a.line1 ?? ''}
                      className="w-full"
                    />
                    <Input
                      name={`${prefix}_line2`}
                      placeholder="Apt / unit"
                      aria-label={`${groupLabel}: apt / unit`}
                      defaultValue={a.line2 ?? ''}
                      className="w-full"
                    />
                    <FormGrid cols={3} className="form-span">
                      <Input
                        name={`${prefix}_city`}
                        placeholder="City"
                        aria-label={`${groupLabel}: city`}
                        defaultValue={a.city ?? ''}
                        className="w-full"
                      />
                      <Input
                        name={`${prefix}_region`}
                        placeholder="State"
                        aria-label={`${groupLabel}: state`}
                        defaultValue={a.region ?? ''}
                        className="w-full"
                      />
                      <Input
                        name={`${prefix}_postalCode`}
                        placeholder="ZIP"
                        aria-label={`${groupLabel}: ZIP`}
                        defaultValue={a.postalCode ?? ''}
                        className="w-full"
                        onChange={(e) =>
                          autofillFormFromZip(
                            e.currentTarget,
                            { city: `${prefix}_city`, region: `${prefix}_region` },
                            zipMemo(prefix),
                          )
                        }
                      />
                    </FormGrid>
                  </Fragment>
                );
              })}
              <Field
                label="Delivery instructions"
                hint="Standing instructions — pre-filled on every order"
                className="form-span"
              >
                <textarea
                  name="deliveryInstructions"
                  defaultValue={c.deliveryInstructions ?? ''}
                  rows={2}
                  className="textarea"
                />
              </Field>
              <Field label="Notes" className="form-span">
                <textarea name="notes" defaultValue={c.notes ?? ''} rows={3} className="textarea" />
              </Field>
              {error && (
                <Alert tone="error" className="form-span">
                  {error}
                </Alert>
              )}
              {saved && (
                <Alert tone="success" className="form-span">
                  Saved.
                </Alert>
              )}
            </FormGrid>
            <FormActions
              start={
                <Button type="button" variant="danger" size="sm" onClick={destroy}>
                  <Trash2 size={14} aria-hidden />
                  Delete customer
                </Button>
              }
            >
              <Button type="submit" variant="primary" disabled={saving}>
                <Save size={14} aria-hidden />
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </FormActions>
          </form>
        </Card>

        {dupes.length > 0 && (
          <Card
            title="Possible duplicates"
            description={
              <>
                These records look like the same person. Merging moves their whole history — orders,
                receipts, store credit, notes — onto <strong>this</strong> record and deletes the
                duplicate.
              </>
            }
            flush
            data-testid="duplicates-card"
          >
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Contact</th>
                    <th>Matched by</th>
                    <th className="num">Documents</th>
                    <th className="actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dupes.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <Link href={`/customers/${d.id}`}>
                          <strong>
                            {[d.firstName, d.lastName].filter(Boolean).join(' ') || 'unnamed'}
                          </strong>
                        </Link>
                      </td>
                      <td>
                        {[d.phone, d.email].filter(Boolean).join(' · ') || (
                          <span className="muted">no contact info</span>
                        )}
                      </td>
                      <td>same {d.matchedBy}</td>
                      <td className="num">{d.docCount}</td>
                      <td className="actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={merging}
                          data-testid={`merge-${d.id}`}
                          onClick={() => void mergeDupe(d.id)}
                        >
                          {merging ? 'Merging…' : 'Merge into this record'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        )}

        {credit && (credit.balanceCents > 0 || credit.entries.length > 0) && (
          <Card title="Store credit">
            <Stack>
              <StatGrid cols={4}>
                <StatTile
                  label="Balance"
                  value={<Money cents={credit.balanceCents} />}
                  sub="Never expires — auto-surfaces at checkout"
                  tone={credit.balanceCents > 0 ? 'success' : undefined}
                  data-testid="store-credit-balance"
                />
              </StatGrid>
              {credit.entries.length > 0 && (
                <TableWrap>
                  <table className="table table-dense">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th className="num">Amount</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credit.entries.slice(0, 10).map((e) => (
                        <tr key={e.id}>
                          <td>{new Date(e.createdAt).toLocaleDateString()}</td>
                          <td
                            className={`num ${e.deltaCents > 0 ? 'text-success' : 'text-danger'}`}
                          >
                            {e.deltaCents > 0 ? '+' : ''}
                            <Money cents={e.deltaCents} />
                          </td>
                          <td>{e.reason ?? <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Stack>
          </Card>
        )}

        {summary && (
          <Card title="Activity totals" data-testid="customer-totals">
            <StatGrid cols={4}>
              <StatTile label="Lifetime documents" value={summary.lifetime.documents} />
              <StatTile
                label="Lifetime total"
                value={<Money cents={summary.lifetime.totalCents} />}
              />
              <StatTile label="YTD documents" value={summary.ytd.documents} />
              <StatTile label="YTD total" value={<Money cents={summary.ytd.totalCents} />} />
            </StatGrid>
          </Card>
        )}

        {summary && summary.openOrders.length > 0 && (
          <Card title="Open orders" flush data-testid="customer-open-orders">
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Requested</th>
                    <th className="num">Total</th>
                    <th className="num">Paid</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.openOrders.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <Link href={`/orders/${o.id}`}>{o.number}</Link>
                      </td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                      <td>{o.requestedDate ?? '—'}</td>
                      <td className="num">
                        <Money cents={o.totalCents} />
                      </td>
                      <td className="num">
                        <Money cents={o.paidCents} />
                      </td>
                      <td className="num">
                        <strong>
                          <Money cents={o.balanceCents} />
                        </strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        )}

        <SectionHeading
          title="Purchase history"
          actions={
            <Button
              size="sm"
              variant="secondary"
              disabled={exporting}
              onClick={() => void exportPurchases()}
            >
              {exporting ? 'Exporting…' : 'Export purchase history CSV'}
            </Button>
          }
        />
        <Stack data-testid="purchase-history">
          {!history || history.length === 0 ? (
            <Card>
              <EmptyState title="No purchases yet">
                Orders and register sales for this customer will show up here.
              </EmptyState>
            </Card>
          ) : (
            history.map((o) => (
              <Card
                key={o.id}
                flush
                data-testid="history-order"
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link href={o.docType === 'sale' ? `/sales/${o.id}` : `/orders/${o.id}`}>
                      {o.number}
                    </Link>
                    <StatusBadge status={o.status} />
                  </span>
                }
                description={historyFacts(o)}
                actions={
                  <>
                    <strong>
                      <Money cents={o.totalCents} />
                    </strong>
                    {o.balanceDueCents > 0 ? (
                      <span className="text-danger">
                        owes <Money cents={o.balanceDueCents} />
                      </span>
                    ) : (
                      <span className="text-success">paid</span>
                    )}
                  </>
                }
              >
                {o.lines.length > 0 && (
                  <TableWrap>
                    <table className="table table-dense">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th className="num">Qty</th>
                          <th className="num">Unit price</th>
                          <th className="num">Line total</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.lines.map((l) => (
                          <tr key={l.id}>
                            <td>{l.description}</td>
                            <td className="num">{l.quantity}</td>
                            <td className="num">
                              <Money cents={l.unitPriceCents} />
                            </td>
                            <td className="num">
                              <Money cents={l.totalCents + l.taxCents} />
                            </td>
                            <td className="muted">{lineStateLabel(l)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>
            ))
          )}
        </Stack>
      </Stack>
    </div>
  );
}

function blankToNull(v: FormDataEntryValue | null): string | null {
  const s = v == null ? '' : String(v).trim();
  return s.length > 0 ? s : null;
}
