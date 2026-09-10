'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { errorText } from './dialog';
import type { ActionLine, ActionOrder, OpsLists } from './types';
import { CustomerDialog, type EditableCustomer } from './customer-dialog';
import { OrderHeaderDialog } from './header-dialog';
import {
  AttachmentsDialog,
  CustomInfoDialog,
  FeesDialog,
  LineDetailsDialog,
  MultiLineDiscountDialog,
  NotesDialog,
  SplitLineDialog,
  TradeDesignerDialog,
} from './edit-dialogs';
import {
  CommissionTableDialog,
  CostedLinesDialog,
  LineStockDialog,
  LinkedDocsDialog,
  OrderDiscountsDialog,
  ProductBenefitsDialog,
  TaxInfoDialog,
} from './read-dialogs';

type Dialog =
  | { kind: 'header' }
  | { kind: 'customer' }
  | { kind: 'fees' }
  | { kind: 'tax' }
  | { kind: 'notes'; notes: 'internal' | 'exception' | 'printed' }
  | { kind: 'custom-info' }
  | { kind: 'trade' }
  | { kind: 'attachments' }
  | { kind: 'line-details'; lineId?: string }
  | { kind: 'multi-discount' }
  | { kind: 'split-line'; lineId?: string }
  | { kind: 'costed' }
  | { kind: 'commission' }
  | { kind: 'linked'; focus?: 'transfers' | 'pos' | string }
  | { kind: 'stock'; lineId?: string }
  | { kind: 'product'; lineId?: string }
  | { kind: 'discounts' };

export interface ActionsMenuProps {
  order: ActionOrder;
  lines: ActionLine[];
  customer: EditableCustomer | null;
  locations: { id: string; name: string }[];
  lists: OpsLists;
  /** Live and unlocked: money edits allowed. */
  editable: boolean;
  /** Live (may be locked): metadata edits allowed. */
  live: boolean;
  attachmentCount: number;
  advanced: boolean;
  onToggleAdvanced: () => void;
  costed: boolean;
  onToggleCosted: () => void;
  onChanged: () => Promise<void>;
  onAttachmentsChanged: (count: number) => void;
  /** Opens the change-history + notes cards. */
  onAuditLog: () => void;
  onPrint: (scope: 'order' | 'family') => void;
}

interface Item {
  label: string;
  run: () => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
}

/**
 * The STORIS "Enter a Sales Order" Actions menu (both of them), merged and
 * grouped. Every item maps to a dialog, a card on the page, or a document
 * (PLAN-POS-OPERATIONS §12.16 table).
 */
export function OrderActionsMenu(props: ActionsMenuProps) {
  const { order, lines, customer, editable, live } = props;
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const go = (d: Dialog) => {
    setOpen(false);
    setDialog(d);
  };
  const hasStock = lines.some((l) => l.variantId);
  const needsEdit = editable ? undefined : 'Order is locked or finished';
  const needsLive = live ? undefined : 'Order is finished';

  async function removeOverrides() {
    setOpen(false);
    if (
      !confirm(
        'Restore the catalog price on every line and remove every discount (order and lines)? This is logged.',
      )
    )
      return;
    try {
      const r = await api<{ restored: number }>(`/v1/orders/${order.id}/remove-overrides`, {
        method: 'POST',
      });
      await props.onChanged();
      toast.success(
        r.restored === 0
          ? 'Nothing to restore'
          : `Restored ${r.restored} price${r.restored === 1 ? '' : 's'} / discounts`,
      );
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const groups: { title: string; items: Item[] }[] = [
    {
      title: 'Order',
      items: [
        {
          label: 'Additional Order Detail',
          run: () => go({ kind: 'header' }),
          disabled: false,
          testId: 'act-order-detail',
        },
        {
          label: 'Additional Comments',
          run: () => go({ kind: 'notes', notes: 'internal' }),
          testId: 'act-comments',
        },
        {
          label: 'Audit Comments Log',
          run: () => {
            setOpen(false);
            props.onAuditLog();
          },
          testId: 'act-audit',
        },
        {
          label: 'Miscellaneous Fees',
          run: () => go({ kind: 'fees' }),
          disabled: !editable,
          title: needsEdit,
          testId: 'act-fees',
        },
        { label: 'Order Source Entry', run: () => go({ kind: 'header' }) },
        { label: 'Order Tax Information', run: () => go({ kind: 'tax' }), testId: 'act-tax' },
        { label: 'Assign Payment Terminal', run: () => go({ kind: 'header' }) },
        {
          label: 'Custom Order Information',
          run: () => go({ kind: 'custom-info' }),
          testId: 'act-custom-info',
        },
        {
          label: 'Trade/Designer Information',
          run: () => go({ kind: 'trade' }),
          testId: 'act-trade',
        },
        {
          label: 'View/Edit Exception Comments',
          run: () => go({ kind: 'notes', notes: 'exception' }),
          testId: 'act-exception',
        },
        {
          label: 'View Signature',
          run: () => {
            setOpen(false);
            toast.info(
              'Signature capture is phase 3 — the signature line is on the printed delivery ticket.',
            );
          },
        },
      ],
    },
    {
      title: 'Customer',
      items: [
        {
          label: 'Enter Customer Name',
          run: () => go({ kind: 'customer' }),
          disabled: !customer,
          testId: 'act-customer',
        },
        {
          label: 'Update a Customer Address',
          run: () => go({ kind: 'customer' }),
          disabled: !customer,
        },
      ],
    },
    {
      title: 'Merchandise',
      items: [
        {
          label: 'Additional Line Item Details',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
          testId: 'act-line-details',
        },
        {
          label: 'Line Comments',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
        },
        {
          label: 'Assign Rooms to Order',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
        },
        {
          label: 'Assign Pieces',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
        },
        {
          label: 'Prep Codes',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
        },
        {
          label: "Customer's Own Material (COM)",
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
        },
        {
          label: 'Direct Ship Details',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || !lines.some((l) => l.lineType === 'direct_ship'),
          title: 'Needs a direct-ship line',
        },
        {
          label: 'Convert Line to Direct Ship',
          run: () => {
            setOpen(false);
            toast.info('Use the Type column on the Lines card to flip a line to direct ship.');
          },
          disabled: !editable,
          title: needsEdit,
        },
        {
          label: 'Maintain Linked Installation Line',
          run: () => go({ kind: 'line-details' }),
          disabled: !live || lines.length === 0,
          title: needsLive,
        },
        {
          label: 'Enter a Discount on Multiple Lines',
          run: () => go({ kind: 'multi-discount' }),
          disabled: !editable || lines.length === 0,
          title: needsEdit,
          testId: 'act-multi-discount',
        },
        {
          label: 'Group Pricing',
          run: () => go({ kind: 'multi-discount' }),
          disabled: !editable || lines.length === 0,
          title: needsEdit,
        },
        {
          label: 'Remove All Price Overrides and Discounts',
          run: () => void removeOverrides(),
          disabled: !editable,
          title: needsEdit,
          testId: 'act-remove-overrides',
        },
        {
          label: 'Split Merchandise Lines',
          run: () => go({ kind: 'split-line' }),
          disabled: !editable || !lines.some((l) => l.quantity > 1),
          title: editable ? 'Needs a line with quantity 2+' : needsEdit,
          testId: 'act-split-line',
        },
        {
          label: 'Line Stock Availability',
          run: () => go({ kind: 'stock' }),
          disabled: !hasStock,
          testId: 'act-stock',
        },
        {
          label: 'Product Benefit Inquiry',
          run: () => go({ kind: 'product' }),
          disabled: !hasStock,
          testId: 'act-product',
        },
        {
          label: 'Protection Plan Selection',
          run: () => {
            setOpen(false);
            toast.info('Protection plans are phase 2 (A20 D8).');
          },
        },
        {
          label: 'Extended Warranty Detail',
          run: () => {
            setOpen(false);
            toast.info('Protection plans are phase 2 (A20 D8).');
          },
        },
        {
          label: props.advanced
            ? 'Toggle Line Display (compact)'
            : 'Toggle Line Display (advanced)',
          run: () => {
            setOpen(false);
            props.onToggleAdvanced();
          },
          testId: 'act-toggle-display',
        },
        {
          label: 'Advanced Line Item Display',
          run: () => {
            setOpen(false);
            if (!props.advanced) props.onToggleAdvanced();
          },
        },
        {
          label: props.costed ? 'Costed Line Item Display (hide)' : 'Costed Line Item Display',
          run: () => {
            setOpen(false);
            props.onToggleCosted();
          },
          testId: 'act-costed-toggle',
        },
        {
          label: 'Sales Margin Scratchpad',
          run: () => go({ kind: 'costed' }),
          testId: 'act-scratchpad',
        },
        {
          label: 'Price/Spiff/Commission Table',
          run: () => go({ kind: 'commission' }),
          testId: 'act-commission',
        },
        {
          label: 'Line Item Linked Document Display',
          run: () => go({ kind: 'linked' }),
          testId: 'act-linked',
        },
        { label: 'Purchase Order', run: () => go({ kind: 'linked', focus: 'pos' }) },
        { label: 'View Linked Transfers', run: () => go({ kind: 'linked', focus: 'transfers' }) },
        {
          label: 'View Order Discounts',
          run: () => go({ kind: 'discounts' }),
          testId: 'act-discounts',
        },
        {
          label: 'View Discount Schedule Applied to this Order',
          run: () => go({ kind: 'discounts' }),
        },
        {
          label: 'Start Automated Line Discounting',
          run: () => {
            setOpen(false);
            toast.info('Discount schedules are phase 2 (A20 D7).');
          },
        },
        {
          label: 'Suspend Automated Line Discounting',
          run: () => {
            setOpen(false);
            toast.info('Discount schedules are phase 2 (A20 D7).');
          },
        },
      ],
    },
    {
      title: 'Documents',
      items: [
        {
          label: 'Print Order',
          run: () => {
            setOpen(false);
            props.onPrint('order');
          },
          testId: 'act-print-order',
        },
        {
          label: 'Print Cumulative Sales Order',
          run: () => {
            setOpen(false);
            props.onPrint('family');
          },
          testId: 'act-print-family',
        },
        {
          label: `Add Attachments${props.attachmentCount ? ` (${props.attachmentCount})` : ''}`,
          run: () => go({ kind: 'attachments' }),
          testId: 'act-attachments',
        },
        { label: 'Edit Attachments', run: () => go({ kind: 'attachments' }) },
        { label: 'View Attachments', run: () => go({ kind: 'attachments' }) },
      ],
    },
  ];

  const reload = props.onChanged;
  return (
    <span className="relative" ref={ref}>
      <Button
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="order-actions-menu"
      >
        Actions <ChevronDown size={13} aria-hidden />
        {props.attachmentCount > 0 && (
          <span
            className="muted"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 4 }}
          >
            <Paperclip size={12} aria-hidden />
            {props.attachmentCount}
          </span>
        )}
      </Button>
      {open && (
        <div
          role="menu"
          data-testid="order-actions-list"
          style={{
            position: 'absolute',
            right: 0,
            top: '110%',
            zIndex: 30,
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))',
            gap: '0 16px',
            width: 'min(560px, 90vw)',
            maxHeight: '70vh',
            overflow: 'auto',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            padding: 8,
            textAlign: 'left',
          }}
        >
          {groups.map((g) => (
            <div key={g.title} style={{ breakInside: 'avoid', marginBottom: 6 }}>
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  padding: '6px 8px 2px',
                }}
              >
                {g.title}
              </div>
              {g.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  title={it.disabled ? it.title : undefined}
                  onClick={it.run}
                  data-testid={it.testId}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 0,
                    padding: '5px 8px',
                    fontSize: 13,
                    borderRadius: 6,
                    color: it.disabled ? 'var(--muted)' : 'inherit',
                    cursor: it.disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {dialog?.kind === 'header' && (
        <OrderHeaderDialog
          order={order}
          locations={props.locations}
          lists={props.lists}
          editable={editable}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog?.kind === 'customer' && customer && (
        <CustomerDialog
          order={order}
          customer={customer}
          orderEditable={editable}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog?.kind === 'fees' && (
        <FeesDialog order={order} onClose={() => setDialog(null)} onSaved={reload} />
      )}
      {dialog?.kind === 'tax' && <TaxInfoDialog order={order} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'notes' && (
        <NotesDialog
          order={order}
          kind={dialog.notes}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog?.kind === 'custom-info' && (
        <CustomInfoDialog order={order} onClose={() => setDialog(null)} onSaved={reload} />
      )}
      {dialog?.kind === 'trade' && (
        <TradeDesignerDialog order={order} onClose={() => setDialog(null)} onSaved={reload} />
      )}
      {dialog?.kind === 'attachments' && (
        <AttachmentsDialog
          order={order}
          lines={lines}
          canEdit={live}
          onClose={() => setDialog(null)}
          onChanged={props.onAttachmentsChanged}
        />
      )}
      {dialog?.kind === 'line-details' && (
        <LineDetailsDialog
          order={order}
          lines={lines}
          initialLineId={dialog.lineId}
          lists={props.lists}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog?.kind === 'multi-discount' && (
        <MultiLineDiscountDialog
          order={order}
          lines={lines}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog?.kind === 'split-line' && (
        <SplitLineDialog
          order={order}
          lines={lines}
          initialLineId={dialog.lineId}
          onClose={() => setDialog(null)}
          onSaved={reload}
        />
      )}
      {dialog?.kind === 'costed' && (
        <CostedLinesDialog order={order} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'commission' && (
        <CommissionTableDialog order={order} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'linked' && (
        <LinkedDocsDialog order={order} focus={dialog.focus} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'stock' && (
        <LineStockDialog
          order={order}
          lines={lines}
          initialLineId={dialog.lineId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'product' && (
        <ProductBenefitsDialog
          order={order}
          lines={lines}
          initialLineId={dialog.lineId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'discounts' && (
        <OrderDiscountsDialog
          order={order}
          onClose={() => setDialog(null)}
          onEdit={editable ? () => setDialog({ kind: 'multi-discount' }) : undefined}
        />
      )}
    </span>
  );
}
