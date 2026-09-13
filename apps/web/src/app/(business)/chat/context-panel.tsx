'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import styles from './chat.module.css';
type Details = {
  sharedDraft?: { text: string; expiresAt: number } | null;
  context: {
    topic?: string;
    pagePath?: string;
    currentPage?: { path: string; title: string; seenAt: string } | null;
  } | null;
  locationId: string | null;
  locationName: string | null;
  customerId: string | null;
  customerVerifiedAt: string | null;
  version: number;
  agents: { id: string; name: string; available: boolean; workload: number; capacity: number }[];
  assignmentHistory: { action: string; at: string; changes: unknown }[];
  templates: { title: string; body: string }[];
};
const headers = { 'Content-Type': 'application/json', 'x-chat-request': '1' };
export function ContextPanel({
  id,
  version,
  onTemplate,
}: {
  id: string;
  version?: number;
  onTemplate: (body: string) => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [member, setMember] = useState('');
  const [customer, setCustomer] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<
    { id: string; firstName: string | null; lastName: string | null; number: string | null }[]
  >([]);
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    void api<Details>(`/v1/chat/conversations/${id}/context`)
      .then((data) => {
        if (!cancelled) {
          setDetails(data);
          setCustomer(data.customerId ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('Conversation context could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  async function save(action: string, body: object) {
    setBusy(true);
    try {
      await api(`/v1/chat/conversations/${id}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      setStatus('Saved.');
    } catch {
      setStatus(
        'Not saved. Check your permissions, teammate availability, or refresh the conversation.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className={styles.context} aria-label="Visitor context">
      <h2>Customer & tools</h2>
      {!details && !status && <p role="status">Loading visitor details…</p>}
      <p role="status">{status}</p>
      {details && (
        <>
          <dl className={styles.visitorFacts}>
            <dt>Chat started from</dt>
            <dd>{details.context?.pagePath ?? 'Website page not available'}</dd>
            {details.context?.topic && details.context.topic !== 'other' && (
              <>
                <dt>Visitor is asking about</dt>
                <dd>{details.context.topic}</dd>
              </>
            )}
            <dt>Team coverage</dt>
            <dd>{details.locationName ?? 'Shared across all stores'}</dd>
            <dt>Customer record</dt>
            <dd>
              {details.customerId && details.customerVerifiedAt
                ? 'Verified customer linked'
                : 'Not linked to a verified customer'}
            </dd>
          </dl>
          <details className={styles.detailSection}>
            <summary>Transfer to a teammate</summary>
            <p>Choose someone available to continue this conversation.</p>
            <label>
              Available teammate
              <select value={member} onChange={(e) => setMember(e.target.value)}>
                <option value="">Choose teammate</option>
                {details.agents.map((agent) => (
                  <option
                    key={agent.id}
                    value={agent.id}
                    disabled={!agent.available || agent.workload >= agent.capacity}
                  >
                    {agent.name} ({agent.workload}/{agent.capacity})
                    {!agent.available ? ' · away' : ''}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={busy || !member}
              onClick={() =>
                void save('transfer', { membershipId: member, version: details.version })
              }
            >
              Transfer chat
            </Button>
          </details>
          <details className={styles.detailSection}>
            <summary>Team saved replies</summary>
            <p>Choose a reply, then edit it before sending.</p>
            {details.templates.length ? (
              details.templates.map((template, index) => (
                <Button key={index} onClick={() => onTemplate(template.body)}>
                  {template.title}
                </Button>
              ))
            ) : (
              <p>A manager can add replies in chat administration.</p>
            )}
          </details>
          <details className={styles.detailSection}>
            <summary>Link an existing customer</summary>
            <p>
              Contact details supplied by a visitor are unverified. Verify identity using your
              existing customer process first.
            </p>
            {details.customerId && details.customerVerifiedAt && (
              <a href={`/customers/${details.customerId}`}>Open linked ERP customer</a>
            )}
            <label>
              Find an existing customer
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, email or phone"
              />
            </label>
            <Button
              disabled={busy || query.trim().length < 3}
              onClick={async () => {
                setBusy(true);
                try {
                  setCandidates(
                    await api(
                      `/v1/chat/conversations/customer-candidates?q=${encodeURIComponent(query.trim())}`,
                    ),
                  );
                  setStatus('Choose the matching record and verify identity before linking.');
                } catch {
                  setStatus('Customer search requires manager and customer-view permissions.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Search customers
            </Button>
            <label>
              Matching customer
              <select
                value={customer}
                onChange={(event) => {
                  setCustomer(event.target.value);
                  setVerified(false);
                }}
              >
                <option value="">No customer link</option>
                {details.customerId && !candidates.some((row) => row.id === details.customerId) && (
                  <option value={details.customerId}>Currently linked customer</option>
                )}
                {candidates.map((row) => (
                  <option key={row.id} value={row.id}>
                    {[row.firstName, row.lastName].filter(Boolean).join(' ')}
                    {row.number ? ` · ${row.number}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />
              I have verified this customer’s identity
            </label>
            <Button
              disabled={busy || !verified}
              onClick={() =>
                void save('customer', {
                  customerId: customer || null,
                  verificationConfirmed: true,
                  version: details.version,
                })
              }
            >
              Save customer link
            </Button>
          </details>
          <details className={styles.detailSection}>
            <summary>Assignment history</summary>
            {!details.assignmentHistory.length && <p>No assignments yet.</p>}
            <ol>
              {details.assignmentHistory.map((row, index) => (
                <li key={index}>
                  {row.action.replace('chat.', '').replaceAll('_', ' ')} ·{' '}
                  {new Date(row.at).toLocaleString()}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </aside>
  );
}
