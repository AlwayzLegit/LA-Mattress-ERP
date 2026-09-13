'use client';

import Link from 'next/link';
import { Copy, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Field,
  FormActions,
  FormGrid,
  Input,
  LinkButton,
  LoadingRows,
  PageHeader,
  ResetColumns,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  rowKeys,
  useListColumns,
} from '@/components/ui';
import { api } from '@/lib/api';

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  status: string;
  roleId: string;
  roleName: string;
  dataScope: 'all' | 'store';
  scopeLocationIds: string[];
  invitedAt: string | null;
  acceptedAt: string | null;
}

interface Role {
  id: string;
  name: string;
  isSystem: boolean;
}

export default function MembersPage() {
  const router = useRouter();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  // Set when the API tells us the invitation mail was captured rather than
  // sent (no mail transport configured). The invite is real either way, so
  // we show the link and let the inviter pass it on themselves.
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  // Owner 2026-09-02: Delete shows only to who holds users.delete, never on self.
  const [me, setMe] = useState<{ membershipId: string | null; canDeleteMembers: boolean } | null>(
    null,
  );

  async function load() {
    try {
      const [m, r] = await Promise.all([
        api<Member[]>('/v1/business/members'),
        api<Role[]>('/v1/business/roles'),
      ]);
      void api<{ membershipId: string | null; canDeleteMembers: boolean }>(
        '/v1/business/members/me',
      )
        .then((r) => setMe({ membershipId: r.membershipId, canDeleteMembers: r.canDeleteMembers }))
        .catch(() => setMe(null));
      setMembers(m);
      setRoles(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setInviteLink(null);
    setInviting(true);
    const form = e.currentTarget;
    try {
      const data = new FormData(form);
      const result = await api<{ alreadyMember: boolean; inviteLink?: string }>(
        '/v1/business/members/invite',
        {
          method: 'POST',
          body: JSON.stringify({
            email: String(data.get('email') ?? ''),
            name: String(data.get('name') ?? ''),
            roleId: String(data.get('roleId') ?? ''),
          }),
        },
      );
      setInviteLink(result.inviteLink ?? null);
      setSuccess(
        result.alreadyMember
          ? 'That user is already an active member; nothing to do.'
          : result.inviteLink
            ? 'Invitation created. Email is not configured, so send this link yourself:'
            : 'Invitation sent.',
      );
      form.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviting(false);
    }
  }

  async function removeMember(m: Member) {
    if (
      !confirm(
        `Delete ${m.name || m.email} from this business? They lose access now. Anything they wrote stays on record under their name.`,
      )
    )
      return;
    try {
      const r = await api<{ mode: 'deleted' | 'archived' }>(
        `/v1/business/members/${m.membershipId}`,
        {
          method: 'DELETE',
        },
      );
      setSuccess(
        r.mode === 'deleted'
          ? `${m.name || m.email} deleted.`
          : `${m.name || m.email} removed — their history is kept.`,
      );
      setMembers((prev) => (prev ?? []).filter((x) => x.membershipId !== m.membershipId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resend(membershipId: string) {
    setError(null);
    try {
      const result = await api<{ inviteLink?: string }>(
        `/v1/business/members/${membershipId}/resend-invite`,
        { method: 'POST' },
      );
      setInviteLink(result.inviteLink ?? null);
      setSuccess(
        result.inviteLink
          ? 'Invitation refreshed. Email is not configured, so send this link yourself:'
          : 'Invitation re-sent.',
      );
      if (result.inviteLink) setShowInvite(true);
      else toast.success('Invitation re-sent.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // The actions cell reads `me` and calls resend/removeMember, so the
  // columns are built here. Rows navigate on click; the actions span
  // swallows the click so its buttons don't also open the member.
  const columns: ColumnDef<Member>[] = [
    {
      id: 'member',
      label: 'Member',
      sortValue: (m) => m.name || m.email,
      render: (m) => (
        <>
          <Link href={`/members/${m.membershipId}`} onClick={(e) => e.stopPropagation()}>
            <strong>{m.name || m.email}</strong>
          </Link>
          <div className="muted text-xs">{m.email}</div>
        </>
      ),
    },
    { id: 'role', label: 'Role', sortValue: (m) => m.roleName, render: (m) => m.roleName },
    {
      id: 'scope',
      label: 'Store access',
      sortValue: (m) =>
        m.dataScope === 'all' ? 'All locations' : `${m.scopeLocationIds.length} locations`,
      render: (m) =>
        m.dataScope === 'all' ? (
          'All locations'
        ) : m.scopeLocationIds.length > 0 ? (
          `${m.scopeLocationIds.length} location${m.scopeLocationIds.length === 1 ? '' : 's'}`
        ) : (
          <span className="text-[var(--danger)]">No store selected</span>
        ),
    },
    {
      id: 'status',
      label: 'Status',
      sortValue: (m) => m.status,
      render: (m) => <StatusBadge status={m.status} />,
    },
    {
      id: 'actions',
      label: '',
      srLabel: 'Actions',
      className: 'actions',
      fixed: true,
      render: (m) => (
        <span onClick={(e) => e.stopPropagation()}>
          {m.status === 'invited' && (
            <Button size="sm" variant="ghost" onClick={() => resend(m.membershipId)}>
              Resend invite
            </Button>
          )}
          <LinkButton size="sm" variant="secondary" href={`/members/${m.membershipId}`}>
            Manage
          </LinkButton>
          {me?.canDeleteMembers && me.membershipId !== m.membershipId && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => void removeMember(m)}
              data-testid="member-delete"
            >
              Delete
            </Button>
          )}
        </span>
      ),
    },
  ];
  const cols = useListColumns('members', columns, members);

  return (
    <div>
      <PageHeader
        title="Members"
        sub="Everyone with access to this business. Open a member to change their role, store scope, or individual permissions."
        actions={
          <Button variant="primary" onClick={() => setShowInvite((v) => !v)}>
            <UserPlus size={14} aria-hidden />
            {showInvite ? 'Close' : 'Invite member'}
          </Button>
        }
      />

      <Stack>
        {showInvite && (
          <Card title="Invite member">
            <form onSubmit={invite}>
              <FormGrid cols={3}>
                <Field label="Email" required>
                  <Input name="email" type="email" required />
                </Field>
                <Field label="Name (optional)">
                  <Input name="name" />
                </Field>
                <Field label="Role" required>
                  <Select name="roleId" required>
                    <option value="">Select role…</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.isSystem ? '' : ' (custom)'}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
              <FormActions
                start={
                  <span>
                    The invitee starts with the selected role’s access. You can fine-tune their
                    individual permissions from their member page — even before they accept.
                  </span>
                }
              >
                <Button type="submit" variant="primary" disabled={inviting}>
                  <UserPlus size={14} aria-hidden />
                  {inviting ? 'Inviting…' : 'Invite'}
                </Button>
              </FormActions>
            </form>
          </Card>
        )}

        {error && <Alert tone="error">{error}</Alert>}
        {success && (
          <Alert tone="success" data-testid="invite-success">
            {success}
          </Alert>
        )}
        {inviteLink && (
          <Alert
            tone="info"
            data-testid="invite-link"
            action={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(inviteLink)
                    .then(() => toast.success('Invite link copied.'))
                    .catch(() => toast.error('Could not copy — select the link and copy it.'));
                }}
              >
                <Copy size={14} aria-hidden />
                Copy
              </Button>
            }
          >
            <code className="break-all">{inviteLink}</code>
          </Alert>
        )}

        {!members && !error && (
          <Card>
            <LoadingRows />
          </Card>
        )}
        {members && (
          <Card flush>
            <TableWrap>
              <table className="table">
                <thead>
                  <ColumnHeadRow list={cols} testIdPrefix="members" />
                </thead>
                <tbody>
                  {members.length === 0 && (
                    <TableEmpty colSpan={cols.ordered.length}>
                      No members yet. Invite someone above.
                    </TableEmpty>
                  )}
                  {cols.sorted.map((m) => (
                    <tr
                      {...rowKeys}
                      key={m.membershipId}
                      className="cursor-pointer"
                      onClick={() => router.push(`/members/${m.membershipId}`)}
                    >
                      <ColumnCells list={cols} row={m} />
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
