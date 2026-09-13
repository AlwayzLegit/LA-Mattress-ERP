'use client';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import styles from './chat.module.css';

const fields = [
  ['size', 'Mattress size', 'e.g. Queen'],
  ['comfort', 'Comfort preferences', 'e.g. Softer feel with support'],
  ['budget', 'Budget discussed', 'e.g. Around $1,500'],
  ['timing', 'Purchase timing', 'e.g. Moving next month'],
  ['interest', 'Products or showroom discussed', 'Record only what was discussed'],
  ['nextStep', 'Agreed next step', 'e.g. Send two options tomorrow'],
] as const;
type Field = (typeof fields)[number][0];
const empty = Object.fromEntries(fields.map(([key]) => [key, ''])) as Record<Field, string>;

export function SalesHandoff({
  id,
  enabled,
  onSaved,
}: {
  id: string;
  enabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState({ ...empty });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const lock = useRef(false);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const rows = fields.filter(([key]) => values[key].trim());
  const body = [
    'Sales handoff · team only',
    ...rows.map(([key, label]) => label + ': ' + values[key].trim()),
  ].join(String.fromCharCode(10));
  return (
    <details className={styles.salesHandoff}>
      <summary>Capture preferences &amp; next step</summary>
      <p>
        Record what the visitor shared. This saves a private team note; it does not schedule a task
        or contact the visitor.
      </p>
      <div className={styles.handoffFields}>
        {fields.map(([key, label, placeholder]) => (
          <label key={key}>
            {label}
            <input
              value={values[key]}
              maxLength={300}
              placeholder={placeholder}
              disabled={busy || !enabled}
              data-sentry-mask
              onChange={(event) => {
                setValues((old) => ({ ...old, [key]: event.target.value }));
                setStatus('');
              }}
            />
          </label>
        ))}
      </div>
      {rows.length > 0 && (
        <details className={styles.handoffPreview}>
          <summary>Preview private note</summary>
          <pre data-sentry-mask>{body}</pre>
        </details>
      )}
      <Button
        disabled={!enabled || busy || !rows.length}
        onClick={async () => {
          if (lock.current || !enabled || !rows.length) return;
          lock.current = true;
          setBusy(true);
          setStatus('');
          if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
          try {
            await api('/v1/chat/conversations/' + id + '/notes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-chat-request': '1' },
              body: JSON.stringify({ body, clientMessageId: retry.current.key }),
            });
            retry.current = null;
            setValues({ ...empty });
            setStatus('Sales handoff saved as a private team note.');
            await onSaved();
          } catch {
            setStatus('Save not confirmed. Your entries are still here; retry to confirm.');
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? 'Saving…' : 'Save private handoff'}
      </Button>
      <span role="status">{status}</span>
    </details>
  );
}
