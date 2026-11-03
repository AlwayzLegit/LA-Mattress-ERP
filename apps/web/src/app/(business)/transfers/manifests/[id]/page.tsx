'use client';

import Link from 'next/link';
import { toast } from 'sonner';
import { Printer, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Alert,
  BackLink,
  Button,
  Card,
  LinkButton,
  LoadingRows,
  PageHeader,
  Stack,
  StatusBadge,
  TableEmpty,
  TableWrap,
} from '@/components/ui';

interface ManifestTransfer {
  id: string;
  number: string;
  status: string;
  transferType: string;
  loadNumber: number | null;
  ticketPrintedAt: string | null;
  lineCount: number;
  unitCount: number;
}

interface Manifest {
  id: string;
  number: string;
  status: string;
  manifestDate: string;
  routeName: string | null;
  fromLocationName: string | null;
  toLocationName: string | null;
  notes: string | null;
  completedAt: string | null;
  transfers: ManifestTransfer[];
}

export default function ManifestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = (params?.id ?? '') as string;
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setM(await api<Manifest>(`/v1/stock-manifests/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/v1/stock-manifests/${id}${path}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const back = <BackLink href="/transfers/manifests">All manifests</BackLink>;

  if (error && !m) {
    return (
      <div>
        <PageHeader eyebrow={back} title="Manifest not found" />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }
  if (!m) return <LoadingRows rows={5} />;

  const isOpen = m.status === 'open';
  const unprinted = m.transfers.filter((t) => t.status === 'draft' && !t.ticketPrintedAt);
  const columns = isOpen ? 8 : 7;

  return (
    <div>
      <PageHeader
        eyebrow={back}
        title={<code>{m.number}</code>}
        meta={<StatusBadge status={m.status} />}
        sub={
          <>
            {m.fromLocationName ?? '—'} → <strong>{m.toLocationName ?? '—'}</strong> ·{' '}
            {m.manifestDate}
            {m.routeName && <> · {m.routeName}</>}
            {m.completedAt && <> · completed {new Date(m.completedAt).toLocaleString()}</>}
          </>
        }
        actions={
          <>
            <LinkButton
              href={`/print/manifests/${id}`}
              variant="secondary"
              size="sm"
              target="_blank"
            >
              <Printer size={13} aria-hidden /> Manifest document
            </LinkButton>
            {isOpen && (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Cancel this manifest? Transfers detach and stay open.')) {
                      void act('/cancel');
                    }
                  }}
                >
                  Cancel manifest
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => void act('/complete')}>
                  <Truck size={14} aria-hidden />
                  {busy ? 'Working…' : 'Complete manifest (ship the truck)'}
                </Button>
              </>
            )}
          </>
        }
      />

      <Stack>
        {isOpen && unprinted.length > 0 && (
          <Alert tone="warning" title="Print-before-ship gate">
            {unprinted.length} transfer{unprinted.length === 1 ? '' : 's'} still need a printed
            ticket before this manifest can complete.
          </Alert>
        )}

        <Card title={`Transfers (${m.transfers.length})`} flush>
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Load</th>
                  <th>Transfer</th>
                  <th>Type</th>
                  <th className="num">Lines</th>
                  <th className="num">Units</th>
                  <th>Ticket</th>
                  <th>Status</th>
                  {isOpen && <th className="actions" />}
                </tr>
              </thead>
              <tbody>
                {m.transfers.length === 0 && (
                  <TableEmpty colSpan={columns}>No transfers on this manifest.</TableEmpty>
                )}
                {m.transfers.map((t) => (
                  <tr key={t.id}>
                    <td className="num">{t.loadNumber ?? '—'}</td>
                    <td>
                      <Link href={`/transfers/${t.id}`}>
                        <code>{t.number}</code>
                      </Link>
                    </td>
                    <td>{t.transferType.replace('_', ' ')}</td>
                    <td className="num">{t.lineCount}</td>
                    <td className="num">{t.unitCount}</td>
                    <td>
                      {t.ticketPrintedAt ? 'printed' : <span className="muted">not printed</span>}
                    </td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    {isOpen && (
                      <td className="actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            const reason = window.prompt(
                              `Remove ${t.number} from this manifest — reason (recorded in the audit register):`,
                            );
                            if (reason === null) return;
                            void act('/remove-transfer', {
                              transferId: t.id,
                              reason: reason || null,
                            });
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>

        {m.notes && (
          <Card title="Notes">
            <p className="muted">{m.notes}</p>
          </Card>
        )}
      </Stack>
    </div>
  );
}
