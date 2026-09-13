'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { Form, FormRootError, useZodForm } from '@/components/form/form';
import { Button, PageHeader } from '@/components/ui';
import styles from './chat.module.css';
import { AdminControls } from './admin-controls';
import { AskForHelp, TeamHelp } from './team-help';
import { SalesHandoff } from './sales-handoff';
import { ContextPanel } from './context-panel';
import { TeamControls } from './team-controls';
import { PushControls } from './push-controls';
import { useLiveChat } from './chat-provider';
import type { LiveConversation } from './live-state';

type Message = {
  id: string;
  body: string;
  sender: string;
  audience: string;
  sequence: number;
  createdAt: string;
};
const statusLabels: Record<string, string> = {
  queued: 'Waiting for a teammate',
  open: 'In progress',
  waiting_customer: 'Waiting for visitor',
  snoozed: 'Remind me later',
  resolved: 'Closed',
  spam: 'Spam',
};
const formSchema = z.object({
  body: z.string().trim().min(1, 'Write a message.').max(4000, 'Use 4,000 characters or fewer.'),
});
export default function ChatPage() {
  const [queue, setQueue] = useState('active');
  const [search, setSearch] = useState('');
  const [accepting, setAccepting] = useState<string | null>(null);
  const acceptLock = useRef(false);
  const [queueNotice, setQueueNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(tick);
  }, []);
  async function acceptFromQueue(row: LiveConversation) {
    if (acceptLock.current || !row.version) return;
    acceptLock.current = true;
    setAccepting(row.id);
    setQueueNotice('');
    try {
      await api(`/v1/chat/conversations/${row.id}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
        body: JSON.stringify({ action: 'claim', version: row.version }),
      });
      select(row.id);
      setQueueNotice('Chat accepted. You can reply now.');
    } catch (error) {
      setQueueNotice(
        error instanceof Error ? error.message : 'Could not accept this chat. Please try again.',
      );
    } finally {
      acceptLock.current = false;
      setAccepting(null);
    }
  }
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
  const waitingCount = conversations.filter(
    (row) => !row.assignedMembershipId && ['queued', 'open'].includes(row.status),
  ).length;
  const visible = conversations
    .filter((row) => {
      if (
        search &&
        ![row.id, row.preview, row.visitorName, row.assignedName]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      )
        return false;
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
    })
    .sort((a, b) => {
      const waitingA = !a.assignedMembershipId && ['queued', 'open'].includes(a.status);
      const waitingB = !b.assignedMembershipId && ['queued', 'open'].includes(b.status);
      if (waitingA !== waitingB) return waitingA ? -1 : 1;
      return waitingA
        ? (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt)
        : b.updatedAt.localeCompare(a.updatedAt);
    });
  return (
    <div className={styles.root} data-sentry-mask>
      <PageHeader
        title="Live chat"
        sub="Talk with website visitors and keep the conversation together."
      />
      <div className={styles.inboxBar}>
        <TeamControls />
        <div className={styles.connection} data-state={connection} role="status">
          <span className={styles.dot} />
          <strong>
            {connection === 'live'
              ? 'Live'
              : connection === 'denied'
                ? 'Access required'
                : 'Connecting…'}
          </strong>
        </div>
        <Button aria-pressed={sound} onClick={() => void toggleSound()}>
          {sound ? 'Sound on' : 'Enable sound'}
        </Button>
        <details className={styles.settingsMenu}>
          <summary>Inbox settings</summary>
          <div className={styles.settingsContent}>
            <h2>Notifications & settings</h2>
            <Button aria-pressed={notifications} onClick={() => void toggleNotifications()}>
              {notifications ? 'Desktop alerts on' : 'Enable desktop alerts'}
            </Button>
            <p>Get an alert when a visitor sends a message.</p>
            <PushControls />
            <AdminControls />
          </div>
        </details>
      </div>
      <TeamHelp />
      <div className={styles.inboxStatus}>
        <strong>
          {waitingCount
            ? waitingCount + ' waiting for a teammate'
            : unread.length
              ? unread.length + ' unread'
              : 'No unread messages'}
        </strong>
        <span role="status">{notice || latest || 'New chats appear here automatically.'}</span>
      </div>
      {connection === 'reconnecting' && (
        <p role="alert" className={styles.error}>
          Connection interrupted. Reconnecting automatically. Your messages will catch up.
        </p>
      )}
      <div className={styles.layout}>
        <aside className={styles.queue} aria-label="Conversation queue">
          <div className={styles.queueHeading}>
            <h2>Inbox</h2>
            <span>{visible.length}</span>
          </div>
          <div className={styles.queueTabs} aria-label="Quick filters">
            {(
              [
                ['active', 'All active'],
                ['mine', 'My chats'],
                ['unassigned', 'Unassigned'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={queue === value} onClick={() => setQueue(value)}>
                {label}
              </button>
            ))}
          </div>
          <input
            className={`input ${styles.search}`}
            aria-label="Search conversations"
            placeholder="Search name, message or reference…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label htmlFor="chat-queue">Filter conversations</label>
          <select
            id="chat-queue"
            className="input"
            value={queue}
            onChange={(event) => setQueue(event.target.value)}
          >
            <option value="active">Active</option>
            <option value="overdue">Overdue</option>
            <option value="followup">Follow-up requested</option>
            <option value="mine">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
            <option value="unread">Unread</option>
            <option value="waiting_team">Waiting on team</option>
            <option value="waiting_customer">Waiting on customer</option>
            <option value="snoozed">Snoozed</option>
            <option value="resolved">Closed</option>
            <option value="spam">Spam</option>
            <option value="all">All conversations</option>
          </select>
          {conversations.length > 0 && visible.length === 0 && (
            <p>No conversations in this queue.</p>
          )}
          {connection === 'connecting' && <p>Loading conversations...</p>}
          {connection === 'live' && !conversations.length && <p>No conversations yet.</p>}
          {queueNotice && (
            <p role="status" className={styles.queueNotice}>
              {queueNotice}
            </p>
          )}
          {visible.map((conversation) => (
            <div key={conversation.id} className={styles.queueCard}>
              <button
                className={styles.item}
                aria-pressed={selected === conversation.id}
                onClick={() => select(conversation.id)}
                data-unread={unread.includes(conversation.id)}
              >
                <div className={styles.itemTop}>
                  <strong>{conversation.visitorName || 'Website visitor'}</strong>
                  <time>
                    {new Date(conversation.updatedAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                {unread.includes(conversation.id) && (
                  <span className={styles.badge}>● New message</span>
                )}
                <small>
                  {conversation.assignedToMe
                    ? 'Assigned to you'
                    : conversation.assignedMembershipId
                      ? `With ${conversation.assignedName || 'a teammate'}`
                      : 'Unassigned'}
                </small>
                {conversation.overdue && (
                  <span className={styles.badge} data-tone="risk">
                    ▲ Reply overdue
                  </span>
                )}
                {conversation.followupPending && (
                  <span className={styles.badge} data-tone="waiting">
                    ◔ Follow-up requested
                  </span>
                )}
                <p className={styles.messagePreview}>
                  {conversation.preview || 'Open conversation to view messages'}
                </p>
                {conversation.visitorName && <small>Name provided by visitor</small>}
                <span>
                  {conversation.awaitingSince &&
                  !['resolved', 'spam', 'snoozed'].includes(conversation.status)
                    ? `Waiting ${Math.max(0, Math.floor((now - new Date(conversation.awaitingSince).getTime()) / 60000))} min for a reply`
                    : (statusLabels[conversation.status] ?? conversation.status)}
                </span>
                <small>
                  #{conversation.id.slice(0, 8)} ·{' '}
                  {new Date(conversation.updatedAt).toLocaleDateString()}
                </small>
              </button>
              {!conversation.assignedMembershipId &&
                ['queued', 'open'].includes(conversation.status) && (
                  <button
                    className={styles.acceptQueue}
                    disabled={accepting !== null}
                    onClick={() => void acceptFromQueue(conversation)}
                    aria-label={`Accept chat ${conversation.id.slice(0, 8)}`}
                  >
                    {accepting === conversation.id ? 'Accepting…' : 'Accept chat →'}
                  </button>
                )}
            </div>
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
  const { help } = useLiveChat();
  const suggestionPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (help.suggestion?.conversationId === id) {
      suggestionPanel.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      suggestionPanel.current?.focus({ preventScroll: true });
    }
  }, [help.suggestion, id]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [showDetails, setShowDetails] = useState(false);
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
      setStatus(
        action === 'claim'
          ? 'Chat accepted. You are now handling this conversation.'
          : 'Conversation updated.',
      );
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
    <div className={styles.conversationWithContext} data-details={showDetails}>
      <section className={styles.conversation} aria-label="Selected conversation">
        <header className={styles.heading}>
          <div>
            <h2>{conversation?.visitorName || 'Website visitor'}</h2>
            <small>
              {statusLabels[conversation?.status ?? 'open']} · #{id.slice(0, 8)}
            </small>
          </div>
          <Button
            aria-expanded={showDetails}
            aria-controls="visitor-details"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? 'Hide details' : 'Visitor details'}
          </Button>
        </header>
        <div className={styles.workflow}>
          {conversation &&
            !conversation.assignedMembershipId &&
            ['queued', 'open'].includes(conversation.status) && (
              <Button
                variant="primary"
                disabled={workflowBusy}
                onClick={() => void workflow('claim')}
              >
                {workflowBusy ? 'Accepting…' : 'Accept chat'}
              </Button>
            )}
          {conversation?.assignedMembershipId && (
            <span className={styles.arrival}>
              {conversation.assignedToMe
                ? 'You are handling this chat'
                : `${conversation.assignedName || 'A teammate'} is handling this chat`}
            </span>
          )}

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
              Start conversation
            </Button>
          )}
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
              ? 'Reopen chat'
              : 'Mark as done'}
          </Button>
          <details className={styles.actionsMenu}>
            <summary>More actions</summary>
            <div>
              <Button
                disabled={workflowBusy}
                onClick={() => void workflow(conversation?.assignedToMe ? 'release' : 'claim')}
              >
                {conversation?.assignedToMe ? 'Return to unassigned' : 'Assign to me'}
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
              <Button onClick={() => void refresh.current()}>Refresh messages</Button>
            </div>
          </details>
        </div>
        {conversation?.assignedToMe && !['resolved', 'spam'].includes(conversation.status) && (
          <AskForHelp id={id} />
        )}
        <FollowupPanel id={id} version={conversation?.version} />
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
                    : 'Sent'}
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
        <div className={styles.composer} data-note={note}>
          {help.suggestion?.conversationId === id && (
            <section ref={suggestionPanel} tabIndex={-1} className={styles.suggestionPreview}>
              <strong>Suggested customer reply · review before sending</strong>
              <p data-sentry-mask>{help.suggestion.body}</p>
              <Button
                disabled={!conversation?.assignedToMe || form.formState.isSubmitting}
                onClick={() => {
                  const existing = form.getValues('body').trim();
                  const suggested = help.suggestion!.body;
                  if ((existing + '\n\n' + suggested).trim().length > 4000) {
                    setError(
                      'Your draft plus the suggestion exceeds 4,000 characters. Shorten the draft first.',
                    );
                    return;
                  }
                  if (note && existing) {
                    setError('Save or clear your private note before inserting a customer reply.');
                    return;
                  }
                  setNote(false);
                  form.setValue('body', existing ? existing + '\n\n' + suggested : suggested, {
                    shouldDirty: true,
                  });
                  help.setSuggestion(null);
                  setStatus('Suggestion added to your draft. Review it, then send when ready.');
                }}
              >
                Add to reply draft
              </Button>
              <Button onClick={() => help.setSuggestion(null)}>Dismiss suggestion</Button>
            </section>
          )}
          {!conversation?.assignedToMe && (
            <p className={styles.arrival}>
              {conversation?.assignedMembershipId
                ? 'A teammate is handling this chat.'
                : 'Accept this chat to start replying.'}
            </p>
          )}
          <div className={styles.modes}>
            <Button
              aria-pressed={!note}
              onClick={() => setNote(false)}
              disabled={form.formState.isSubmitting || !conversation?.assignedToMe}
            >
              Reply to visitor
            </Button>
            <Button
              aria-pressed={note}
              onClick={() => setNote(true)}
              disabled={form.formState.isSubmitting || !conversation?.assignedToMe}
            >
              Private note
            </Button>
          </div>
          <SalesHandoff
            id={id}
            enabled={Boolean(conversation?.assignedToMe)}
            onSaved={() => refresh.current()}
          />
          {!note && (
            <label className={styles.quickReply}>
              Saved reply
              <select
                className="input"
                value=""
                disabled={form.formState.isSubmitting || !conversation?.assignedToMe}
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
                <option value="Do you have a budget range in mind? I can use that to help narrow down the options.">
                  Budget
                </option>
                <option value="When are you hoping to have your new mattress?">
                  Purchase timing
                </option>
                <option value="Which mattresses are you considering, and what matters most to you when comparing them?">
                  Compare options
                </option>
                <option value="What would be most helpful next: comparing a few options, planning a showroom visit, or checking delivery details?">
                  Agree on next step
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
              rows={2}
              placeholder={note ? 'Add a note for your team…' : 'Write a helpful reply…'}
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
              disabled={form.formState.isSubmitting || !conversation?.assignedToMe}
              data-sentry-mask
              aria-invalid={Boolean(form.formState.errors.body)}
            />
            {form.formState.errors.body && <p role="alert">{form.formState.errors.body.message}</p>}
            <FormRootError />
            <div className={styles.toolbar}>
              <span role="status">{status}</span>
              <Button
                type="submit"
                variant="primary"
                disabled={form.formState.isSubmitting || !conversation?.assignedToMe}
              >
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
      {showDetails && (
        <div id="visitor-details" className={styles.detailsWrap}>
          <ContextPanel
            id={id}
            version={conversation?.version}
            onTemplate={(body) => {
              setNote(false);
              form.setValue('body', body, { shouldDirty: true });
            }}
          />
        </div>
      )}
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
    <details
      key={details?.completedAt ?? 'pending'}
      className={styles.followupCard}
      open={!details?.completedAt}
      data-pending={!details?.completedAt}
    >
      <summary>
        {details?.completedAt ? 'Follow-up completed' : 'Next step: follow up with this visitor'}
      </summary>
      {error && <p role="alert">{error}</p>}
      {details?.requestedAt && (
        <>
          <dl className={styles.visitorFacts}>
            <dt>Visitor</dt>
            <dd>{details.name || 'Name not provided'}</dd>
            <dt>Preferred reply</dt>
            <dd>
              {details.method === 'email'
                ? 'Email'
                : details.method === 'phone'
                  ? 'Phone'
                  : details.method || 'Not specified'}
            </dd>
            <dt>Contact</dt>
            <dd>{details.contact || 'Not provided'}</dd>
            <dt>Requested</dt>
            <dd>{new Date(details.requestedAt).toLocaleString()}</dd>
            {details.completedAt && (
              <>
                <dt>Completed</dt>
                <dd>{new Date(details.completedAt).toLocaleString()}</dd>
              </>
            )}
          </dl>
          <p>Visitor-provided details · identity unverified.</p>
          {!details.completedAt && (
            <p>
              Contact the visitor using their preferred method, then mark the follow-up complete.
            </p>
          )}
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
              {busy ? 'Saving…' : 'Mark follow-up complete'}
            </Button>
          )}
        </>
      )}
    </details>
  );
}
