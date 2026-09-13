'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, Printer } from 'lucide-react';
import { formatMoney } from '@jetnine/shared';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Button,
  Card,
  ColumnCells,
  type ColumnDef,
  ColumnHeadRow,
  Input,
  KeyValue,
  LoadingRows,
  PageHeader,
  ResetColumns,
  SectionHeading,
  Select,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
  Toolbar,
  useListColumns,
} from '@/components/ui';

/**
 * Service ticket detail (G6): the working view of one repair — charges
 * (parts from stock, free-text labor), the running note narrative,
 * status verbs, collecting the money, completion, and a printable view
 * (the page prints clean via the browser's print dialog).
 */

interface TicketLine {
  id: string;
  variantId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  kind: string;
}
interface TicketNote {
  id: string;
  body: string;
  createdAt: string;
}
interface Ticket {
  id: string;
  number: string;
  status: string;
  customerId: string;
  customerName: string | null;
  itemDescription: string | null;
  issue: string;
  warranty: boolean;
  serial: string | null;
  subtotalCents: number;
  totalCents: number;
  paidCents: number;
  balanceDueCents: number;
  completedAt: string | null;
  createdAt: string;
  lines: TicketLine[];
  notes: TicketNote[];
}
interface LookupRow {
  variantId: string;
  name: string;
  sku: string | null;
  priceCents: number;
}

const NEXT_STATUSES: Record<string, string[]> = {
  intake: ['awaiting_parts', 'in_service', 'cancelled'],
  awaiting_parts: ['in_service', 'intake', 'cancelled'],
  in_service: ['ready', 'awaiting_parts', 'cancelled'],
  ready: ['in_service'],
};

const CHARGE_COLUMNS: ColumnDef<TicketLine>[] = [
  {
    id: 'description',
    label: 'Description',
    sortValue: (l) => l.description,
    render: (l) => l.description,
  },
  {
    id: 'kind',
    label: 'Kind',
    cellClassName: () => 'muted',
    sortValue: (l) => l.kind,
    render: (l) => l.kind,
  },
  {
    id: 'qty',
    label: 'Qty',
    num: true,
    sortValue: (l) => l.quantity,
    render: (l) => `×${l.quantity}`,
  },
  {
    id: 'amount',
    label: 'Amount',
    num: true,
    sortValue: (l) => l.totalCents,
    render: (l) => formatMoney(l.totalCents),
  },
];

export default function ServiceTicketPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [partQ, setPartQ] = useState('');
  const [partHits, setPartHits] = useState<LookupRow[]>([]);
  const [laborDesc, setLaborDesc] = useState('');
  const [laborPrice, setLaborPrice] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const chargeCols = useListColumns('service-charges', CHARGE_COLUMNS, ticket?.lines ?? null);

  async function load() {
    try {
      setTicket(await api<Ticket>(`/v1/service-orders/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/service-orders/${id}${path}`, {
        method: 'POST',
        body: body === undefined ? '{}' : JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function searchParts(q: string) {
    setPartQ(q);
    if (q.trim().length < 2) {
      setPartHits([]);
      return;
    }
    try {
      setPartHits(await api<LookupRow[]>(`/v1/pos/lookup?q=${encodeURIComponent(q)}`));
    } catch {
      setPartHits([]);
    }
  }

  const eyebrow = <BackLink href="/service">Board</BackLink>;

  if (error && !ticket) {
    return (
      <div>
        <PageHeader title="Ticket not found" eyebrow={eyebrow} />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!ticket) {
    return (
      <div>
        <PageHeader title="Service ticket" eyebrow={eyebrow} />
        <LoadingRows rows={4} />
      </div>
    );
  }

  const live = !ticket.completedAt && ticket.status !== 'cancelled';

  return (
    <div>
      <PageHeader
        eyebrow={eyebrow}
        title={<span data-testid="ticket-number">{ticket.number}</span>}
        meta={
          <>
            <span data-testid="ticket-status" className="inline-flex">
              <StatusBadge status={ticket.status} />
            </span>
            {ticket.warranty && <span>warranty</span>}
          </>
        }
        sub={`${ticket.customerName ?? '—'} · opened ${new Date(ticket.createdAt).toLocaleString()}${
          ticket.serial ? ` · serial ${ticket.serial}` : ''
        }`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => window.print()}>
            <Printer size={14} aria-hidden />
            Print
          </Button>
        }
      />
      <Stack>
        {error && <Alert tone="error">{error}</Alert>}

        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Stack className="min-w-0">
            <Card title="Item & issue">
              <KeyValue
                rows={[
                  { label: 'Item', value: <strong>{ticket.itemDescription ?? 'Item'}</strong> },
                  { label: 'Issue', value: ticket.issue },
                ]}
              />
            </Card>

            <Card title="Charges">
              <Stack>
                <TableWrap>
                  <table className="table">
                    <thead>
                      <ColumnHeadRow list={chargeCols} testIdPrefix="service-charges" />
                    </thead>
                    <tbody>
                      {ticket.lines.length === 0 && (
                        <TableEmpty colSpan={chargeCols.ordered.length}>
                          {live ? 'No charges yet — add a part or labor below.' : 'No charges.'}
                        </TableEmpty>
                      )}
                      {chargeCols.sorted.map((l) => (
                        <tr key={l.id}>
                          <ColumnCells list={chargeCols} row={l} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ResetColumns list={chargeCols} />
                </TableWrap>
                {live && (
                  <>
                    <SectionHeading as="h3" title="Add a part from stock" />
                    {/* A <div>, not a <label>: the result buttons must not sit
                        inside a label whose activation would re-target. */}
                    <div className="field">
                      <Input
                        value={partQ}
                        onChange={(e) => void searchParts(e.target.value)}
                        placeholder="Search SKU or name…"
                        aria-label="Add part from stock — search SKU or name"
                        data-testid="part-search"
                      />
                      {partHits.length > 0 && (
                        <div className="typeahead">
                          {partHits.slice(0, 6).map((p) => (
                            <button
                              key={p.variantId}
                              type="button"
                              onClick={() => {
                                setPartQ('');
                                setPartHits([]);
                                void act('/lines', { variantId: p.variantId, kind: 'part' });
                              }}
                              className="popover-option"
                            >
                              {p.name} {p.sku ? `(${p.sku})` : ''} — {formatMoney(p.priceCents)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <SectionHeading as="h3" title="Add labor" />
                    <Toolbar>
                      <Input
                        value={laborDesc}
                        onChange={(e) => setLaborDesc(e.target.value)}
                        placeholder="Labor description"
                        aria-label="Labor description"
                        data-testid="labor-desc"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        value={laborPrice}
                        onChange={(e) => setLaborPrice(e.target.value)}
                        placeholder="0.00"
                        aria-label="Labor price"
                        data-testid="labor-price"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          const cents = Math.round(Number(laborPrice || '0') * 100);
                          if (!laborDesc.trim()) return;
                          void act('/lines', {
                            description: laborDesc.trim(),
                            unitPriceCents: cents,
                          }).then(() => {
                            setLaborDesc('');
                            setLaborPrice('');
                          });
                        }}
                        disabled={busy || !laborDesc.trim()}
                        data-testid="add-labor"
                      >
                        Add labor
                      </Button>
                    </Toolbar>
                  </>
                )}
              </Stack>
            </Card>

            <Card title="Notes">
              <Stack gap="sm">
                {ticket.notes.length === 0 && <p className="muted m-0">No notes yet.</p>}
                {ticket.notes.map((n) => (
                  <div key={n.id}>
                    <span className="muted">{new Date(n.createdAt).toLocaleString()}</span> —{' '}
                    {n.body}
                  </div>
                ))}
                {live && (
                  <Toolbar>
                    <Input
                      value={noteBody}
                      onChange={(e) => setNoteBody(e.target.value)}
                      placeholder="Add a note…"
                      aria-label="Add a note"
                      data-testid="note-body"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (!noteBody.trim()) return;
                        void act('/notes', { body: noteBody.trim() }).then(() => setNoteBody(''));
                      }}
                      disabled={busy || !noteBody.trim()}
                    >
                      Add
                    </Button>
                  </Toolbar>
                )}
              </Stack>
            </Card>
          </Stack>

          <Stack className="min-w-0">
            <Card title="Money">
              <Stack>
                <KeyValue
                  rows={[
                    { label: 'Total', value: formatMoney(ticket.totalCents) },
                    { label: 'Paid', value: formatMoney(ticket.paidCents) },
                    {
                      label: <strong>Balance due</strong>,
                      value: (
                        <strong data-testid="ticket-balance">
                          {formatMoney(ticket.balanceDueCents)}
                        </strong>
                      ),
                    },
                  ]}
                />
                {live && ticket.balanceDueCents > 0 && (
                  <Toolbar>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      placeholder={(ticket.balanceDueCents / 100).toFixed(2)}
                      aria-label="Payment amount"
                      data-testid="ticket-pay-amount"
                    />
                    <Select
                      value={payMethod}
                      onChange={(e) => setPayMethod(e.target.value)}
                      aria-label="Payment method"
                    >
                      {['cash', 'card', 'external_card', 'check', 'financing'].map((m) => (
                        <option key={m} value={m}>
                          {m.replace('_', ' ')}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        const cents = Math.round(Number(payAmount) * 100);
                        if (!Number.isFinite(cents) || cents <= 0) return;
                        void act('/payments', { method: payMethod, amountCents: cents }).then(() =>
                          setPayAmount(''),
                        );
                      }}
                      disabled={busy}
                      data-testid="ticket-take-payment"
                    >
                      Collect
                    </Button>
                  </Toolbar>
                )}
              </Stack>
            </Card>

            <Card title="Actions">
              {live ? (
                <Stack gap="sm">
                  {(NEXT_STATUSES[ticket.status] ?? []).map((s) => (
                    <Button
                      key={s}
                      variant={s === 'cancelled' ? 'danger' : 'secondary'}
                      onClick={() => void act('/status', { status: s })}
                      disabled={busy}
                      data-testid={`status-${s}`}
                    >
                      {s === 'cancelled' ? 'Cancel ticket' : `Mark ${s.replace('_', ' ')}`}
                    </Button>
                  ))}
                  {ticket.status === 'ready' && (
                    <Button
                      variant="primary"
                      onClick={() => void act('/complete')}
                      disabled={busy || ticket.balanceDueCents > 0}
                      data-testid="complete-ticket"
                      title={
                        ticket.balanceDueCents > 0 ? 'Collect the balance first' : 'Hand it back'
                      }
                    >
                      <CheckCircle2 size={14} aria-hidden />
                      Complete — picked up
                    </Button>
                  )}
                </Stack>
              ) : (
                <p className="muted m-0">
                  {ticket.completedAt
                    ? `Completed ${new Date(ticket.completedAt).toLocaleString()}`
                    : 'Cancelled'}
                </p>
              )}
            </Card>
          </Stack>
        </div>
      </Stack>
    </div>
  );
}
