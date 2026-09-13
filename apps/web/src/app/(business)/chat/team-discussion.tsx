'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui';
import { useLiveChat } from './chat-provider';
import type { HelpRequest } from './use-chat-help';
import styles from './chat.module.css';

type TeamMessage = {
  id: string;
  sequence: number;
  body: string;
  kind: string;
  mention: boolean;
  mine: boolean;
  createdAt: string;
};
type Discussion = {
  data: TeamMessage[];
  hasMore: boolean;
  nextSequence: number;
  active: boolean;
  incoming: boolean;
  teammateTyping: boolean;
  customer: { id: string; body: string; senderType: string; createdAt: string }[];
};
const headers = { 'Content-Type': 'application/json', 'x-chat-request': '1' };

export function TeamDiscussion({
  request,
  onClose,
}: {
  request: HelpRequest;
  onClose: () => void;
}) {
  const { help, select } = useLiveChat();
  const refreshHelp = help.refresh;
  const dialog = useRef<HTMLDialogElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const [data, setData] = useState<Discussion | null>(null);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('message');
  const [mention, setMention] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Connecting…');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const retry = useRef<{ id: string; body: string; kind: string; mention: boolean } | null>(null);
  const lastTyping = useRef(0);
  const read = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const teammate = request.incoming ? request.requesterName : request.helperName;
  const endpoint = '/v1/chat/conversations/help/' + request.id;
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let cursor = 0;
    let loading = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (loading || abort.signal.aborted) return;
      loading = true;
      clearTimeout(timer);
      try {
        let more = true;
        while (more && !abort.signal.aborted) {
          const page = await api<Discussion>(
            endpoint + '/discussion?limit=100&afterSequence=' + cursor,
            { cache: 'no-store', signal: abort.signal },
          );
          if (abort.signal.aborted) return;
          setData(page);
          if (page.data.length)
            setMessages((old) => [
              ...old,
              ...page.data.filter((m) => !old.some((o) => o.id === m.id)),
            ]);
          cursor = page.nextSequence;
          more = page.hasMore;
        }
        setConnection('Connected');
      } catch (e) {
        if (abort.signal.aborted) return;
        setConnection('Connection interrupted · retrying');
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setData(null);
          setMessages([]);
          cursor = 0;
          setError('Discussion access is no longer available.');
        }
      } finally {
        loading = false;
        if (!abort.signal.aborted) timer = setTimeout(load, 2000);
      }
    };
    refresh.current = load;
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [endpoint]);
  useEffect(() => {
    if (bottom.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    const acknowledge = () => {
      const sequence = messages.at(-1)?.sequence ?? 0;
      if (document.hidden || !document.hasFocus() || !bottom.current || sequence <= read.current)
        return;
      void api(endpoint + '/activity', {
        method: 'POST',
        headers,
        body: JSON.stringify({ readSequence: sequence }),
      })
        .then(() => {
          read.current = sequence;
          void refreshHelp();
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
  }, [messages, endpoint, refreshHelp]);
  const typing = (value: boolean) => {
    if (value && Date.now() - lastTyping.current < 3000) return;
    lastTyping.current = Date.now();
    void api(endpoint + '/activity', {
      method: 'POST',
      headers,
      body: JSON.stringify({ typing: value }),
    }).catch(() => {});
  };
  return (
    <dialog
      ref={dialog}
      className={styles.teamDialog}
      aria-labelledby="team-discussion-title"
      onCancel={onClose}
    >
      <header>
        <div>
          <h2 id="team-discussion-title">Private discussion with {teammate}</h2>
          <p>Team only · customer replies remain with {request.requesterName}</p>
        </div>
        <Button onClick={onClose}>Close discussion</Button>
      </header>
      {!request.incoming && (
        <p>
          <Button
            onClick={() => {
              select(request.conversationId);
              onClose();
            }}
          >
            Open customer workspace
          </Button>{' '}
          To hand over ownership, use Visitor details → Transfer to a teammate.
        </p>
      )}
      <p className={styles.discussionQuestion} data-sentry-mask>
        {request.question}
      </p>
      <div className={styles.discussionGrid}>
        <section>
          <h3>
            Customer conversation <small>Read only · latest 100 messages</small>
          </h3>
          <div className={styles.customerContext} data-sentry-mask>
            {data?.customer.map((m) => (
              <article key={m.id}>
                <strong>{m.senderType === 'visitor' ? 'Visitor' : 'Specialist'}</strong>
                <time>
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
                <p>{m.body}</p>
              </article>
            ))}
            {data && !data.active && (
              <p>
                Customer context is unavailable because help has ended or the chat has changed
                owners.
              </p>
            )}
          </div>
        </section>
        <section>
          <h3>
            Team discussion <small>Never visible to the customer</small>
          </h3>
          <div
            ref={log}
            className={styles.teamMessages}
            role="log"
            aria-label="Private team messages"
            aria-live="polite"
            data-sentry-mask
            onScroll={() => {
              const node = log.current;
              if (node)
                bottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
            }}
          >
            {!messages.length && (
              <p>
                Discuss the question here. Suggested replies stay private until the owner sends
                them.
              </p>
            )}
            {messages.map((m) => (
              <article key={m.id} data-mine={m.mine} data-suggestion={m.kind === 'suggestion'}>
                <strong>
                  {m.mine ? 'You' : teammate}
                  {m.kind === 'suggestion' ? ' · Suggested customer reply' : ' · Internal'}
                </strong>
                <time>
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
                {m.mention && <small>@{m.mine ? teammate : 'You'}</small>}
                <p>{m.body}</p>
                {!request.incoming && m.kind === 'suggestion' && data?.active && (
                  <Button
                    onClick={() => {
                      help.setSuggestion({ conversationId: request.conversationId, body: m.body });
                      select(request.conversationId);
                      onClose();
                    }}
                  >
                    Review in customer reply
                  </Button>
                )}
              </article>
            ))}
          </div>
          <p role="status">{data?.teammateTyping ? teammate + ' is typing…' : connection}</p>
          {data && !data.active && (
            <p>This discussion is read only. Ask for help again to continue collaborating.</p>
          )}
          <form
            className={styles.teamComposer}
            onSubmit={async (event) => {
              event.preventDefault();
              if (locked.current || !body.trim() || !data?.active) return;
              locked.current = true;
              setBusy(true);
              setError('');
              const input = { body: body.trim(), kind, mention };
              if (
                !retry.current ||
                retry.current.body !== input.body ||
                retry.current.kind !== kind ||
                retry.current.mention !== mention
              )
                retry.current = { id: crypto.randomUUID(), ...input };
              try {
                await api(endpoint + '/messages', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(retry.current),
                });
                setBody('');
                setMention(false);
                retry.current = null;
                bottom.current = true;
                await refresh.current();
                await help.refresh();
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : 'Message not confirmed. Retry to confirm.',
                );
              } finally {
                locked.current = false;
                setBusy(false);
              }
            }}
          >
            <label>
              Message type
              <select
                value={kind}
                disabled={busy || !data?.active}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="message">Internal message</option>
                <option value="suggestion">Suggest a customer reply</option>
              </select>
            </label>
            <label>
              {kind === 'suggestion'
                ? 'Suggested reply (private until sent by the owner)'
                : 'Internal message'}
              <textarea
                rows={3}
                maxLength={4000}
                value={body}
                disabled={busy || !data?.active}
                placeholder="Write to your teammate…"
                data-sentry-mask
                onChange={(e) => {
                  setBody(e.target.value);
                  typing(Boolean(e.target.value));
                }}
                onBlur={() => typing(false)}
              />
            </label>
            <label className={styles.mentionChoice}>
              <input
                type="checkbox"
                checked={mention}
                disabled={busy || !data?.active}
                onChange={(e) => setMention(e.target.checked)}
              />{' '}
              Mention @{teammate}
            </label>
            <Button type="submit" disabled={busy || !data?.active || !body.trim()}>
              {busy
                ? 'Sending…'
                : kind === 'suggestion'
                  ? 'Share private suggestion'
                  : 'Send internal message'}
            </Button>
            {error && <p role="alert">{error}</p>}
          </form>
        </section>
      </div>
    </dialog>
  );
}
