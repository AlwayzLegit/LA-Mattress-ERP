'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderTeamMember } from '@jetnine/shared';
import { toast } from 'sonner';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  FormActions,
  LoadingRows,
  Stack,
  formatKeys,
  usePlatform,
} from '@/components/ui';
import { api } from '@/lib/api';

interface OrderNote {
  id: string;
  body: string;
  createdAt: string;
  authorName: string | null;
  authorEmail: string | null;
  mine: boolean;
  mentionedMembershipIds: string[];
}

/**
 * The order's running conversation (owner ask 2026-09-01): anyone who can
 * see the order can leave a note; each one keeps who wrote it and when.
 * Append-only by design — what was said stays said.
 */
export function OrderNotesCard({ orderId }: { orderId: string }) {
  const platform = usePlatform();
  const [notes, setNotes] = useState<OrderNote[] | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [team, setTeam] = useState<OrderTeamMember[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const requestId = useRef(0);
  const invalidate = useCallback(() => {
    requestId.current++;
  }, []);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    try {
      const rows = await api<OrderNote[]>(`/v1/orders/${orderId}/notes`);
      if (requestId.current === current) {
        setNotes(rows);
        setError('');
      }
    } catch (e) {
      if (requestId.current === current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [orderId]);

  useEffect(() => {
    setNotes(null);
    setRecipients([]);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => {
      clearInterval(timer);
      invalidate();
    };
  }, [load, invalidate]);

  useEffect(() => {
    const abort = new AbortController();
    setTeam([]);
    void api<OrderTeamMember[]>(`/v1/orders/${orderId}/team`, { signal: abort.signal })
      .then(setTeam)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [orderId]);

  async function save() {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    requestId.current++;
    try {
      const note = await api<OrderNote>(`/v1/orders/${orderId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body, mentionedMembershipIds: recipients }),
      });
      setNotes((prev) => [note, ...(prev ?? [])]);
      setDraft('');
      setRecipients([]);
      window.dispatchEvent(new Event('erp:team-update'));
      toast.success('Note saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="order-notes" title="Notes" data-testid="order-notes-card">
      <Stack>
        {error && (
          <Alert
            tone="error"
            action={
              <Button size="sm" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="New note">
            <textarea
              className="textarea"
              aria-label="New note"
              data-testid="order-note-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save();
              }}
              placeholder="Leave a note for whoever picks this order up next…"
              rows={3}
              maxLength={4000}
            />
          </Field>
          {team.length > 0 && (
            <fieldset className="my-3">
              <legend className="mb-2 text-xs font-semibold">Notify members</legend>
              <div className="flex flex-wrap gap-2">
                {team.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={recipients.includes(m.id)}
                      onChange={(e) =>
                        setRecipients((prev) =>
                          e.target.checked ? [...prev, m.id] : prev.filter((id) => id !== m.id),
                        )
                      }
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              <p className="muted mt-1 text-xs">
                Selected members and open-task owners receive this note in their inbox.
              </p>
            </fieldset>
          )}
          <FormActions
            start={
              <span>
                Saved with your name and the time. {formatKeys('mod+enter', platform)} to save.
              </span>
            }
          >
            <Button
              type="submit"
              variant="primary"
              disabled={!draft.trim() || saving}
              data-testid="order-note-save"
            >
              {saving ? 'Saving…' : 'Add note'}
            </Button>
          </FormActions>
        </form>

        {notes == null ? (
          <LoadingRows rows={2} />
        ) : notes.length === 0 ? (
          <div data-testid="order-notes-empty">
            <EmptyState>No notes yet.</EmptyState>
          </div>
        ) : (
          <ul className="divide-border divide-y" data-testid="order-notes-list">
            {notes.map((n) => (
              <li key={n.id} className="py-2">
                <div className="flex flex-wrap gap-2 text-xs">
                  <strong>{n.mine ? 'You' : (n.authorName ?? n.authorEmail ?? 'Unknown')}</strong>
                  <span className="muted">{new Date(n.createdAt).toLocaleString()}</span>
                </div>
                <div className="mt-0.5 whitespace-pre-wrap">{n.body}</div>
                {n.mentionedMembershipIds?.length > 0 && (
                  <p className="muted mt-1 text-xs">
                    Notified:{' '}
                    {n.mentionedMembershipIds
                      .map((id) => team.find((m) => m.id === id)?.name ?? 'Member')
                      .join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Stack>
    </Card>
  );
}
