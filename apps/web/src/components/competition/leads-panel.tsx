'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, Field, Input, StatusChip } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { ShimmerRows } from '@/app/(business)/dashboard/owner/owner-kit';
import { COMPETITION_EVENT, pingCompetition, type LeadRow } from './types';

/**
 * "My leads" under the strip on the salesperson home (README §3.6): every
 * lead with Wanted, logged date and days left, the status chip (Open /
 * Converted / Lost — the only semantic colour on the panel), the order
 * number once converted, and Follow up / Attach order / Lost on open rows.
 * Attaching by hand is audit-logged and the row says "by hand".
 */
export function LeadsPanel({
  actorName,
  onLog,
  onChanged,
}: {
  actorName: string | null;
  onLog: () => void;
  onChanged?: () => void;
}) {
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [attach, setAttach] = useState<LeadRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [justConverted, setJustConverted] = useState<string | null>(null);

  const load = useCallback(() => {
    return api<LeadRow[]>('/v1/competitions/leads')
      .then(setLeads)
      .catch(() => setLeads([]));
  }, []);
  useEffect(() => {
    void load();
    const onPing = () => void load();
    window.addEventListener(COMPETITION_EVENT, onPing);
    return () => window.removeEventListener(COMPETITION_EVENT, onPing);
  }, [load]);

  const act = async (lead: LeadRow, verb: 'follow-up' | 'lost', body?: unknown) => {
    setBusy(`${verb}:${lead.id}`);
    try {
      const updated = await api<LeadRow>(`/v1/competitions/leads/${lead.id}/${verb}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      setLeads((ls) => (ls ?? []).map((l) => (l.id === updated.id ? updated : l)));
      if (verb === 'follow-up') {
        toast(`Follow-up noted for ${lead.name} · reminder tomorrow 10 AM`);
      } else {
        toast(`${lead.name} marked lost`);
      }
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  };

  const open = (leads ?? []).filter((l) => l.status === 'open');
  const converted = (leads ?? []).filter((l) => l.status === 'converted');
  const monthAgo = Date.now() - 31 * 86_400_000;
  const logged = (leads ?? []).filter((l) => Date.parse(l.loggedAt) >= monthAgo);
  const convertedRecent = converted.filter((l) => Date.parse(l.loggedAt) >= monthAgo);

  return (
    <section className="panel leads" data-testid="leads-panel">
      <div className="panel-head">
        <h2>My leads</h2>
        <span className="panel-sub">
          {leads == null
            ? '…'
            : `${convertedRecent.length} converted of ${logged.length} logged · ${open.length} open`}
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="primary" onClick={onLog} data-testid="leads-log">
          + Log lead
        </Button>
      </div>
      {leads == null ? (
        <ShimmerRows rows={3} />
      ) : leads.length === 0 ? (
        <div className="leads-empty">
          No leads logged yet. Log the next customer who walks out without buying.
        </div>
      ) : (
        <div className="leads-scroll">
          <table className="dt leads-table">
            <thead>
              <tr>
                <th className="first">Customer</th>
                <th>Wanted</th>
                <th>Logged</th>
                <th>Status</th>
                <th className="last" />
              </tr>
            </thead>
            <tbody>
              {leads.slice(0, 30).map((l) => (
                <tr
                  key={l.id}
                  className={justConverted === l.id ? 'is-converted' : ''}
                  data-testid="lead-row"
                  data-status={l.status}
                >
                  <td className="first">
                    <span style={{ fontWeight: 500 }}>{l.name}</span>
                    <div className="sub mono">{l.phone}</div>
                  </td>
                  <td>{l.wanted}</td>
                  <td>
                    <span className="mono">
                      {new Date(l.loggedAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    {l.status === 'open' && (
                      <div className="sub">
                        {l.daysLeft === 0 ? 'expires today' : `${l.daysLeft}d left`}
                      </div>
                    )}
                    {l.followUpAt && l.status === 'open' && (
                      <div className="sub">
                        follow up{' '}
                        {new Date(l.followUpAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </div>
                    )}
                  </td>
                  <td>
                    {l.status === 'open' ? (
                      <StatusChip status="waiting" label="Open" />
                    ) : l.status === 'converted' ? (
                      <span className="leads-conv">
                        <StatusChip status="fulfilled" label="Converted" />
                        {l.convertedOrderId && (
                          <Link href={`/orders/${l.convertedOrderId}`} className="mono panel-link">
                            {l.convertedOrderNumber}
                          </Link>
                        )}
                        {l.conversion === 'manual' && <span className="sub">by hand</span>}
                      </span>
                    ) : (
                      <StatusChip status="cancelled" label="Lost" />
                    )}
                  </td>
                  <td className="last leads-actions" data-noprint="true">
                    {l.status === 'open' && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy != null}
                          onClick={() => void act(l, 'follow-up')}
                          data-testid="lead-follow-up"
                        >
                          Follow up
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy != null}
                          onClick={() => setAttach(l)}
                          data-testid="lead-attach"
                        >
                          Attach order
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy != null}
                          onClick={() => void act(l, 'lost')}
                          data-testid="lead-lost"
                        >
                          Lost
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-foot leads-foot">
        A lead converts on its own when a completed order under your name matches the phone within
        30 days. Attaching by hand is written to the audit log.
      </div>
      {attach && (
        <AttachDialog
          lead={attach}
          actorName={actorName}
          onClose={() => setAttach(null)}
          onDone={(updated) => {
            setLeads((ls) => (ls ?? []).map((l) => (l.id === updated.id ? updated : l)));
            setJustConverted(updated.id);
            window.setTimeout(() => setJustConverted(null), 1200);
            toast.success(
              `${updated.name} converted — attached ${updated.convertedOrderNumber ?? 'the order'} by hand · written to the audit log · Lead Conversion +1`,
            );
            pingCompetition();
            onChanged?.();
            setAttach(null);
          }}
        />
      )}
    </section>
  );
}

function AttachDialog({
  lead,
  actorName,
  onClose,
  onDone,
}: {
  lead: LeadRow;
  actorName: string | null;
  onClose: () => void;
  onDone: (lead: LeadRow) => void;
}) {
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const go = async () => {
    if (!number.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<LeadRow>(`/v1/competitions/leads/${lead.id}/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: number.trim() }),
      });
      onDone(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That order could not be attached.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Attach an order to ${lead.name}`}
      description={`The order has to be written under ${actorName ?? 'you'}. Attaching by hand goes to the audit log with your name.`}
      onClose={onClose}
      size="sm"
      initialFocus={ref}
      testId="lead-attach-dialog"
      foot={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !number.trim()}
            onClick={() => void go()}
            data-testid="lead-attach-confirm"
          >
            {busy ? 'Attaching…' : 'Attach order'}
          </Button>
        </>
      }
    >
      <Field label="Order number" error={error}>
        <Input
          ref={ref}
          className="input-mono"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="GL-10452"
          data-testid="lead-attach-number"
          onKeyDown={(e) => e.key === 'Enter' && void go()}
        />
      </Field>
    </Dialog>
  );
}
