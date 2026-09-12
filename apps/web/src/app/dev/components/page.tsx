'use client';

import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Kbd,
  LinkButton,
  LoadingRows,
  RowLink,
  Select,
  Skeleton,
  SlideOver,
  SortHeader,
  StatusBadge,
  StatusChip,
  TableWrap,
  type SortDir,
} from '@/components/ui';
import { STATUSES } from '@/lib/design-tokens';

/**
 * `/dev/components` — every kit part in every state, canvas 2e. Static
 * except for the dialogs, toasts and the skeleton → error handoff.
 */
export default function ComponentsPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        padding: '40px clamp(16px, 4vw, 56px) 64px',
      }}
    >
      <div style={{ maxWidth: 1328, margin: '0 auto' }}>
        <header style={{ marginBottom: 32 }}>
          <div className="t-mono-sm" style={{ color: 'var(--muted)', letterSpacing: '0.04em' }}>
            LA MATTRESS ERP · REDESIGN · PHASE 2
          </div>
          <h1 className="t-display-l" style={{ margin: '6px 0 0' }}>
            Components
          </h1>
          <p className="t-body" style={{ color: 'var(--muted)', margin: '6px 0 0', maxWidth: 640 }}>
            Management density shown first; the register block is the same parts at 44px rows and
            38px controls. Tab through anything — the focus ring is never removed.
          </p>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
            gap: '32px 40px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            padding: 'clamp(20px, 3vw, 40px) clamp(20px, 3vw, 56px)',
          }}
        >
          <Buttons />
          <TableDemo />
          <Dialogs />
          <Fields />
          <Chips />
          <States />
          <Section label="Register density · same parts, 44 / 14 / 38" wide>
            <div data-density="register">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) 316px',
                  gap: 16,
                  alignItems: 'start',
                }}
              >
                <TableRows />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Field label="Customer">
                    <Input placeholder="Name or phone" />
                  </Field>
                  <Button variant="primary" kbd="F8">
                    Take payment
                  </Button>
                  <Button kbd="F2">Add product</Button>
                </div>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}

function Section({
  label,
  children,
  wide,
  style,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <section style={{ ...(wide ? { gridColumn: '1 / -1' } : null), ...style }}>
      <h2
        className="t-mono-sm"
        style={{
          margin: '0 0 10px',
          color: 'var(--muted)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontWeight: 400,
        }}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
      {children}
    </p>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
    </div>
  );
}

function Buttons() {
  return (
    <Section label="Buttons · four tiers, destructive is never filled beside primary">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row>
          <Button variant="primary">Take payment</Button>
          <Button>Save draft</Button>
          <Button variant="ghost">Print</Button>
          <span style={{ flex: '1 0 16px' }} />
          <Button variant="destructive">Cancel order</Button>
        </Row>
        <Row>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="primary" kbd="F8">
            Take payment
          </Button>
          <Button kbd="mod+k">Search</Button>
          <Button size="sm">Small</Button>
          <LinkButton href="/dev/tokens" variant="ghost">
            Link button
          </LinkButton>
        </Row>
      </div>
      <Note>
        The audit found Cancel and Complete at equal weight. Destructive is an outlined red tier,
        never the default focus, and never adjacent to primary.
      </Note>
    </Section>
  );
}

function Fields() {
  return (
    <Section label="Form field · label always visible">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Customer phone">
          <Input className="input-mono" defaultValue="(818) 555-0142" />
        </Field>
        <Field label="Store">
          <Select defaultValue="glendale">
            <option value="glendale">Glendale — this store</option>
            <option value="ktown">Koreatown</option>
          </Select>
        </Field>
        <Field label="Email" error="Needs a domain — e.g. omar@gmail.com">
          <Input defaultValue="omar@" aria-invalid />
        </Field>
        <Field label="Price" hint="Inline edit, no approval">
          <Input className="input-num" defaultValue="1,299.00" />
        </Field>
        <Field label="Notes" hint="Optional" className="form-span">
          <textarea className="textarea" rows={2} defaultValue="Leave at side gate." />
        </Field>
      </div>
    </Section>
  );
}

const ROWS = [
  { n: 'SO-10437', c: 'Omar Haddad', s: 'scheduled', b: '$1,240.00' },
  { n: 'SO-10412', c: 'Karen Liu', s: 'waiting', b: '$0.00' },
  { n: 'SO-10398', c: 'Dana Wu', s: 'risk', b: '$2,199.00' },
] as const;

function TableRows() {
  const [sort, setSort] = useState<{ id: string; dir: SortDir }>({ id: 'order', dir: 'asc' });
  const onSort = (id: string) =>
    setSort((s) => ({ id, dir: s.id === id && s.dir === 'asc' ? 'desc' : 'asc' }));
  return (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <SortHeader id="order" active={sort.id === 'order'} dir={sort.dir} onSort={onSort}>
              Order
            </SortHeader>
            <SortHeader
              id="customer"
              active={sort.id === 'customer'}
              dir={sort.dir}
              onSort={onSort}
            >
              Customer
            </SortHeader>
            <th>Status</th>
            <SortHeader
              id="balance"
              active={sort.id === 'balance'}
              dir={sort.dir}
              onSort={onSort}
              align="right"
            >
              Balance
            </SortHeader>
            <th className="actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.n}>
              <td>
                <RowLink href={`/dev/components#${r.n}`}>{r.n}</RowLink>
              </td>
              <td>{r.c}</td>
              <td>
                <StatusChip status={r.s} />
              </td>
              <td className="num mono">{r.b}</td>
              <td className="actions">
                <Button size="sm" variant="ghost" className="row-action">
                  Print
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function TableDemo() {
  return (
    <Section label="Table row · 36px · every row is a link · sortable headers carry aria-sort">
      <TableRows />
      <Note>
        The anchor in the first column takes keyboard focus; its overlay makes the whole row
        clickable. Buttons in the row sit above the overlay. Click a header to sort.
      </Note>
    </Section>
  );
}

function Chips() {
  return (
    <Section label="Status chip · colour + glyph + word, always together">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row>
          {STATUSES.map((s) => (
            <StatusChip key={s.key} status={s.key} />
          ))}
        </Row>
        <Row>
          <StatusChip status="waiting" label="Waiting on PO-4471" />
          <StatusChip status="scheduled" label="Scheduled · Sep 6" />
        </Row>
        <div className="t-mono-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>
          LEGACY LIFECYCLE STRINGS · SAME ANATOMY
        </div>
        <Row>
          {['draft', 'open', 'partially_fulfilled', 'fulfilled', 'overdue', 'cancelled'].map(
            (s) => (
              <StatusBadge key={s} status={s} />
            ),
          )}
        </Row>
      </div>
    </Section>
  );
}

function Dialogs() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sheet, setSheet] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  return (
    <Section label="Dialog · slide-over · toast — traps focus, esc closes, focus returns">
      <Row>
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button onClick={() => setConfirm(true)}>Open confirmation</Button>
        <Button onClick={() => setSheet(true)}>Open slide-over</Button>
      </Row>
      <Row>
        <span style={{ marginTop: 8 }} />
      </Row>
      <Row>
        <Button
          size="sm"
          onClick={() =>
            toast.success('SO-10437 saved · payment $500.00 recorded', {
              action: { label: 'Undo', onClick: () => toast('Payment reversed') },
            })
          }
        >
          Success toast
        </Button>
        <Button size="sm" onClick={() => toast.error('Card declined — try another tender')}>
          Error toast
        </Button>
        <Button size="sm" onClick={() => toast.warning('Only 1 left at Glendale')}>
          Warning toast
        </Button>
        <Button size="sm" onClick={() => toast.info('Delivery moved to Tuesday')}>
          Info toast
        </Button>
      </Row>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12, fontSize: 13 }}>
        <span>
          Search <Kbd keys="mod+k" /> <span style={{ color: 'var(--muted)' }}>(this machine)</span>
        </span>
        <span>
          Add product <Kbd keys="F2" />
        </span>
        <span>
          Close <Kbd keys="esc" />
        </span>
        <span>
          Chord <Kbd keys="g o" />
        </span>
      </div>
      <Note>
        Toasts live 2.4s, pause on hover, and carry a left rule in the status colour. Shortcut chips
        render ⌘ on a Mac and Ctrl on the Windows registers.
      </Note>

      {dialog && (
        <Dialog
          title="Add a delivery note"
          description="Drivers see this on the day sheet."
          onClose={() => setDialog(false)}
          initialFocus={search}
          foot={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDialog(false);
                  toast.success('Note saved');
                }}
              >
                Save note
              </Button>
            </>
          }
        >
          <Field label="Note">
            <Input ref={search} placeholder="Gate code, dog, second floor…" />
          </Field>
        </Dialog>
      )}
      {confirm && (
        <Dialog
          alert
          size="sm"
          hideClose
          title="Cancel SO-10437?"
          description="The $500.00 deposit becomes store credit for Omar Haddad. Two reserved units return to Warehouse stock. This is written to the change history."
          onClose={() => setConfirm(false)}
          initialFocus={keep}
          foot={
            <>
              <Button ref={keep} onClick={() => setConfirm(false)}>
                Keep order
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirm(false);
                  toast('SO-10437 cancelled');
                }}
              >
                Cancel order
              </Button>
            </>
          }
        >
          <Field label="Reason">
            <Select defaultValue="">
              <option value="" disabled>
                Choose a reason
              </option>
              <option>Customer changed mind</option>
              <option>Duplicate order</option>
              <option>Could not fulfil</option>
            </Select>
          </Field>
        </Dialog>
      )}
      {sheet && (
        <SlideOver
          mono
          title="SO-10437"
          meta={
            <>
              <StatusChip status="scheduled" />
              <span>Omar Haddad · Glendale · written Sep 2 by Priya</span>
            </>
          }
          onClose={() => setSheet(false)}
          foot={
            <>
              <Button variant="primary">Take payment</Button>
              <Button>Edit lines</Button>
              <Button variant="destructive" style={{ marginLeft: 'auto' }}>
                Cancel order
              </Button>
            </>
          }
        >
          <p className="t-body" style={{ margin: 0, color: 'var(--text-2)' }}>
            The order slide-over lands in Phase 6. This one only proves the sheet: 640px, slides in
            over 160ms, traps focus, closes on Esc and returns focus to the button that opened it.
          </p>
        </SlideOver>
      )}
    </Section>
  );
}

function States() {
  const [run, setRun] = useState(0);
  const [failed, setFailed] = useState(false);
  return (
    <Section label="Empty · skeleton (4s → error) · error with retry">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <EmptyState
          title="No deliveries on Sunday Sep 7"
          action={
            <Button size="sm" onClick={() => toast.info('Would open the scheduler')}>
              Schedule one
            </Button>
          }
        >
          Drop a card here, or schedule one.
        </EmptyState>

        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span className="t-mono-sm" style={{ color: 'var(--muted)' }}>
              LOADING ROWS · BUDGET 4S
            </span>
            <Button size="sm" variant="ghost" onClick={() => setRun((n) => n + 1)}>
              Restart
            </Button>
          </div>
          <LoadingRows
            key={run}
            rows={3}
            what="This demo"
            onRetry={() => {
              setRun((n) => n + 1);
              toast.info('Retrying…');
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Skeleton style={{ height: 14, width: 180 }} />
          <Skeleton style={{ height: 14, width: 120 }} />
        </div>

        <ErrorState
          title="The register could not reach the server"
          onRetry={() => {
            setFailed(true);
            toast.info('Retried');
          }}
          retryIn={failed ? undefined : 30}
        >
          Your draft is kept on this machine. Retry in a moment, or keep writing — items will save
          when the connection is back.
        </ErrorState>
      </div>
    </Section>
  );
}
