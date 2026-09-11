'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { Form, FormRootError, useZodForm } from '@/components/form/form';
import { Button, PageHeader } from '@/components/ui';
import styles from './chat.module.css';

type Conversation = { id: string; status: string; updatedAt: string; lastSequence: number };
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
const errorMessage = (error: unknown) =>
  error instanceof ApiError && error.status === 412
    ? 'Choose your business from the selector above to open its inbox.'
    : error instanceof Error
      ? error.message
      : 'Unable to load conversations';

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const started = useRef(Date.now());
  const paginated = useRef(false);
  const load = useCallback(async (cursor?: string) => {
    try {
      const result = await api<{
        data: Conversation[];
        hasMore: boolean;
        nextCursor: string | null;
      }>(`/v1/chat/conversations?limit=50${cursor ? `&afterId=${cursor}` : ''}`, {
        cache: 'no-store',
      });
      if (cursor) paginated.current = true;
      setConversations((old) => {
        if (!paginated.current) return result.data;
        const merged = new Map(old.map((row) => [row.id, row]));
        for (const row of result.data) merged.set(row.id, row);
        return [...merged.values()];
      });
      if (cursor || !paginated.current) setMore(result.hasMore ? result.nextCursor : null);
      setError('');
      setLoaded(true);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        setConversations([]);
        setSelected(null);
      }
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (Date.now() - started.current > 10 * 60 * 1000) {
        setPaused(true);
        return;
      }
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <div className={styles.root} data-sentry-mask>
      <PageHeader
        title="Live chat"
        sub="Talk with website visitors and keep the conversation together."
      />
      <div className={styles.toolbar}>
        <span role="status">
          {paused
            ? 'Automatic updates paused.'
            : 'Checking for new conversations every few seconds.'}
        </span>
        <Button
          onClick={() => {
            started.current = Date.now();
            setPaused(false);
            void load();
          }}
        >
          Refresh inbox
        </Button>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.layout}>
        <aside className={styles.queue} aria-label="Conversation queue">
          <h2>Team conversations</h2>
          {!loaded && !error && <p>Loading conversations…</p>}
          {loaded && !conversations.length && !error && <p>No conversations yet.</p>}
          {conversations.map((conversation) => (
            <button
              className={styles.item}
              key={conversation.id}
              aria-pressed={selected === conversation.id}
              onClick={() => setSelected(conversation.id)}
            >
              <strong>Visitor · {conversation.id.slice(0, 8)}</strong>
              <span>{conversation.status.replaceAll('_', ' ')}</span>
              <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
            </button>
          ))}
          {more && <Button onClick={() => void load(more)}>Load more</Button>}
        </aside>
        {selected ? (
          <ConversationPanel key={selected} id={selected} />
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

function ConversationPanel({ id }: { id: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [note, setNote] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const sequence = useRef(0);
  const retry = useRef<{ body: string; note: boolean; id: string } | null>(null);
  const form = useZodForm(formSchema, { body: '' });
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const abort = new AbortController();
    let fetching = false;
    const deadline = Date.now() + 10 * 60 * 1000;
    async function load() {
      if (fetching || abort.signal.aborted) return;
      fetching = true;
      try {
        let hasMore = true;
        while (hasMore && !abort.signal.aborted) {
          const result = await api<{ data: Message[]; hasMore: boolean; nextSequence: number }>(
            `/v1/chat/conversations/${id}/history?afterSequence=${sequence.current}&limit=100`,
            { signal: abort.signal, cache: 'no-store' },
          );
          if (abort.signal.aborted) return;
          setMessages((old) => [
            ...old,
            ...result.data.filter((row) => !old.some((item) => item.id === row.id)),
          ]);
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
      }
    }
    refresh.current = load;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden && Date.now() < deadline) void load();
    }, 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [id]);
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
          </article>
        ))}
      </div>
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
            rows={4}
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
