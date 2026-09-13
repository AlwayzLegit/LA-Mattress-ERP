'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui';
import { useLiveChat } from './chat-provider';
import type { TeamPerson } from './use-team-chat';
import styles from './chat.module.css';
const base = '/v1/chat/conversations/team';
const headers = { 'Content-Type': 'application/json', 'x-chat-request': '1' };
type Draft = {
  body: string;
  question: boolean;
  urgent: boolean;
  mentionId: string;
  replyToId: string;
  replyPreview: string;
  retryId: string;
};
type Message = {
  id: string;
  body: string;
  sequence: number;
  senderName: string;
  senderId: string;
  mine: boolean;
  question: boolean;
  urgent: boolean;
  status: string;
  assignedId: string | null;
  assignedName: string | null;
  saved: boolean;
  version: number;
  mentionId: string | null;
  replyToId: string | null;
  createdAt: string;
};
type History = {
  data: Message[];
  hasMore: boolean;
  nextBefore?: number;
  room: { id: string; kind: string; lastSequence: number; revision: number };
  people: TeamPerson[];
  typing: string[];
  canManage: boolean;
  membershipId: string;
};
const emptyDraft = (): Draft => ({
  body: '',
  question: false,
  urgent: false,
  mentionId: '',
  replyToId: '',
  replyPreview: '',
  retryId: crypto.randomUUID(),
});

export function TeamWorkspaceButton() {
  const { team } = useLiveChat();
  const pending = team.directory?.rooms.reduce((sum, r) => sum + r.open, 0) ?? 0;
  return (
    <Button
      onClick={() => {
        const unread = team.directory?.rooms.find((room) => room.unread > 0);
        if (unread) team.setRoomId(unread.id);
        team.setOpen(true);
      }}
    >
      Team workspace{team.unread ? ` · ${team.unread} unread` : ''}
      {pending ? ` · ${pending} need help` : ''}
    </Button>
  );
}
export function TeamWorkspace() {
  const { team } = useLiveChat();
  const dialog = useRef<HTMLDialogElement>(null);
  const drafts = useRef(new Map<string, Draft>());
  useEffect(() => {
    drafts.current.clear();
  }, [team.directory?.membershipId]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (team.open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [team.open]);
  const openRoom = async (input: Record<string, string>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const room = await api<{ id: string }>(base + '/rooms', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
      team.setRoomId(room.id);
      await team.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open team conversation');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const selected = team.directory?.rooms.find((r) => r.id === team.roomId);
  return (
    <dialog
      ref={dialog}
      className={`${styles.teamDialog} ${styles.workspaceDialog}`}
      aria-labelledby="team-workspace-title"
      onCancel={() => team.setOpen(false)}
    >
      <header>
        <div>
          <h2 id="team-workspace-title">Team workspace</h2>
          <p>Ask, coordinate, and help each other · staff only</p>
        </div>
        <Button onClick={() => team.setOpen(false)}>Close workspace</Button>
      </header>
      <div className={styles.workspaceGrid}>
        <nav className={styles.teamRoomList} aria-label="Team conversations">
          <Button disabled={busy} onClick={() => void openRoom({ kind: 'helpdesk' })}>
            ＋ Team help desk
          </Button>
          <label>
            Find a teammate or store
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <h3>Conversations</h3>
          {team.directory?.rooms
            .filter((r) => r.title.toLowerCase().includes(search.toLowerCase()))
            .map((r) => (
              <button
                key={r.id}
                aria-pressed={r.id === team.roomId}
                onClick={() => team.setRoomId(r.id)}
              >
                <strong>
                  {r.kind === 'direct' ? '↗ ' : r.kind === 'store' ? '# ' : ''}
                  {r.title}
                </strong>
                <small>
                  {r.unread
                    ? `${r.unread} unread${r.mentioned ? ' · @ mention' : ''}`
                    : r.kind === 'direct'
                      ? 'Private · two people'
                      : 'Team channel'}
                  {r.open ? ` · ${r.open} need help` : ''}
                  {r.urgent ? ` · ${r.urgent} urgent` : ''}
                </small>
              </button>
            ))}
          <h3>Store channels</h3>
          {team.directory?.locations
            .filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
            .map((l) => (
              <button
                key={l.id}
                disabled={busy}
                onClick={() => void openRoom({ kind: 'store', locationId: l.id })}
              >
                # {l.name}
              </button>
            ))}
          {!team.directory?.locations.length && <p>No store channels in your access scope.</p>}
          <h3>Message a teammate</h3>
          {team.directory?.people
            .filter(
              (p) =>
                p.id !== team.directory?.membershipId &&
                p.name.toLowerCase().includes(search.toLowerCase()),
            )
            .map((p) => (
              <button
                key={p.id}
                disabled={busy}
                onClick={() => void openRoom({ kind: 'direct', memberId: p.id })}
              >
                {p.name}
                <small>{p.available ? 'Available' : 'Away · can read later'}</small>
              </button>
            ))}
          {(error || team.error) && <p role="alert">{error || team.error}</p>}
        </nav>
        {team.roomId && team.directory ? (
          <TeamRoom
            key={team.roomId}
            id={team.roomId}
            title={selected?.title ?? 'Team conversation'}
            kind={selected?.kind ?? 'unknown'}
            active={team.open}
            initialDraft={drafts.current.get(team.roomId)}
            remember={(draft) => drafts.current.set(team.roomId!, draft)}
          />
        ) : (
          <section className={styles.teamWelcome}>
            <h3>A place to get help</h3>
            <p>
              Post a question in the shared help desk, coordinate with your store, or message a
              specialist directly.
            </p>
            <p>
              Help desk questions can be marked urgent, picked up by a teammate, and resolved.
              Useful answers can be saved in their original channel.
            </p>
            <Button disabled={busy} onClick={() => void openRoom({ kind: 'helpdesk' })}>
              Open team help desk
            </Button>
          </section>
        )}
      </div>
    </dialog>
  );
}

function TeamRoom({
  id,
  title,
  kind,
  active,
  initialDraft,
  remember,
}: {
  id: string;
  title: string;
  kind: string;
  active: boolean;
  initialDraft?: Draft;
  remember: (draft: Draft) => void;
}) {
  const { team } = useLiveChat();
  const refreshDirectory = team.refresh;
  const [draft, setDraftState] = useState<Draft>(() => initialDraft ?? emptyDraft());
  const setDraft = (next: Draft) => {
    setDraftState(next);
    remember(next);
  };
  const [data, setData] = useState<History | null>(null);
  const [filter, setFilter] = useState('all');
  const [before, setBefore] = useState<number | undefined>();
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Connecting…');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const log = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef(true),
    read = useRef(0),
    typingAt = useRef(0);
  const reload = useRef<() => Promise<void>>(async () => {});
  const endpoint = base + '/rooms/' + id;
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let loading = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setConnection('Connecting…');
    bottom.current = true;
    const load = async () => {
      if (loading || abort.signal.aborted) return;
      loading = true;
      clearTimeout(timer);
      try {
        const page = await api<History>(
          endpoint + '/history?filter=' + filter + (before ? '&beforeSequence=' + before : ''),
          { cache: 'no-store', signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setData(page);
        setConnection('Connected');
      } catch (e) {
        if (abort.signal.aborted) return;
        setConnection('Reconnecting…');
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setData(null);
          setError('You no longer have access to this conversation.');
        }
      } finally {
        loading = false;
        if (!abort.signal.aborted) timer = setTimeout(load, 3000);
      }
    };
    reload.current = load;
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint, active, filter, before]);
  useEffect(() => {
    if (bottom.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    const acknowledge = () => {
      const sequence = data?.data.at(-1)?.sequence ?? 0;
      if (
        !active ||
        before ||
        filter !== 'all' ||
        !bottom.current ||
        document.hidden ||
        !document.hasFocus() ||
        sequence <= read.current
      )
        return;
      void api(endpoint + '/activity', {
        method: 'POST',
        headers,
        body: JSON.stringify({ readSequence: sequence }),
      })
        .then(() => {
          read.current = sequence;
          void refreshDirectory();
        })
        .catch(() => {});
    };
    acknowledge();
    const node = log.current;
    node?.addEventListener('scroll', acknowledge);
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => {
      node?.removeEventListener('scroll', acknowledge);
      window.removeEventListener('focus', acknowledge);
      document.removeEventListener('visibilitychange', acknowledge);
    };
  }, [data, active, before, filter, endpoint, refreshDirectory]);
  async function action(message: Message, action: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api(endpoint + '/messages/' + message.id, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, version: message.version }),
      });
      await reload.current();
      await refreshDirectory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the question');
      await reload.current();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const type = (typing: boolean) => {
    if (typing && Date.now() - typingAt.current < 3000) return;
    typingAt.current = Date.now();
    void api(endpoint + '/activity', {
      method: 'POST',
      headers,
      body: JSON.stringify({ typing }),
    }).catch(() => {});
  };
  const changeFilter = (value: string) => {
    setFilter(value);
    setBefore(undefined);
  };
  return (
    <section className={styles.teamRoom}>
      <header>
        <div>
          <h3>{title}</h3>
          <p>
            {kind === 'direct'
              ? 'Only the two participants can read this conversation.'
              : kind === 'store'
                ? 'Visible to chat staff with access to this store.'
                : kind === 'helpdesk'
                  ? 'Visible to all chat specialists across your business.'
                  : 'Internal team conversation.'}
          </p>
        </div>
        <span role="status">{connection}</span>
      </header>
      <div className={styles.teamFilters}>
        <Button aria-pressed={filter === 'all'} onClick={() => changeFilter('all')}>
          Messages
        </Button>
        {kind === 'helpdesk' && (
          <Button aria-pressed={filter === 'open'} onClick={() => changeFilter('open')}>
            Needs help
          </Button>
        )}
        <Button aria-pressed={filter === 'saved'} onClick={() => changeFilter('saved')}>
          Saved answers
        </Button>
        {before && <Button onClick={() => setBefore(undefined)}>Back to latest</Button>}
      </div>
      <div
        ref={log}
        className={styles.workspaceMessages}
        role="log"
        aria-label="Team conversation messages"
        aria-live="polite"
        data-sentry-mask
        onScroll={() => {
          const node = log.current;
          if (node) bottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {data?.hasMore && (
          <Button onClick={() => setBefore(data.nextBefore)}>Older messages</Button>
        )}
        {data && !data.data.length && (
          <p>
            {filter === 'saved'
              ? 'No saved answers yet. An author or chat manager can save a useful message here.'
              : filter === 'open'
                ? 'No questions waiting for help.'
                : 'Start the conversation. Messages here stay with the team.'}
          </p>
        )}
        {data?.data.map((message) => (
          <article
            key={message.id}
            className={styles.workspaceMessage}
            data-urgent={message.urgent && message.status !== 'resolved'}
          >
            <header>
              <strong>
                {message.senderName}
                {message.mine ? ' · You' : ''}
              </strong>
              <time>
                {new Date(message.createdAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </time>
            </header>
            {message.replyToId && (
              <blockquote>
                Replying to:{' '}
                {data.data.find((m) => m.id === message.replyToId)?.body.slice(0, 160) ??
                  'an earlier message'}
              </blockquote>
            )}
            {message.question && (
              <div className={styles.questionStatus}>
                {message.urgent && message.status !== 'resolved' ? 'Urgent · ' : ''}
                {message.status === 'open'
                  ? 'Needs help'
                  : message.status === 'claimed'
                    ? `Being helped by ${message.assignedName ?? 'a teammate'}`
                    : 'Resolved'}
              </div>
            )}
            {message.mentionId && (
              <small>
                @{data.people.find((p) => p.id === message.mentionId)?.name ?? 'Teammate'}
              </small>
            )}
            <p>{message.body}</p>
            <div className={styles.teamMessageActions}>
              <Button
                disabled={busy}
                onClick={() => {
                  setDraft({
                    ...draft,
                    question: false,
                    urgent: false,
                    replyToId: message.id,
                    replyPreview: message.body,
                    retryId: crypto.randomUUID(),
                  });
                  composer.current?.focus();
                }}
              >
                Reply
              </Button>
              {message.question && message.status === 'open' && (
                <Button disabled={busy} onClick={() => void action(message, 'claim')}>
                  I can help
                </Button>
              )}
              {message.question &&
                message.status === 'claimed' &&
                (message.assignedId === data.membershipId || data.canManage) && (
                  <Button disabled={busy} onClick={() => void action(message, 'release')}>
                    Return to team
                  </Button>
                )}
              {message.question &&
                message.status !== 'resolved' &&
                (message.mine || message.assignedId === data.membershipId || data.canManage) && (
                  <Button disabled={busy} onClick={() => void action(message, 'resolve')}>
                    Mark resolved
                  </Button>
                )}
              {message.question &&
                message.status === 'resolved' &&
                (message.mine || data.canManage) && (
                  <Button disabled={busy} onClick={() => void action(message, 'reopen')}>
                    Reopen question
                  </Button>
                )}
              {(message.mine || data.canManage) && (
                <Button
                  disabled={busy}
                  onClick={() => void action(message, message.saved ? 'unsave' : 'save')}
                >
                  {message.saved ? 'Remove saved answer' : 'Save as answer'}
                </Button>
              )}
              {message.saved && (
                <>
                  <small>Saved in this conversation</small>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const body = [draft.body, message.body].filter(Boolean).join('\n\n');
                      if (body.length > 4000) {
                        setError('Shorten your draft before adding this answer.');
                        return;
                      }
                      setDraft({ ...draft, body, retryId: crypto.randomUUID() });
                      composer.current?.focus();
                    }}
                  >
                    Use in draft
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      <p role="status">
        {data?.typing.length
          ? `${data.typing.join(', ')} typing…`
          : 'Internal conversation · never sent to customers'}
      </p>
      <form
        className={styles.teamComposer}
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current || !draft.body.trim() || !data) return;
          lock.current = true;
          setBusy(true);
          setError('');
          const input = {
            id: draft.retryId,
            body: draft.body.trim(),
            question: draft.question,
            urgent: draft.urgent,
            ...(draft.mentionId ? { mentionId: draft.mentionId } : {}),
            ...(draft.replyToId ? { replyToId: draft.replyToId } : {}),
          };
          try {
            await api(endpoint + '/messages', {
              method: 'POST',
              headers,
              body: JSON.stringify(input),
            });
            setDraft(emptyDraft());
            bottom.current = true;
            if (before || filter !== 'all') {
              setBefore(undefined);
              setFilter('all');
            } else await reload.current();
            await refreshDirectory();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Message not confirmed. Retry to confirm.');
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {draft.replyToId && (
          <div className={styles.replyTarget}>
            Replying to: {draft.replyPreview.slice(0, 160)}{' '}
            <Button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  replyToId: '',
                  replyPreview: '',
                  retryId: crypto.randomUUID(),
                })
              }
            >
              Cancel reply
            </Button>
          </div>
        )}
        {kind === 'helpdesk' && !draft.replyToId && (
          <div className={styles.teamMessageActions}>
            <label className={styles.mentionChoice}>
              <input
                type="checkbox"
                checked={draft.question}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    question: e.target.checked,
                    urgent: e.target.checked && draft.urgent,
                    retryId: crypto.randomUUID(),
                  })
                }
              />
              Ask the team for help
            </label>
            {draft.question && (
              <label className={styles.mentionChoice}>
                <input
                  type="checkbox"
                  checked={draft.urgent}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft({ ...draft, urgent: e.target.checked, retryId: crypto.randomUUID() })
                  }
                />
                Urgent
              </label>
            )}
          </div>
        )}
        <label>
          {draft.question ? 'What do you need help with?' : 'Message your team'}
          <textarea
            ref={composer}
            rows={3}
            maxLength={4000}
            value={draft.body}
            disabled={busy || !data}
            data-sentry-mask
            onChange={(e) => {
              setDraft({ ...draft, body: e.target.value, retryId: crypto.randomUUID() });
              type(Boolean(e.target.value));
            }}
            onBlur={() => type(false)}
          />
        </label>
        <div className={styles.teamComposeFooter}>
          <label>
            Mention a teammate
            <select
              disabled={busy || !data}
              value={draft.mentionId}
              onChange={(e) =>
                setDraft({ ...draft, mentionId: e.target.value, retryId: crypto.randomUUID() })
              }
            >
              <option value="">No mention</option>
              {data?.people
                .filter((p) => p.id !== data.membershipId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    @{p.name}
                  </option>
                ))}
            </select>
          </label>
          <Button type="submit" disabled={busy || !data || !draft.body.trim()}>
            {busy ? 'Sending…' : draft.question ? 'Post help request' : 'Send team message'}
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
