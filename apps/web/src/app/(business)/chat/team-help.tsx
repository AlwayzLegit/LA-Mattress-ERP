'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { useLiveChat } from './chat-provider';
import styles from './chat.module.css';
type Specialist = {
  id: string;
  name: string;
  available: boolean;
  workload: number;
  capacity: number;
  stores: string[];
};
const headers = { 'Content-Type': 'application/json', 'x-chat-request': '1' };
export function AskForHelp({ id }: { id: string }) {
  const { help } = useLiveChat();
  const [agents, setAgents] = useState<Specialist[]>([]);
  const [selected, setSelected] = useState('');
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const retry = useRef<{ key: string; question: string; helperId: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Specialist[]>('/v1/chat/conversations/' + id + '/help-options')
        .then((rows) => {
          if (!cancelled) setAgents(rows);
        })
        .catch(() => {
          if (!cancelled) setStatus('Could not load specialists. Retrying…');
        });
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);
  return (
    <details className={styles.helpPanel}>
      <summary>Ask a specialist for help</summary>
      <p>
        You stay responsible for this customer. Your teammate receives only this internal question.
      </p>
      <label>
        Specialist
        <select value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a teammate</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.available || a.workload >= a.capacity}>
              {a.name} · {a.stores.join(', ') || 'All stores'} · {a.workload}/{a.capacity} chats
              {!a.available ? ' · Away' : a.workload >= a.capacity ? ' · At capacity' : ''}
            </option>
          ))}
        </select>
      </label>
      {!agents.some((a) => a.available && a.workload < a.capacity) && (
        <p>No other specialists are available right now. This list refreshes automatically.</p>
      )}
      <label>
        What do you need help with?
        <textarea
          maxLength={1000}
          rows={2}
          value={question}
          disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Can you check whether the queen model is on display at your store?"
          data-sentry-mask
        />
      </label>
      <Button
        disabled={
          busy ||
          !question.trim() ||
          !agents.some((a) => a.id === selected && a.available && a.workload < a.capacity)
        }
        onClick={async () => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setStatus('');
          const text = question.trim();
          if (retry.current?.question !== text || retry.current.helperId !== selected)
            retry.current = { key: crypto.randomUUID(), question: text, helperId: selected };
          try {
            await api('/v1/chat/conversations/' + id + '/help', {
              method: 'POST',
              headers,
              body: JSON.stringify({ id: retry.current.key, helperId: selected, question: text }),
            });
            setQuestion('');
            retry.current = null;
            setStatus('Help requested. You still own this chat.');
            await help.refresh();
          } catch (e) {
            setStatus(e instanceof Error ? e.message : 'Request not confirmed. Retry to confirm.');
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? 'Requesting…' : 'Request help'}
      </Button>
      <p role="status">{status}</p>
    </details>
  );
}
export function TeamHelp() {
  const { help } = useLiveChat();
  const [open, setOpen] = useState(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const incoming = help.requests.filter((row) => row.incoming && row.status === 'requested');
    if (incoming.some((row) => !seen.current.has(row.id))) setOpen(true);
    incoming.forEach((row) => seen.current.add(row.id));
  }, [help.requests]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [status, setStatus] = useState('');
  const count = help.requests.filter((r) => ['requested', 'accepted'].includes(r.status)).length;
  return (
    <details
      id="team-help"
      className={styles.helpPanel}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Team help · {count} active</summary>
      <p>Requests to you and from you. Customer chat ownership stays with the requester.</p>
      {help.error && <p role="alert">{help.error}</p>}
      {!help.requests.length && <p>No help requests yet.</p>}
      {help.requests.map((row) => (
        <article key={row.id} className={styles.helpRequest}>
          <strong>{row.incoming ? 'From ' + row.requesterName : 'To ' + row.helperName}</strong>
          <span>
            {
              (
                {
                  requested: 'Help requested',
                  accepted: 'Accepted',
                  finished: 'Finished',
                  cancelled: 'Cancelled',
                } as Record<string, string>
              )[row.status]
            }
          </span>
          <p data-sentry-mask>{row.question}</p>
          <small>
            Chat #{row.conversationId.slice(0, 8)} · {new Date(row.updatedAt).toLocaleString()}
          </small>
          {(row.incoming
            ? row.status === 'requested'
              ? ['accept']
              : row.status === 'accepted'
                ? ['finish']
                : []
            : ['requested', 'accepted'].includes(row.status)
              ? ['cancel']
              : []
          ).map((action) => (
            <Button
              key={action}
              disabled={busy}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                try {
                  await api('/v1/chat/conversations/help/' + row.id, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ action, version: row.version }),
                  });
                  setStatus('Help request updated.');
                  await help.refresh();
                } catch (e) {
                  setStatus(e instanceof Error ? e.message : 'Could not update request.');
                } finally {
                  lock.current = false;
                  setBusy(false);
                }
              }}
            >
              {action === 'accept'
                ? 'Accept help request'
                : action === 'finish'
                  ? 'Finish helping'
                  : 'Cancel request'}
            </Button>
          ))}
        </article>
      ))}
      <p role="status">{status}</p>
    </details>
  );
}
