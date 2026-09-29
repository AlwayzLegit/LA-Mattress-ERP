'use client';

import { Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  Field,
  FormActions,
  FormGrid,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
} from '@/components/ui';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';

type AccountKind = 'agency' | 'saas';

interface BusinessSummary {
  id: string;
  slug: string;
  name: string;
  accountKind: AccountKind;
  status: string;
  plan: string | null;
  subscriptionStatus: 'trial' | 'active' | 'past_due' | 'canceled';
  trialEndsAt: string | null;
  readOnly: boolean;
  mrrCents: number;
  createdAt: string;
  userCount: number;
  locationCount: number;
  lastActivityAt: string | null;
  lastPaidAt: string | null;
}

type KindFilter = 'all' | AccountKind;

const KIND_LABEL: Record<AccountKind, string> = { agency: 'Agency', saas: 'SaaS' };

export default function BusinessesPage() {
  const [rows, setRows] = useState<BusinessSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>('all');

  async function load() {
    try {
      setRows(await api<BusinessSummary[]>('/v1/admin/accounts'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const visible = rows?.filter((r) => filter === 'all' || r.accountKind === filter) ?? null;
  const agencyCount = rows?.filter((r) => r.accountKind === 'agency').length ?? 0;
  const saasCount = rows?.filter((r) => r.accountKind === 'saas').length ?? 0;
  const mrrCents = rows?.reduce((sum, r) => sum + r.mrrCents, 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="Accounts"
        sub="Agency accounts are your own operation (never billed). SaaS accounts are paying tenants."
      />
      <Stack>
        <CreateBusinessForm onCreated={load} />
        {error && <Alert tone="error">{error}</Alert>}
        {!rows && !error && <LoadingRows />}
        {rows && visible && (
          <Card
            flush
            title="All accounts"
            description={`${agencyCount} agency · ${saasCount} SaaS · ${formatMoney(mrrCents)}/mo MRR`}
            actions={
              <Toolbar>
                {(['all', 'agency', 'saas'] as KindFilter[]).map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant={filter === k ? 'primary' : 'secondary'}
                    onClick={() => setFilter(k)}
                  >
                    {k === 'all' ? 'All' : KIND_LABEL[k]}
                  </Button>
                ))}
              </Toolbar>
            }
          >
            <TableWrap>
              <table data-testid="businesses-table" className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Plan</th>
                    <th>Subscription</th>
                    <th className="num">MRR</th>
                    <th className="num">Users</th>
                    <th className="num">Locations</th>
                    <th>Last activity</th>
                    <th className="actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <TableEmpty colSpan={9}>
                      {rows.length === 0
                        ? 'No accounts yet. Create one above.'
                        : 'No accounts of this kind.'}
                    </TableEmpty>
                  )}
                  {visible.map((b) => (
                    <BusinessRow key={b.id} business={b} onChanged={load} />
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}

function CreateBusinessForm({ onCreated }: { onCreated: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Capture the form before awaiting: React nulls `currentTarget` once
    // the handler returns, so reading it after the request throws.
    const form = e.currentTarget;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const data = new FormData(form);
      const result = await api<{ businessId: string }>('/v1/admin/businesses', {
        method: 'POST',
        body: JSON.stringify({
          name: String(data.get('name') ?? ''),
          slug: String(data.get('slug') ?? ''),
          ownerEmail: String(data.get('ownerEmail') ?? ''),
          ownerName: String(data.get('ownerName') ?? ''),
        }),
      });
      setSuccess(`Created ${result.businessId}. Invitation sent.`);
      form.reset();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      title="Create business"
      description="Provisions the tenant and emails the owner an invitation."
    >
      <form onSubmit={submit}>
        <FormGrid cols={2}>
          <Field label="Name" required>
            <Input name="name" required />
          </Field>
          <Field label="Slug" required hint="Lowercase letters, digits and dashes">
            <Input name="slug" required pattern="[a-z0-9-]+" />
          </Field>
          <Field label="Owner email" required>
            <Input name="ownerEmail" type="email" required />
          </Field>
          <Field label="Owner name (optional)">
            <Input name="ownerName" />
          </Field>
        </FormGrid>
        {error && (
          <Alert tone="error" data-testid="create-error" className="mt-3">
            {error}
          </Alert>
        )}
        {success && (
          <Alert tone="success" data-testid="create-success" className="mt-3">
            {success}
          </Alert>
        )}
        <FormActions>
          <Button type="submit" variant="primary" disabled={submitting}>
            <Building2 size={14} aria-hidden />
            {submitting ? 'Working…' : 'Create + invite owner'}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

function BusinessRow({
  business,
  onChanged,
}: {
  business: BusinessSummary;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function setStatus(status: 'active' | 'suspended') {
    setPending(true);
    try {
      await api(`/v1/admin/businesses/${business.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <tr>
      <td>
        <strong>{business.name}</strong>
        <div className="muted">
          <code>{business.slug}</code>
        </div>
      </td>
      <td>
        <span
          className={`badge ${business.accountKind === 'agency' ? 'badge-brand' : 'badge-neutral'}`}
        >
          {KIND_LABEL[business.accountKind]}
        </span>
      </td>
      <td>
        {business.accountKind === 'agency' ? (
          <span className="muted">house</span>
        ) : (
          (business.plan ?? '—')
        )}
      </td>
      <td>
        <StatusBadge status={business.subscriptionStatus} />
        {business.readOnly && (
          <span className="badge badge-danger" style={{ marginLeft: 6 }}>
            read-only
          </span>
        )}
      </td>
      <td className="num">{business.mrrCents ? formatMoney(business.mrrCents) : '—'}</td>
      <td className="num">{business.userCount}</td>
      <td className="num">{business.locationCount}</td>
      <td>
        {business.lastActivityAt ? (
          new Date(business.lastActivityAt).toLocaleString()
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="actions">
        <LinkButton size="sm" variant="secondary" href={`/admin/businesses/${business.id}`}>
          Open
        </LinkButton>
        {business.status === 'suspended' ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setStatus('active')}>
            Unsuspend
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setStatus('suspended')}
          >
            Suspend
          </Button>
        )}
      </td>
    </tr>
  );
}
