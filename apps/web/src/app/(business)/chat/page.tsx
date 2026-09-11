'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { Form, FormRootError, useZodForm } from '@/components/form/form';
import { Button, PageHeader } from '@/components/ui';
import styles from './chat.module.css';
import { useLiveChat } from './use-live-chat';

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
      <div className={styles.layout}>
        <aside className={styles.queue} aria-label="Conversation queue">
          <h2>Team conversations</h2>
          {connection === 'connecting' && <p>Loading conversations...</p>}
          {connection === 'live' && !conversations.length && <p>No conversations yet.</p>}
          {conversations.map((conversation) => (
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
              <span>{conversation.status.replaceAll('_', ' ')}</span>
              <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </aside>
        {selected ? (
          <ConversationPanel
            key={selected}
            id={selected}
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

function ConversationPanel({ id, revision }: { id: string; revision: number }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [note, setNote] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const history = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [below, setBelow] = useState(false);
  const sequence = useRef(0);
  const retry = useRef<{ body: string; note: boolean; id: string } | null>(null);
  const form = useZodForm(formSchema, { body: '' });
  const refresh = useRef<() => Promise<void>>(async () => {});
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
    <section className={styles.conversation} aria-label="Selected conversation">
      <header className={styles.heading}>
        <div>
          <h2>Visitor conversation</h2>
          <small>{id.slice(0, 8)}</small>
        </div>
        <Button onClick={() => void refresh.current()}>Refresh messages</Button>
      </header>
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
              <small className={styles.saved}>Saved</small>
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
        <Form
          form={form}
          onSubmit={async ({ body }) => {
            setStatus('Saving…');
            if (!retry.current || retry.current.body !== body || retry.current.note !== note)
              retry.current = { body, note, id: crypto.randomUUID() };
            try {
              await api(`/v1/chat/conversations/${id}/${note ? 'notes' : 'messages'}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
                body: JSON.stringify({ body, clientMessageId: retry.current.id }),
              });
              form.reset({ body: '' });
              retry.current = null;
              setStatus(note ? 'Private note saved.' : 'Reply saved.');
              await refresh.current();
            } catch (e) {
              setStatus('Not confirmed. Your draft is still here; retry to confirm it was saved.');
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
            {...form.register('body')}
            disabled={form.formState.isSubmitting}
            data-sentry-mask
            aria-invalid={Boolean(form.formState.errors.body)}
          />
          {form.formState.errors.body && <p role="alert">{form.formState.errors.body.message}</p>}
          <FormRootError />
          <div className={styles.toolbar}>
            <span role="status">{status}</span>
            <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Saving…' : note ? 'Save private note' : 'Send reply'}
            </Button>
          </div>
        </Form>
      </div>
    </section>
  );
}
