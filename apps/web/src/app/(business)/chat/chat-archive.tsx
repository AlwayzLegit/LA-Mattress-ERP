'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { useLiveChat } from './chat-provider';
import styles from './chat.module.css';
type PastChat = {
  id: string;
  visitorName: string | null;
  assignedName: string | null;
  status: string;
  updatedAt: string;
  preview: string | null;
};
type Entry = { id: string; sender: string; body: string; sequence: number; createdAt: string };
export function ChatArchive() {
  const { conversations } = useLiveChat();
  const completed = conversations
    .filter((row) => ['resolved', 'spam'].includes(row.status))
    .map((row) => row.id)
    .sort()
    .join(',');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<PastChat[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<PastChat | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [after, setAfter] = useState(0);
  const [moreMessages, setMoreMessages] = useState(false);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<{ data: PastChat[]; hasMore: boolean }>(
      `/v1/chat/conversations/archive?offset=${offset}&q=${encodeURIComponent(query)}`,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setRows(result.data);
          setMore(result.hasMore);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError('Chat history could not be loaded. Try Refresh.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, offset, revision, completed]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setReading(true);
    setReadError('');
    void api<{ data: Entry[]; hasMore: boolean }>(
      `/v1/chat/conversations/archive/${selected.id}?afterSequence=${after}`,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setEntries((old) => (after ? [...old, ...result.data] : result.data));
          setMoreMessages(result.hasMore);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setReadError(
            'This transcript is unavailable. Refresh history and select the chat again.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [selected, after]);
  return (
    <section className={styles.archive} aria-label="Chat history">
      <div className={styles.archiveHeader}>
        <div>
          <h2>Chat history</h2>
          <p>Completed conversations · shared with your chat team</p>
        </div>
        <Button disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          Refresh history
        </Button>
      </div>
      <form
        className={styles.archiveSearch}
        onSubmit={(event) => {
          event.preventDefault();
          setOffset(0);
          setQuery(search.trim());
        }}
      >
        <input
          className="input"
          aria-label="Search chat history"
          placeholder="Search visitor, message or chat reference…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={200}
        />
        <Button type="submit">Search history</Button>
      </form>
      <div className={styles.archiveGrid}>
        <div aria-busy={loading}>
          {error && <p role="alert">{error}</p>}
          {loading ? (
            <p role="status">Loading history…</p>
          ) : rows.length ? (
            <ul className={styles.archiveList}>
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    aria-pressed={selected?.id === row.id}
                    onClick={() => {
                      setAfter(0);
                      setEntries([]);
                      setMoreMessages(false);
                      setSelected(row);
                    }}
                  >
                    <strong>{row.visitorName || 'Website visitor'}</strong>
                    <span>
                      {row.status === 'spam' ? 'Spam' : 'Closed'} ·{' '}
                      {new Date(row.updatedAt).toLocaleString()}
                    </span>
                    <p>{row.preview || 'View conversation'}</p>
                    <small>
                      {row.assignedName ? `Handled by ${row.assignedName} · ` : ''}#
                      {row.id.slice(0, 8)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            !error && (
              <p>
                {query ? 'No past chats match your search.' : 'Completed chats will appear here.'}
              </p>
            )
          )}
          <div className={styles.archiveSearch}>
            <Button
              disabled={loading || offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 25))}
            >
              Newer chats
            </Button>
            <Button disabled={loading || !more} onClick={() => setOffset((value) => value + 25)}>
              Older chats
            </Button>
          </div>
        </div>
        <section
          className={styles.archiveTranscript}
          aria-label="Past chat transcript"
          aria-busy={reading}
        >
          {selected ? (
            <>
              <h3>
                {selected.visitorName || 'Website visitor'} · #{selected.id.slice(0, 8)}
              </h3>
              <p>Read-only transcript</p>
              {entries.map((entry) => (
                <article key={entry.id}>
                  <strong>
                    {entry.sender === 'visitor'
                      ? 'Visitor'
                      : entry.sender === 'staff'
                        ? 'Specialist'
                        : 'System'}
                  </strong>
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                  <p>{entry.body}</p>
                </article>
              ))}
              {reading && <p role="status">Loading transcript…</p>}
              {readError && <p role="alert">{readError}</p>}
              {moreMessages && (
                <Button disabled={reading} onClick={() => setAfter(entries.at(-1)?.sequence ?? 0)}>
                  Load more messages
                </Button>
              )}
            </>
          ) : (
            <>
              <h3>Read a past conversation</h3>
              <p>Select a chat to see the visitor and specialist messages.</p>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
