'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BUSINESS_PERMISSIONS } from '@jetnine/shared';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Stack,
  TableEmpty,
  TableWrap,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';

interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

interface Member {
  membershipId: string;
  roleId: string;
}

export default function RolesPage() {
  const router = useRouter();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [memberCounts, setMemberCounts] = useState<Map<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRoles(await api<Role[]>('/v1/business/roles'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // Member counts are garnish — the viewer may hold roles.view without
    // users.view, so a failure here just hides the column.
    try {
      const members = await api<Member[]>('/v1/business/members');
      const counts = new Map<string, number>();
      for (const m of members) counts.set(m.roleId, (counts.get(m.roleId) ?? 0) + 1);
      setMemberCounts(counts);
    } catch {
      setMemberCounts(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(role: Role) {
    if (!confirm(`Delete role "${role.name}"? Members must be reassigned first.`)) return;
    try {
      await api(`/v1/business/roles/${role.id}`, { method: 'DELETE' });
      toast.success(`Role "${role.name}" deleted.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const total = BUSINESS_PERMISSIONS.length;

  // The Members column only exists once the count lookup succeeds, and
  // the actions cell calls `remove`, so the columns are built here. Rows
  // navigate on click; the actions span swallows the click.
  const columns: ColumnDef<Role>[] = [
    {
      id: 'role',
      label: 'Role',
      sortValue: (r) => r.name,
      render: (r) => (
        <>
          <span className="inline-flex items-center gap-2">
            <Link href={`/roles/${r.id}`} onClick={(e) => e.stopPropagation()}>
              <strong>{r.name}</strong>
            </Link>
            {r.isSystem ? (
              <span className="badge badge-neutral">System</span>
            ) : (
              <span className="badge badge-success">Custom</span>
            )}
          </span>
          {r.description && <div className="muted text-xs">{r.description}</div>}
        </>
      ),
    },
    {
      id: 'permissions',
      label: 'Permissions',
      sortValue: (r) => r.permissions.length,
      render: (r) => <PermissionMeter granted={r.permissions.length} total={total} />,
    },
    ...(memberCounts
      ? [
          {
            id: 'members',
            label: 'Members',
            num: true,
            sortValue: (r) => memberCounts.get(r.id) ?? 0,
            render: (r) => memberCounts.get(r.id) ?? 0,
          } satisfies ColumnDef<Role>,
        ]
      : []),
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <LinkButton size="sm" variant="ghost" href={`/roles/new?basedOn=${r.id}`}>
            Duplicate
          </LinkButton>
          {!r.isSystem && (
            <Button size="sm" variant="danger" onClick={() => remove(r)}>
              Delete
            </Button>
          )}
        </span>
      ),
    },
  ];
  const cols = useListColumns('roles', columns, roles);

  return (
    <div>
      <PageHeader
        title="Roles"
        sub="Roles bundle permissions. Assign one per member, then fine-tune individuals from their member page."
        actions={
          <LinkButton href="/roles/new" variant="primary">
            <Plus size={14} aria-hidden />
            Create role
          </LinkButton>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}
        {!roles && !error && (
          <Card>
            <LoadingRows />
          </Card>
        )}
        {roles && (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="roles" />
                </thead>
                <tbody>
                  {roles.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>No roles yet.</TableEmpty>
                  )}
                  {cols.sorted.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/roles/${r.id}`)}
                    >
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

function PermissionMeter({ granted, total }: { granted: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((granted / total) * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="inline-block h-1.5 w-[90px] overflow-hidden rounded-full bg-[var(--surface-muted)]"
      >
        <span className="block h-full bg-[var(--brand)]" style={{ width: `${pct}%` }} />
      </span>
      <span className="muted text-xs">
        {granted} of {total}
      </span>
    </span>
  );
}
