'use client';

import { Building2, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { CURRENCY_LABELS, SUPPORTED_CURRENCIES, type CurrencyCode } from '@jetnine/shared';
import { AuthCard, AuthLink, AuthShell } from '@/components/auth/auth-shell';
import {
  Form,
  FormAlert,
  FormRootError,
  SelectField,
  SubmitButton,
  TextField,
  useZodForm,
} from '@/components/form/form';
import { Button, FormGrid, Skeleton, Stack } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface MembershipSummary {
  businessId: string;
  businessSlug: string;
  businessName: string;
  roleName: string;
  status: string;
}

/**
 * Landing for a freshly-signed-up user (rebuilt 2026-09-02 on the form
 * kit). Three branches:
 *
 *   1. They already have memberships → a picker; choosing one sets the
 *      active-business cookie and lands on /dashboard.
 *   2. They have zero memberships → the create-your-business form, a
 *      three-step stepper so they know where they are. Submitting calls
 *      POST /v1/onboarding/business and lands them in it as Owner.
 *   3. Loading → skeleton.
 */
export default function WelcomePage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<MembershipSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const me = await api<{ memberships: MembershipSummary[] }>('/v1/auth/me');
        setMemberships(me.memberships.filter((m) => m.status === 'active'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  async function pick(businessId: string) {
    try {
      await api('/v1/auth/active-business', {
        method: 'POST',
        body: JSON.stringify({ businessId }),
      });
      // Back to the page that needed a business (lib/api.ts sends ?next=);
      // same-site paths only.
      const next = new URLSearchParams(window.location.search).get('next');
      router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  let body: React.ReactNode;
  if (memberships == null && !error) {
    body = (
      <Stack gap="sm" aria-busy>
        <Skeleton style={{ height: 28, width: 220 }} />
        <Skeleton style={{ height: 48 }} />
        <Skeleton style={{ height: 48 }} />
      </Stack>
    );
  } else if (error && memberships == null) {
    body = (
      <AuthCard title="Something went wrong">
        <FormAlert tone="error">{error}</FormAlert>
        <div className="auth-actions">
          <Button variant="primary" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </AuthCard>
    );
  } else if (memberships && memberships.length > 0 && !creating) {
    body = (
      <AuthCard
        title="Pick a business"
        subtitle={`You belong to ${memberships.length} ${memberships.length === 1 ? 'business' : 'businesses'}. Choose one to continue.`}
        footer={
          <span>
            Need a new one?{' '}
            <button type="button" className="btn-link" onClick={() => setCreating(true)}>
              Create a new business
            </button>
          </span>
        }
      >
        <div className="choice-list" data-testid="business-picker">
          {memberships.map((m) => (
            <button
              key={m.businessId}
              type="button"
              className="choice"
              onClick={() => void pick(m.businessId)}
              data-testid="business-choice"
            >
              <span>
                <strong>{m.businessName}</strong>
                <span className="muted block text-xs">
                  <code>{m.businessSlug}</code> · {m.roleName}
                </span>
              </span>
              <ChevronRight size={16} aria-hidden className="muted shrink-0" />
            </button>
          ))}
        </div>
      </AuthCard>
    );
  } else {
    body = (
      <CreateBusiness
        onBack={memberships && memberships.length > 0 ? () => setCreating(false) : undefined}
      />
    );
  }

  return (
    <AuthShell wide>
      <Stack>
        {body}
        {/* Business-less users land here (dashboard redirects them), so
            this page needs its own way out of the account. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="muted text-xs">
            Got an invite link? <AuthLink href="/accept-invite">Accept invite</AuthLink>
          </span>
          <SignOutButton />
        </div>
      </Stack>
    </AuthShell>
  );
}

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Enter the business name.')
    .max(80, 'Keep it under 80 characters.'),
  slug: z
    .string()
    .trim()
    .min(1, 'Enter a URL slug.')
    .max(64, 'Keep it under 64 characters.')
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, numbers and hyphens only.'),
  currencyCode: z.string().min(3, 'Pick a currency.'),
  taxRate: z.coerce
    .number({ message: 'Enter a number.' })
    .min(0, 'Cannot be negative.')
    .max(100, 'Cannot exceed 100%.'),
});
type Values = z.output<typeof schema>;

function CreateBusiness({ onBack }: { onBack?: () => void }) {
  const router = useRouter();
  const form = useZodForm(schema, { name: '', slug: '', currencyCode: 'USD', taxRate: 0 });
  const [slugTouched, setSlugTouched] = useState(false);
  const name = form.watch('name');
  const slug = form.watch('slug');

  useEffect(() => {
    if (!slugTouched) form.setValue('slug', slugify(name ?? ''), { shouldValidate: !!name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, slugTouched]);

  return (
    <AuthCard
      title="Set up your business"
      subtitle="Under a minute. Everything here can be changed later in Settings."
      footer={
        onBack ? (
          <button type="button" className="btn-link" onClick={onBack}>
            ← Back to the picker
          </button>
        ) : undefined
      }
    >
      <ol className="stepper" aria-label="Setup progress">
        <li className="step done">
          <span className="step-dot">✓</span> Account
        </li>
        <li className="step active">
          <span className="step-dot">2</span> Business
        </li>
        <li className="step">
          <span className="step-dot">3</span> First store
        </li>
      </ol>
      <Form<Values>
        form={form}
        onSubmit={async (values) => {
          try {
            const created = await api<{ businessId: string }>('/v1/onboarding/business', {
              method: 'POST',
              body: JSON.stringify({
                name: values.name,
                slug: values.slug,
                currencyCode: values.currencyCode,
                defaultTaxRateBps: Math.round(values.taxRate * 100),
              }),
            });
            // Make the new business active so the dashboard's first render lands inside it.
            await api('/v1/auth/active-business', {
              method: 'POST',
              body: JSON.stringify({ businessId: created.businessId }),
            });
            toast.success(`${values.name} is ready. Next: add your first store.`);
            router.push('/dashboard');
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              form.setError('slug', { message: 'That slug is taken. Try another.' });
              return;
            }
            throw err;
          }
        }}
      >
        <TextField<Values>
          name="name"
          label="Business name"
          autoFocus
          placeholder="LA Mattress Stores"
          autoComplete="organization"
        />
        <TextField<Values>
          name="slug"
          label="URL slug"
          placeholder="la-mattress-stores"
          hint={
            slug
              ? `Your address will be app.jetnine.com/${slug}. Lowercase letters, numbers, hyphens.`
              : 'Follows the name automatically. Lowercase letters, numbers, hyphens.'
          }
          onChange={(e) => {
            setSlugTouched(true);
            form.setValue('slug', slugify(e.target.value, { keepTrailingHyphen: true }));
          }}
          onBlur={(e) => form.setValue('slug', slugify(e.target.value), { shouldValidate: true })}
        />
        <FormGrid cols={2}>
          <SelectField<Values> name="currencyCode" label="Currency">
            {SUPPORTED_CURRENCIES.map((c: CurrencyCode) => (
              <option key={c} value={c}>
                {c} — {CURRENCY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          <TextField<Values>
            name="taxRate"
            label="Default tax rate (%)"
            type="number"
            step="0.01"
            min={0}
            inputMode="decimal"
            hint="Override per product or per store later."
          />
        </FormGrid>
        <FormRootError testid="onboarding-error" />
        <SubmitButton pendingLabel="Creating…" className="w-full">
          <Building2 size={14} aria-hidden />
          Create business
        </SubmitButton>
      </Form>
    </AuthCard>
  );
}

function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        const { signOut } = await import('@/lib/auth-client');
        await signOut();
        window.location.href = '/login';
      }}
    >
      Sign out
    </Button>
  );
}

/**
 * Whatever a person types becomes a valid slug instead of a 400 from the
 * API: lowercase, spaces and punctuation collapse to single hyphens, no
 * leading/trailing hyphen. `keepTrailingHyphen` leaves a trailing hyphen
 * alone mid-typing so "la-" doesn't snap back to "la" between keystrokes.
 */
function slugify(raw: string, opts?: { keepTrailingHyphen?: boolean }): string {
  let out = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '');
  if (!opts?.keepTrailingHyphen) out = out.replace(/-+$/, '');
  return out.slice(0, 64);
}
