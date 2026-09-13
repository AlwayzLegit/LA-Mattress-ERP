'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  EmptyState,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  TableWrap,
  useListColumns,
} from '@/components/ui';

/**
 * STORIS "Recover STORIS Licenses" → Settings → Active sessions (A22
 * slice 7): every member's sign-ins — who, IP, device, signed in, last
 * seen — with Sign out, so a stuck terminal or a departed employee's
 * laptop is off the system now.
 */

interface SessionRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  roleName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

function device(ua: string | null): string {
  if (!ua) return '—';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Other';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : 'Browser';
  return `${browser} · ${os}`;
}

export default function ActiveSessionsPage() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<SessionRow[]>('/v1/business/sessions'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function signOut(row: SessionRow) {
    if (
      row.current &&
      !confirm('This is the session you are using right now. Sign yourself out?')
    ) {
      return;
    }
    setBusy(row.id);
    try {
      await api(`/v1/business/sessions/${row.id}`, { method: 'DELETE' });
      toast.success(
        `${row.name ?? row.email} signed out${row.current ? ' — this session too' : ''}`,
      );
      if (row.current) window.location.href = '/sign-in';
      else await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // Built inline: the Sign out cell needs `busy` and `signOut`.
  const columns: ColumnDef<SessionRow>[] = [
    {
      id: 'member',
      label: 'Member',
      sortValue: (r) => r.name ?? r.email,
      render: (r) => (
        <>
          <div className="font-semibold">{r.name ?? r.email}</div>
          <div className="muted text-xs">
            {r.email}
            {r.current ? ' · this session' : ''}
          </div>
        </>
      ),
    },
    {
      id: 'role',
      label: 'Role',
      sortValue: (r) => r.roleName,
      render: (r) => r.roleName ?? '—',
    },
    {
      id: 'device',
      label: 'Device',
      sortValue: (r) => device(r.userAgent),
      render: (r) => <span title={r.userAgent ?? undefined}>{device(r.userAgent)}</span>,
    },
    {
      id: 'ip',
      label: 'IP',
      sortValue: (r) => r.ipAddress,
      render: (r) => <code>{r.ipAddress ?? '—'}</code>,
    },
    {
      id: 'signedIn',
      label: 'Signed in',
      sortValue: (r) => r.createdAt,
      render: (r) => new Date(r.createdAt).toLocaleString(),
    },
    {
      id: 'lastSeen',
      label: 'Last seen',
      sortValue: (r) => r.lastSeenAt,
      render: (r) => new Date(r.lastSeenAt).toLocaleString(),
    },
    {
      id: 'expires',
      label: 'Expires',
      sortValue: (r) => r.expiresAt,
      render: (r) => new Date(r.expiresAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <Button
          size="sm"
          variant="danger"
          disabled={busy === r.id}
          onClick={() => void signOut(r)}
          data-testid="session-sign-out"
        >
          Sign out
        </Button>
      ),
    },
  ];
  const cols = useListColumns('settings-sessions', columns, rows);

  return (
    <div data-testid="active-sessions">
      <PageHeader
        eyebrow={<BackLink href="/settings">Business settings</BackLink>}
        title="Active sessions"
        sub="Every member's sign-ins. Sign one out to recover a stuck terminal or cut off a device that should no longer have access."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {rows == null ? (
          <Card>
            <LoadingRows rows={4} />
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState title="No active sessions" />
          </Card>
        ) : (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="settings-sessions" />
                </thead>
                <tbody>
                  {cols.sorted.map((r) => (
                    <tr key={r.id} data-testid="session-row">
                      <ColumnCells list={cols} row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
              <ResetColumns list={cols} />
            </TableWrap>
          </Card>
        )}
      </Stack>
    </div>
  );
}
