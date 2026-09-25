'use client';

import Link from 'next/link';
import { toast } from 'sonner';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { Permission } from '@jetnine/shared';
import {
  Alert,
  BackLink,
  Button,
  Card,
  Field,
  FormGrid,
  Input,
  LoadingRows,
  PageHeader,
  SectionHeading,
  Select,
  Stack,
  StatusBadge,
} from '@/components/ui';
import { NAV } from '@/components/app-shell';
import { PermissionGroupsEditor } from '@/components/permission-groups';
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
  sellingScope: 'all' | 'approved';
  managerDashboard: boolean;
  monthlyGoalCents: number | null;
  scopeLocationIds: string[];
  hiddenNav: string[];
  invitedAt: string | null;
  acceptedAt: string | null;
}

interface Role {
  id: string;
  name: string;
  isSystem: boolean;
}

interface LocationRow {
  id: string;
  name: string;
}

interface MemberAccess {
  membershipId: string;
  roleId: string;
  roleName: string;
  rolePermissions: Permission[];
  overrides: { permission: Permission; allowed: boolean }[];
  effective: Permission[];
}

/**
 * One member, everything about their access: profile, role + status,
 * sales-data scope, and the per-permission editor. The permission
 * checkboxes show the member's EFFECTIVE access; ticking something the
 * role doesn't grant (or unticking something it does) stages an
 * override, saved as a diff against the role so a later role change
 * re-inherits cleanly. Works for invited members too — access applies
 * the moment they accept.
 */
export default function MemberDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const router = useRouter();

  const [member, setMember] = useState<Member | null>(null);
  /** Draft for the display-name edit; null = not editing. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [access, setAccess] = useState<MemberAccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Staged (unsaved) effective permission set for the access editor.
  const [staged, setStaged] = useState<Set<string> | null>(null);
  const [savingAccess, setSavingAccess] = useState(false);

  const load = useCallback(async () => {
    try {
      const [membersList, rolesList, locs, acc] = await Promise.all([
        api<Member[]>('/v1/business/members'),
        api<Role[]>('/v1/business/roles'),
        api<LocationRow[]>('/v1/business/locations'),
        api<MemberAccess>(`/v1/business/members/${id}/permissions`),
      ]);
      const m = membersList.find((x) => x.membershipId === id);
      if (!m) {
        setError('Member not found');
        return;
      }
      setMember(m);
      setRoles(rolesList);
      setLocations(locs);
      setAccess(acc);
      setStaged(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  const roleSet = useMemo(() => new Set<string>(access?.rolePermissions ?? []), [access]);
  const effectiveSet = useMemo(() => new Set<string>(access?.effective ?? []), [access]);
  const value = staged ?? effectiveSet;
  const dirty = staged !== null && !setsEqual(staged, effectiveSet);
  const overrideCount = useMemo(
    () =>
      [...value].filter((p) => !roleSet.has(p)).length +
      [...roleSet].filter((p) => !value.has(p)).length,
    [value, roleSet],
  );

  // Owner 2026-09-02: Delete shows only to who holds users.delete, never on self.
  const [canDelete, setCanDelete] = useState(false);
  useEffect(() => {
    void api<{ membershipId: string | null; canDeleteMembers: boolean }>('/v1/business/members/me')
      .then((r) => setCanDelete(r.canDeleteMembers && r.membershipId !== id))
      .catch(() => setCanDelete(false));
  }, [id]);

  async function removeMember() {
    try {
      const r = await api<{ mode: 'deleted' | 'archived' }>(`/v1/business/members/${id}`, {
        method: 'DELETE',
      });
      toast.success(r.mode === 'deleted' ? 'Member deleted.' : 'Member removed — history kept.');
      router.push('/members');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function patchMember(body: Record<string, unknown>, okMessage: string) {
    try {
      await api(`/v1/business/members/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast.success(okMessage);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveAccess() {
    if (!staged) return;
    setSavingAccess(true);
    try {
      const overrides = [
        ...[...staged]
          .filter((p) => !roleSet.has(p))
          .map((p) => ({ permission: p, allowed: true })),
        ...[...roleSet]
          .filter((p) => !staged.has(p))
          .map((p) => ({ permission: p, allowed: false })),
      ];
      await api(`/v1/business/members/${id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ overrides }),
      });
      toast.success('Access saved.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAccess(false);
    }
  }

  async function resetToRole() {
    setSavingAccess(true);
    try {
      await api(`/v1/business/members/${id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ overrides: [] }),
      });
      toast.success('Overrides cleared — back to role defaults.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAccess(false);
    }
  }

  async function resend() {
    try {
      const result = await api<{ inviteLink?: string }>(
        `/v1/business/members/${id}/resend-invite`,
        { method: 'POST' },
      );
      if (result.inviteLink) {
        await navigator.clipboard?.writeText(result.inviteLink).catch(() => undefined);
        toast.success('Invitation refreshed — link copied to clipboard.');
      } else {
        toast.success('Invitation re-sent.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) {
    return (
      <div>
        <PageHeader
          eyebrow={<BackLink href="/members">Members</BackLink>}
          title={error === 'Member not found' ? 'Member not found' : 'Member'}
        />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!member || !access) return <LoadingRows rows={6} />;

  const needsStorePick = member.sellingScope === 'approved' || member.dataScope === 'store';

  return (
    <div>
      <PageHeader
        eyebrow={<BackLink href="/members">Members</BackLink>}
        title={member.name || member.email}
        meta={<StatusBadge status={member.status} />}
        sub={
          <>
            {member.email}
            {member.invitedAt && ` · invited ${formatDate(member.invitedAt)}`}
            {member.acceptedAt && ` · joined ${formatDate(member.acceptedAt)}`}
            {!member.emailVerified && ' · email unverified'}
          </>
        }
        actions={
          <>
            {member.status === 'invited' && (
              <Button size="sm" variant="secondary" onClick={() => void resend()}>
                Resend invite
              </Button>
            )}
            {canDelete && (
              <Button
                size="sm"
                variant="danger"
                data-testid="member-delete"
                onClick={() => {
                  if (
                    confirm(
                      `Delete ${member.name || member.email} from this business? They lose access now. Anything they wrote stays on record under their name.`,
                    )
                  ) {
                    void removeMember();
                  }
                }}
              >
                Delete
              </Button>
            )}
            {member.status !== 'disabled' ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (confirm('Disable this member? They lose access immediately.')) {
                    void patchMember({ status: 'disabled' }, 'Member disabled.');
                  }
                }}
              >
                Disable
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void patchMember({ status: 'active' }, 'Member reactivated.')}
              >
                Reactivate
              </Button>
            )}
          </>
        }
      />

      <Stack>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Role">
            <Field
              label="Display name"
              hint="How receipts, dashboards, and pickup stamps label this person."
            >
              <div className="flex gap-2">
                <Input
                  value={nameDraft ?? member.name ?? ''}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder={member.email}
                  maxLength={120}
                  data-testid="member-display-name"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    nameDraft === null ||
                    !nameDraft.trim() ||
                    nameDraft.trim() === (member.name ?? '')
                  }
                  onClick={async () => {
                    await patchMember({ displayName: nameDraft!.trim() }, 'Name updated.');
                    setNameDraft(null);
                  }}
                  data-testid="member-display-name-save"
                >
                  Save
                </Button>
              </div>
            </Field>
            <Field
              label="Assigned role"
              hint={
                <>
                  The role sets this member’s default access. Changing it keeps any individual
                  overrides below, re-applied on top of the new role.{' '}
                  <Link href={`/roles/${member.roleId}`}>View role →</Link>
                </>
              }
            >
              <Select
                value={member.roleId}
                onChange={(e) => void patchMember({ roleId: e.target.value }, 'Role updated.')}
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.isSystem ? '' : ' (custom)'}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>

          <Card title="Store access">
            <FormGrid cols={1}>
              <label
                data-testid={`manager-dashboard-${member.membershipId}`}
                className="flex cursor-pointer items-start gap-2 text-[13px]"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--brand)]"
                  checked={member.managerDashboard}
                  onChange={(e) =>
                    void patchMember(
                      { managerDashboard: e.target.checked },
                      e.target.checked
                        ? 'Manager dashboard enabled.'
                        : 'Manager dashboard turned off.',
                    )
                  }
                />
                <span>
                  <strong>Store manager dashboard</strong>
                  <span className="field-hint">
                    Their home page becomes the store view: store sales today, the associate board,
                    open-sales queues, and today&apos;s deliveries — scoped to a store they pick
                    from their approved list.
                  </span>
                </span>
              </label>
              <Field
                label="Monthly sales goal"
                hint="Written dollars; drives their dashboard pace bar. Leave blank for no goal."
              >
                <Input
                  type="number"
                  min={0}
                  step={100}
                  placeholder="e.g. 60000"
                  defaultValue={
                    member.monthlyGoalCents != null ? String(member.monthlyGoalCents / 100) : ''
                  }
                  data-testid={`monthly-goal-${member.membershipId}`}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const cents = raw === '' ? null : Math.round(Number(raw) * 100);
                    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return;
                    if (cents === member.monthlyGoalCents) return;
                    void patchMember(
                      { monthlyGoalCents: cents },
                      cents === null ? 'Goal cleared.' : 'Monthly goal saved.',
                    );
                  }}
                />
              </Field>
              <Field label="Where can they sell?">
                <Select
                  value={member.sellingScope}
                  data-testid={`selling-scope-${member.membershipId}`}
                  onChange={(e) =>
                    void patchMember({ sellingScope: e.target.value }, 'Selling access updated.')
                  }
                >
                  <option value="all">Any store</option>
                  <option value="approved">Approved stores only (picked at login)</option>
                </Select>
              </Field>
              <Field label="Whose sales data can they see?">
                <Select
                  value={member.dataScope}
                  data-testid={`data-scope-${member.membershipId}`}
                  onChange={(e) =>
                    void patchMember({ dataScope: e.target.value }, 'Sales data scope updated.')
                  }
                >
                  <option value="all">All stores</option>
                  <option value="store">Approved stores only</option>
                </Select>
              </Field>
              {needsStorePick && (
                <div>
                  <SectionHeading as="h3" title="Approved stores" />
                  <Stack gap="sm">
                    <div className="grid gap-1">
                      {locations.map((loc) => (
                        <label
                          key={loc.id}
                          className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)]"
                        >
                          <input
                            type="checkbox"
                            className="accent-[var(--brand)]"
                            checked={member.scopeLocationIds.includes(loc.id)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...member.scopeLocationIds, loc.id]
                                : member.scopeLocationIds.filter((x) => x !== loc.id);
                              void patchMember({ scopeLocationIds: next }, 'Store scope updated.');
                            }}
                          />
                          {loc.name}
                        </label>
                      ))}
                      {locations.length === 0 && (
                        <span className="field-hint">
                          No locations yet — add one under Locations first.
                        </span>
                      )}
                    </div>
                    {member.scopeLocationIds.length === 0 && (
                      <Alert tone="warning">
                        No store approved —{' '}
                        {member.sellingScope === 'approved'
                          ? 'this member cannot sell anywhere'
                          : ''}
                        {member.sellingScope === 'approved' && member.dataScope === 'store'
                          ? ' and '
                          : ''}
                        {member.dataScope === 'store' ? 'they see no sales data' : ''}.
                      </Alert>
                    )}
                    <span className="field-hint">
                      With approved-only selling, the member picks one of these stores at login and
                      everything they ring — including the money tendered — counts toward that
                      store.
                    </span>
                  </Stack>
                </div>
              )}
            </FormGrid>
          </Card>
        </div>

        <Card
          title="Navigation"
          description={
            <>
              Untick a tab to remove it from this member&apos;s sidebar entirely. This is visibility
              only — what they can actually do is still governed by their permissions below.
            </>
          }
          actions={
            member.hiddenNav.length > 0 ? (
              <>
                <span className="muted">
                  {member.hiddenNav.length} tab{member.hiddenNav.length === 1 ? '' : 's'} hidden.
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void patchMember({ hiddenNav: [] }, 'All tabs restored.')}
                >
                  Show all
                </Button>
              </>
            ) : undefined
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {NAV.map((group) => (
              <div key={group.label}>
                <SectionHeading as="h3" title={group.label} />
                <div className="grid gap-1">
                  {group.items.map((item) => {
                    const hidden = member.hiddenNav.includes(item.href);
                    return (
                      <label
                        key={item.href}
                        className={`flex cursor-pointer items-center gap-2 text-[13px] ${
                          hidden ? 'muted' : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-[var(--brand)]"
                          checked={!hidden}
                          data-testid={`nav-visible-${item.href.replace(/\//g, '_')}`}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? member.hiddenNav.filter((h) => h !== item.href)
                              : [...member.hiddenNav, item.href];
                            void patchMember({ hiddenNav: next }, 'Navigation updated.');
                          }}
                        />
                        {item.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title={
            <>
              Permissions
              {overrideCount > 0 && (
                <span className="badge badge-warning ml-2">
                  {overrideCount} override{overrideCount === 1 ? '' : 's'}
                </span>
              )}
            </>
          }
          description={
            <>
              Checked = what {member.name || member.email} can do, starting from the{' '}
              <strong>{access.roleName}</strong> role. Tick or untick anything to override just for
              this member
              {member.status === 'invited' ? ' — it applies as soon as they accept the invite' : ''}
              .
            </>
          }
          actions={
            <>
              {access.overrides.length > 0 && !dirty && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void resetToRole()}
                  disabled={savingAccess}
                >
                  Reset to role defaults
                </Button>
              )}
              {dirty && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setStaged(null)}
                    disabled={savingAccess}
                  >
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void saveAccess()}
                    disabled={savingAccess}
                  >
                    {savingAccess ? 'Saving…' : 'Save access'}
                  </Button>
                </>
              )}
            </>
          }
        >
          <PermissionGroupsEditor
            value={value}
            onChange={(next) => setStaged(next)}
            baseline={roleSet}
          />
        </Card>
      </Stack>
    </div>
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
