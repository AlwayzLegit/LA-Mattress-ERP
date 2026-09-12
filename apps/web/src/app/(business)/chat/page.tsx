'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { Form, FormRootError, useZodForm } from '@/components/form/form';
import { Button, PageHeader } from '@/components/ui';
import styles from './chat.module.css';
import { AdminControls } from './admin-controls';
import { ContextPanel } from './context-panel';
import { TeamControls } from './team-controls';
import { PushControls } from './push-controls';
import { useLiveChat } from './use-live-chat';
import type { LiveConversation } from './live-state';

type Message = {
  id: string;
  body: string;
  sender: string;
  audience: string;
  sequence: number;
  createdAt: string;
};
const formSchema = z.object({
  body: z.string().trim().min(1, 'Write a message.').max(4000, 'Use 4,000 characters or fewer.'),
});
export default function ChatPage() {
  const [queue, setQueue] = useState('active');
  const {
    conversations,
    connection,
    unread,
    selected,
    select,
    sound,
    toggleSound,
    notifications,
    toggleNotifications,
    notice,
    latest,
  } = useLiveChat();
  const visible = conversations.filter((row) => {
    if (queue === 'overdue') return row.overdue;
    if (queue === 'followup') return row.followupPending;
    if (queue === 'all') return true;
    if (queue === 'mine') return row.assignedToMe && !['resolved', 'spam'].includes(row.status);
    if (queue === 'unassigned')
      return !row.assignedMembershipId && !['resolved', 'spam'].includes(row.status);
    if (queue === 'unread') return unread.includes(row.id);
    if (queue === 'waiting_team') return ['queued', 'open'].includes(row.status);
    if (queue === 'active') return !['resolved', 'spam'].includes(row.status);
    return row.status === queue;
  });
  return (
    <div className={styles.root} data-sentry-mask>
      <PageHeader
        title="Live chat"
        sub="Talk with website visitors and keep the conversation together."
      />
      <div className={styles.livebar}>
        <div className={styles.connection} data-state={connection} role="status">
          <span className={styles.dot} />
          <strong>
            {connection === 'live'
              ? 'Live'
              : connection === 'connecting'
                ? 'Connecting...'
                : connection === 'denied'
                  ? 'Access required'
                  : 'Reconnecting...'}
          </strong>
          <span>
            {connection === 'live'
              ? 'Messages update automatically'
              : 'Waiting for a secure connection'}
          </span>
        </div>
        <div className={styles.modes}>
          <Button aria-pressed={sound} onClick={() => void toggleSound()}>
            {sound ? 'Sound on' : 'Enable sound'}
          </Button>
          <Button aria-pressed={notifications} onClick={() => void toggleNotifications()}>
            {notifications ? 'Desktop alerts on' : 'Enable desktop alerts'}
          </Button>
        </div>
      </div>
      <div className={styles.toolbar}>
        <span role="status">{notice}</span>
        <strong>
          {unread.length
            ? `${unread.length} unread conversation${unread.length === 1 ? '' : 's'}`
            : connection === 'live'
              ? 'Inbox up to date'
              : 'Connecting to inbox'}
        </strong>
      </div>
      {connection === 'reconnecting' && (
        <p role="alert" className={styles.error}>
          Connection interrupted. Reconnecting automatically; messages will catch up when the
          connection returns.
        </p>
      )}
      <p className={styles.arrival} role="status">
        {latest || 'Ready to help your next visitor.'}
      </p>
      <TeamControls />
      <AdminControls />
      <details className={styles.preferences}>
        <summary>Background notifications</summary>
        <PushControls />
      </details>
      <div className={styles.layout}>
        <aside className={styles.queue} aria-label="Conversation queue">
          <h2>Team conversations</h2>
          <label htmlFor="chat-queue">Show queue</label>
          <select
            id="chat-queue"
            className="input"
            value={queue}
            onChange={(event) => setQueue(event.target.value)}
          >
            <option value="active">Active</option>
            <option value="overdue">Overdue</option>
            <option value="followup">Follow-up requested</option>
            <option value="mine">Mine</option>
            <option value="unassigned">Unassigned</option>
            <option value="unread">Unread</option>
            <option value="waiting_team">Waiting on team</option>
            <option value="waiting_customer">Waiting on customer</option>
            <option value="snoozed">Snoozed</option>
            <option value="resolved">Resolved</option>
            <option value="spam">Spam</option>
            <option value="all">All conversations</option>
          </select>
          {conversations.length > 0 && visible.length === 0 && (
            <p>No conversations in this queue.</p>
          )}
          {connection === 'connecting' && <p>Loading conversations...</p>}
          {connection === 'live' && !conversations.length && <p>No conversations yet.</p>}
          {visible.map((conversation) => (
            <button
              className={styles.item}
              key={conversation.id}
              aria-pressed={selected === conversation.id}
              onClick={() => select(conversation.id)}
              data-unread={unread.includes(conversation.id)}
            >
              <strong>Visitor · {conversation.id.slice(0, 8)}</strong>
              {unread.includes(conversation.id) && (
                <span className={styles.badge}>New message</span>
              )}
              <small>
                {conversation.assignedToMe
                  ? 'Assigned to you'
                  : conversation.assignedMembershipId
                    ? 'Assigned to teammate'
                    : 'Unassigned'}
              </small>
              {conversation.overdue && <span className={styles.badge}>Reply overdue</span>}
              {conversation.followupPending && (
                <span className={styles.badge}>Follow-up requested</span>
              )}
              <span>{conversation.status.replaceAll('_', ' ')}</span>
              <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </aside>
        {selected ? (
          <ConversationPanel
            key={selected}
            id={selected}
            conversation={conversations.find((row) => row.id === selected)}
            revision={conversations.find((row) => row.id === selected)?.lastSequence ?? 0}
          />
        ) : (
          <section className={styles.empty}>
            <h2>Your next conversation starts here</h2>
            <p>Select a visitor to read their messages and reply.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function ConversationPanel({
  id,
  revision,
  conversation,
}: {
  id: string;
  revision: number;
  conversation?: LiveConversation;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [note, setNote] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const lastTyping = useRef(0);
  const lastRead = useRef(0);
  const draftReady = useRef(false);
  const history = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [below, setBelow] = useState(false);
  const sequence = useRef(0);
  const retry = useRef<{ body: string; note: boolean; id: string } | null>(null);
  const form = useZodForm(formSchema, { body: '' });
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`staff-chat-draft:${id}`) || '{}');
      if (typeof saved.body === 'string') form.reset({ body: saved.body });
      if (typeof saved.note === 'boolean') setNote(saved.note);
      if (saved.retry) retry.current = saved.retry;
    } catch {
      /* Storage may be unavailable. */
    }
    draftReady.current = true;
  }, [id, form]);
  useEffect(() => {
    const subscription = form.watch((value) => {
      if (!draftReady.current) return;
      try {
        sessionStorage.setItem(
          `staff-chat-draft:${id}`,
          JSON.stringify({ body: value.body, note, retry: retry.current }),
        );
      } catch {}
    });
    return () => subscription.unsubscribe();
  }, [id, form, note]);
  useEffect(() => {
    const acknowledge = () => {
      const readSequence = messages.at(-1)?.sequence ?? 0;
      if (
        document.hidden ||
        !document.hasFocus() ||
        !followLatest.current ||
        readSequence <= lastRead.current
      )
        return;
      void api(`/v1/chat/conversations/${id}/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
        body: JSON.stringify({ readSequence }),
      })
        .then(() => {
          lastRead.current = readSequence;
        })
        .catch(() => {});
    };
    acknowledge();
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => {
      window.removeEventListener('focus', acknowledge);
      document.removeEventListener('visibilitychange', acknowledge);
    };
  }, [id, messages]);
  async function workflow(action: string) {
    if (!conversation?.version) return;
    setWorkflowBusy(true);
    try {
      await api(`/v1/chat/conversations/${id}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
        body: JSON.stringify({
          action,
          version: conversation.version,
          ...(action === 'snooze'
            ? { snoozedUntil: new Date(Date.now() + 30 * 60000).toISOString() }
            : {}),
        }),
      });
      setStatus('Conversation updated.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update conversation');
    } finally {
      setWorkflowBusy(false);
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    let fetching = false;
    let queued = false;
    async function load() {
      if (abort.signal.aborted) return;
      if (fetching) {
        queued = true;
        return;
      }
      queued = false;
      fetching = true;
      try {
        let hasMore = true;
        while (hasMore && !abort.signal.aborted) {
          const result = await api<{ data: Message[]; hasMore: boolean; nextSequence: number }>(
            `/v1/chat/conversations/${id}/history?afterSequence=${sequence.current}&limit=100`,
            { signal: abort.signal, cache: 'no-store' },
          );
          if (abort.signal.aborted) return;
          setMessages((old) => {
            const added = result.data.filter((row) => !old.some((item) => item.id === row.id));
            return added.length ? [...old, ...added] : old;
          });
          sequence.current = result.nextSequence;
          hasMore = result.hasMore;
        }
        setError('');
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Unable to refresh messages');
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
            setMessages([]);
            sequence.current = 0;
          }
        }
      } finally {
        fetching = false;
        if (queued && !abort.signal.aborted) void load();
      }
    }
    refresh.current = load;
    void load();
    const retryTimer = setInterval(() => void load(), 15000);
    return () => {
      abort.abort();
      clearInterval(retryTimer);
    };
  }, [id]);
  useEffect(() => {
    void refresh.current();
  }, [revision]);
  useEffect(() => {
    if (followLatest.current) history.current?.scrollTo({ top: history.current.scrollHeight });
    else setBelow(true);
  }, [messages]);
  return (
    <div className={styles.conversationWithContext}>
      <section className={styles.conversation} aria-label="Selected conversation">
        <header className={styles.heading}>
          <div>
            <h2>Visitor conversation</h2>
            <small>{id.slice(0, 8)}</small>
          </div>
          <Button onClick={() => void refresh.current()}>Refresh messages</Button>
        </header>
        <div className={styles.workflow}>
          {conversation?.assignedToMe && !conversation.acceptedAt && (
            <Button
              disabled={workflowBusy}
              onClick={async () => {
                try {
                  await api(`/v1/chat/conversations/${id}/accept`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                    body: '{}',
                  });
                  setStatus('Assignment accepted.');
                } catch {
                  setStatus('Could not accept assignment. Refresh and retry.');
                }
              }}
            >
              Accept assignment
            </Button>
          )}
          <Button
            disabled={workflowBusy}
            onClick={() => void workflow(conversation?.assignedToMe ? 'release' : 'claim')}
          >
            {conversation?.assignedToMe ? 'Release chat' : 'Claim chat'}
          </Button>
          <Button
            disabled={workflowBusy}
            onClick={() =>
              void workflow(
                conversation?.status === 'resolved' || conversation?.status === 'spam'
                  ? 'reopen'
                  : 'resolve',
              )
            }
          >
            {conversation?.status === 'resolved' || conversation?.status === 'spam'
              ? 'Reopen'
              : 'Resolve'}
          </Button>
          <Button disabled={workflowBusy} onClick={() => void workflow('snooze')}>
            Snooze 30 min
          </Button>
          <Button disabled={workflowBusy} onClick={() => void workflow('spam')}>
            Mark spam
          </Button>
          <Button
            onClick={async () => {
              try {
                const data = await api(`/v1/chat/conversations/${id}/export`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                  body: '{}',
                });
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = `chat-${id}.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Export unavailable');
              }
            }}
          >
            Export public transcript
          </Button>
        </div>
        {conversation?.visitorTyping && (
          <p role="status" className={styles.arrival}>
            Visitor is typing...
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div
          ref={history}
          onScroll={() => {
            const node = history.current;
            if (node) {
              followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
              if (followLatest.current) setBelow(false);
            }
          }}
          className={styles.history}
          role="log"
          aria-label="Messages"
          aria-live="polite"
          data-sentry-mask
        >
          {messages.map((message) => (
            <article
              key={message.id}
              className={`${styles.message} ${message.audience === 'internal' ? styles.note : message.sender === 'staff' ? styles.reply : ''}`}
            >
              <div>
                <strong>
                  {message.audience === 'internal'
                    ? 'Private note · team only'
                    : message.sender === 'visitor'
                      ? 'Visitor'
                      : 'Team'}
                </strong>
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              <p>{message.body}</p>
              {message.sender === 'staff' && message.audience === 'public' && (
                <small className={styles.saved}>
                  {(conversation?.visitorReadSequence ?? 0) >= message.sequence
                    ? 'Seen by visitor'
                    : 'Saved'}
                </small>
              )}
            </article>
          ))}
        </div>
        {below && (
          <Button
            onClick={() => {
              followLatest.current = true;
              setBelow(false);
              history.current?.scrollTo({ top: history.current.scrollHeight, behavior: 'smooth' });
            }}
          >
            Jump to new messages
          </Button>
        )}
        <FollowupPanel id={id} version={conversation?.version} />
        <div className={styles.composer}>
          <div className={styles.modes}>
            <Button
              aria-pressed={!note}
              onClick={() => setNote(false)}
              disabled={form.formState.isSubmitting}
            >
              Public reply
            </Button>
            <Button
              aria-pressed={note}
              onClick={() => setNote(true)}
              disabled={form.formState.isSubmitting}
            >
              Private note
            </Button>
          </div>
          {!note && (
            <label className={styles.quickReply}>
              Quick reply
              <select
                className="input"
                value=""
                disabled={form.formState.isSubmitting}
                onChange={(event) => {
                  if (event.target.value)
                    form.setValue('body', event.target.value, { shouldDirty: true });
                }}
              >
                <option value="">Choose a reply to edit...</option>
                <option value="Hi! Thanks for reaching out to LA Mattress. How can I help?">
                  Welcome
                </option>
                <option value="What mattress size and comfort level are you looking for?">
                  Mattress preferences
                </option>
                <option value="Which showroom would you like to visit, and what day works for you?">
                  Showroom visit
                </option>
                <option value="Thank you for your patience. I am checking that for you.">
                  Checking details
                </option>
              </select>
            </label>
          )}
          <Form
            form={form}
            onSubmit={async ({ body }) => {
              setStatus('Saving…');
              if (!retry.current || retry.current.body !== body || retry.current.note !== note)
                retry.current = { body, note, id: crypto.randomUUID() };
              try {
                sessionStorage.setItem(
                  `staff-chat-draft:${id}`,
                  JSON.stringify({ body, note, retry: retry.current }),
                );
              } catch {}
              try {
                await api(`/v1/chat/conversations/${id}/${note ? 'notes' : 'messages'}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                  body: JSON.stringify({ body, clientMessageId: retry.current.id }),
                });
                retry.current = null;
                form.reset({ body: '' });
                setStatus(note ? 'Private note saved.' : 'Reply saved.');
                await refresh.current();
              } catch (e) {
                setStatus(
                  'Not confirmed. Your draft is still here; retry to confirm it was saved.',
                );
                throw e;
              }
            }}
          >
            <label htmlFor="chat-message">
              {note ? 'Private note — only your team can read this' : 'Reply to the visitor'}
            </label>
            <textarea
              id="chat-message"
              className="input"
              rows={3}
              maxLength={4000}
              {...form.register('body', {
                onChange: () => {
                  if (note || Date.now() - lastTyping.current < 3000) return;
                  lastTyping.current = Date.now();
                  void api(`/v1/chat/conversations/${id}/activity`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                    body: JSON.stringify({ typing: true }),
                  }).catch(() => {});
                },
              })}
              disabled={form.formState.isSubmitting}
              data-sentry-mask
              aria-invalid={Boolean(form.formState.errors.body)}
            />
            {form.formState.errors.body && <p role="alert">{form.formState.errors.body.message}</p>}
            <FormRootError />
            <div className={styles.toolbar}>
              <span role="status">{status}</span>
              <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? 'Saving…'
                  : note
                    ? 'Save private note'
                    : 'Send reply'}
              </Button>
            </div>
          </Form>
        </div>
      </section>
      <ContextPanel
        id={id}
        version={conversation?.version}
        onTemplate={(body) => {
          setNote(false);
          form.setValue('body', body, { shouldDirty: true });
        }}
      />
    </div>
  );
}

function FollowupPanel({ id, version }: { id: string; version?: number }) {
  const [details, setDetails] = useState<{
    name: string | null;
    contact: string | null;
    method: string | null;
    requestedAt: string | null;
    completedAt: string | null;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api<typeof details>(`/v1/chat/conversations/${id}/followup`)
      .then((data) => {
        if (!cancelled) setDetails(data);
      })
      .catch(() => {
        if (!cancelled) setError('Contact details could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, version]);
  if (!details?.requestedAt && !error) return null;
  return (
    <details className={styles.preferences}>
      <summary>Follow-up {details?.completedAt ? 'completed' : 'requested'}</summary>
      {error && <p role="alert">{error}</p>}
      {details?.requestedAt && (
        <>
          <p>
            {details.name} · {details.method}: {details.contact}
          </p>
          <p>Visitor-provided contact details. Identity is unverified.</p>
          {!details.completedAt && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const saved = await api<typeof details>(
                    `/v1/chat/conversations/${id}/followup-complete`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                      body: '{}',
                    },
                  );
                  setDetails(saved);
                  setError('');
                } catch {
                  setError('Completion was not saved. Please retry.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Mark follow-up complete
            </Button>
          )}
        </>
      )}
    </details>
  );
}
