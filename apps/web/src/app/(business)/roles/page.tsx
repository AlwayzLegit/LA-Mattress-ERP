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
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  TableEmpty,
  TableWrap,
  rowKeys,
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
  const colSpan = memberCounts ? 4 : 3;

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
                  <tr>
                    <th>Role</th>
                    <th>Permissions</th>
                    {memberCounts && <th className="num">Members</th>}
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.length === 0 && <TableEmpty colSpan={colSpan}>No roles yet.</TableEmpty>}
                  {roles.map((r) => (
                    <tr
                      {...rowKeys}
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/roles/${r.id}`)}
                    >
                      <td>
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
                      </td>
                      <td>
                        <PermissionMeter granted={r.permissions.length} total={total} />
                      </td>
                      {memberCounts && <td className="num">{memberCounts.get(r.id) ?? 0}</td>}
                      <td className="actions" onClick={(e) => e.stopPropagation()}>
                        <LinkButton size="sm" variant="ghost" href={`/roles/new?basedOn=${r.id}`}>
                          Duplicate
                        </LinkButton>
                        {!r.isSystem && (
                          <Button size="sm" variant="danger" onClick={() => remove(r)}>
                            Delete
                          </Button>
                        )}
                      </td>
                    </tr>
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
