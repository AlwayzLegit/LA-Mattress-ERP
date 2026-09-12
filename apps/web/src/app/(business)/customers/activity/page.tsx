'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Card,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Stack,
  TableWrap,
  rowKeys,
} from '@/components/ui';

/**
 * View Customer Activity — lookup (owner 2026-09-02, STORIS-style blank
 * screen): type a name, phone or email, pick the customer, and land on
 * their activity views.
 */

interface Hit {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
}

export default function CustomerActivityLookupPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api<{ data: Hit[] }>(`/v1/customers?q=${encodeURIComponent(term)}&limit=20`)
        .then((r) => {
          if (!stale) setHits(r.data);
        })
        .catch((err) => {
          if (!stale) setError(err instanceof Error ? err.message : String(err));
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/customers">All customers</BackLink>}
        title="View Customer Activity"
        sub="Look up a customer to see their orders, line details, purchase history, deposits, receivables and service orders."
      />
      <Card>
        <Stack>
          <Field
            label="Customer"
            hint="Type at least two characters. Press Enter to open the first match."
            className="form-narrow"
          >
            <div className="relative">
              <Input
                autoFocus
                placeholder="Name, phone or email"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hits && hits[0]) {
                    router.push(`/customers/${hits[0].id}/activity`);
                  }
                }}
                data-testid="activity-lookup"
                className="w-full"
                // Same adornment inset the auth form kit uses (globals .input-adornment).
                style={{ paddingRight: 36 }}
              />
              <span className="input-adornment pointer-events-none" aria-hidden>
                <Search size={16} />
              </span>
            </div>
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          {hits && hits.length === 0 && (
            <EmptyState title="No customers match">Try another name, phone or email.</EmptyState>
          )}
          {hits && hits.length > 0 && (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th className="actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hits.map((h) => (
                    <tr
                      {...rowKeys}
                      key={h.id}
                      data-testid="activity-lookup-hit"
                      onClick={() => router.push(`/customers/${h.id}/activity`)}
                      className="cursor-pointer"
                    >
                      <td>
                        <strong>
                          {[h.firstName, h.lastName].filter(Boolean).join(' ') || '(no name)'}
                        </strong>
                      </td>
                      <td>{h.phone ?? h.phone2 ?? '—'}</td>
                      <td>{h.email ?? '—'}</td>
                      <td className="actions">
                        <LinkButton
                          size="sm"
                          href={`/customers/${h.id}/activity`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          View activity
                        </LinkButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Stack>
      </Card>
    </div>
  );
}
