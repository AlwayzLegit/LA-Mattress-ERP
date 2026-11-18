'use client';

import { Fragment } from 'react';
import { formatMoney, formatPhone } from '@jetnine/shared';
import { useBusinessName } from '@/lib/business-settings';
import { Barcode39 } from '@/components/order-documents';

export interface PrintablePoLine {
  productName: string;
  variantName: string | null;
  sku: string | null;
  /** Vendor's part number — what the vendor document leads with. */
  vendorSku: string | null;
  quantityOrdered: number;
  unitCostCents: number;
  lineTotalCents: number;
  /** §6: units on this line bought for specific customer orders. */
  linkedOrders?: {
    orderId: string;
    orderNumber: string;
    quantity: number;
    customerName?: string | null;
  }[];
}

export interface PrintablePo {
  number: string;
  createdAt: string;
  placedAt?: string | null;
  expectedAt: string | null;
  vendorName: string | null;
  vendorContactName: string | null;
  vendorEmail: string | null;
  vendorPhone: string | null;
  /** Owner 2026-11-17: the Vendor box prints the vendor's address. */
  vendorAddressJson?: unknown;
  locationName: string | null;
  /** The receiving location — letterhead and Ship To address. */
  locationAddressJson?: unknown;
  /** Letterhead name (branding public name, else the business name). */
  businessName?: string | null;
  notes: string | null;
  subtotalCents: number;
  freightCents?: number | null;
  /** PO-060: vendor ships straight to the customer named in shipToJson. */
  directShip?: boolean;
  shipToJson?: unknown;
  lines: PrintablePoLine[];
}

/**
 * Address lines out of an address JSON: the structured shape stores
 * and vendors use ({line1, line2, city, region|state, postalCode|zip}),
 * else any string values in order (older direct-ship snapshots).
 */
export function poAddressLines(value: unknown): string[] {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return [];
  if (typeof first === 'string') return [first];
  if (typeof first !== 'object') return [];
  const a = first as Record<string, unknown>;
  const s = (k: string) =>
    typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null;
  if (s('line1') || s('city')) {
    const region = s('region') ?? s('state');
    const zip = s('postalCode') ?? s('postal') ?? s('zip');
    const cityLine = [s('city'), [region, zip].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');
    return [s('line1'), s('line2'), cityLine].filter((x): x is string => Boolean(x));
  }
  return Object.entries(a)
    .filter(([k]) => k !== 'phone' && k !== 'label')
    .map(([, v]) => v)
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .filter((x) => x.trim().length > 0);
}

function addressPhone(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== 'object') return null;
  const p = (first as Record<string, unknown>).phone;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
}

/**
 * Vendor-facing purchase-order document, laid out like the STORIS PO
 * (owner 2026-11-17): letterhead top left, barcode and the boxed PO
 * number / dates top right, tabbed Vendor and Ship To boxes, a Ship
 * Via / Terms / Remarks strip, the grey-headed line grid (Model,
 * Vendor Model, Description, Qty, Price, Amount) with "Reserved for
 * Order # …, CUSTOMER" under lines bought for a sale, and the totals.
 *
 * `mode="hidden"` (the PO page): invisible on screen, `@media print`
 * shows only this element. `mode="page"` (the batch print page): shown
 * on screen and printed in normal flow, one page per PO.
 */
export function PrintablePurchaseOrder({
  po,
  mode = 'hidden',
}: {
  po: PrintablePo;
  mode?: 'hidden' | 'page';
}) {
  const fallbackName = useBusinessName();
  const businessName = po.businessName ?? fallbackName ?? '';
  const letterhead = poAddressLines(po.locationAddressJson);
  const letterheadPhone = addressPhone(po.locationAddressJson);
  const vendorLines = poAddressLines(po.vendorAddressJson);
  const totalQty = po.lines.reduce((n, l) => n + l.quantityOrdered, 0);
  const freight = po.freightCents ?? 0;
  const shipTo = (po.shipToJson ?? {}) as {
    name?: string | null;
    phone?: string | null;
    address?: unknown;
    orderNumber?: string | null;
  };

  return (
    <div data-printable className={`po-doc po-doc--${mode}`} data-testid="po-document">
      <style>{PO_CSS}</style>

      <header className="po-top">
        <div className="po-letterhead">
          <div>{businessName.toUpperCase()}</div>
          {letterhead.map((line) => (
            <div key={line}>{line.toUpperCase()}</div>
          ))}
          {letterheadPhone && <div>{formatPhone(letterheadPhone)}</div>}
        </div>
        <div className="po-idblock">
          <div className="po-barcode">
            <Barcode39 value={po.number} height={26} showText={false} />
          </div>
          <table className="po-idtable">
            <tbody>
              <tr>
                <td className="po-blank" />
                <th>Purchase Order</th>
              </tr>
              <tr>
                <td className="po-blank" />
                <td className="po-strong">{po.number}</td>
              </tr>
              <tr>
                <th>Date</th>
                <th>Document Date</th>
              </tr>
              <tr>
                <td>{shortDate(po.expectedAt)}</td>
                <td>{shortDate(po.placedAt ?? po.createdAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </header>

      <section className="po-parties">
        <div className="po-party">
          <div className="po-tab">Vendor</div>
          <div className="po-box">
            <div>{(po.vendorName ?? '—').toUpperCase()}</div>
            {vendorLines.map((line) => (
              <div key={line}>{line.toUpperCase()}</div>
            ))}
            {po.vendorContactName && <div>Attn: {po.vendorContactName}</div>}
            {po.vendorPhone && <div>Phone: {formatPhone(po.vendorPhone)}</div>}
            {po.vendorEmail && <div>{po.vendorEmail}</div>}
          </div>
        </div>
        <div className="po-party">
          <div className="po-tab">{po.directShip ? 'Ship To (direct)' : 'Ship To'}</div>
          <div className="po-box">
            {po.directShip ? (
              <>
                <div>{(shipTo.name ?? '—').toUpperCase()}</div>
                {poAddressLines(shipTo.address).map((line) => (
                  <div key={line}>{line.toUpperCase()}</div>
                ))}
                {shipTo.phone && <div>Phone: {formatPhone(shipTo.phone)}</div>}
                {shipTo.orderNumber && <div>Our sales order {shipTo.orderNumber}</div>}
              </>
            ) : (
              <>
                <div>{(po.locationName ?? businessName).toUpperCase()}</div>
                {letterhead.map((line) => (
                  <div key={line}>{line.toUpperCase()}</div>
                ))}
              </>
            )}
          </div>
        </div>
      </section>

      <table className="po-strip">
        <thead>
          <tr>
            <th style={{ width: '18%' }}>Ship Via</th>
            <th style={{ width: '18%' }}>Terms</th>
            <th className="po-left">Remarks</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td />
            <td />
            <td className="po-left po-remarks">{po.notes ?? ''}</td>
          </tr>
        </tbody>
      </table>

      <table className="po-lines">
        <thead>
          <tr>
            <th className="po-left">Model</th>
            <th className="po-left">Vendor Model</th>
            <th className="po-left">Description</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l, i) => (
            <Fragment key={i}>
              <tr>
                <td>
                  <span className="po-lineno">{i + 1}</span>
                  {l.sku ?? '—'}
                </td>
                <td>{l.vendorSku ?? l.sku ?? '—'}</td>
                <td>
                  {l.productName}
                  {l.variantName ? ` — ${l.variantName}` : ''}
                </td>
                <td className="num">{l.quantityOrdered}</td>
                <td className="num">{formatMoney(l.unitCostCents)}</td>
                <td className="num">{formatMoney(l.lineTotalCents)}</td>
              </tr>
              {(l.linkedOrders ?? []).map((o) => (
                <tr key={`${o.orderId}-${o.orderNumber}`} className="po-reserved">
                  <td colSpan={6}>
                    Reserved for Order # {o.orderNumber}
                    {o.customerName ? `, ${o.customerName.toUpperCase()}` : ''}
                    {o.quantity !== l.quantityOrdered ? ` (×${o.quantity})` : ''}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>

      <table className="po-totals">
        <tbody>
          <tr>
            <td>Total Quantity:</td>
            <td className="num">{totalQty}</td>
          </tr>
          <tr>
            <td>Merchandise Subtotal:</td>
            <td className="num">{formatMoney(po.subtotalCents)}</td>
          </tr>
          {freight > 0 && (
            <tr>
              <td>Freight:</td>
              <td className="num">{formatMoney(freight)}</td>
            </tr>
          )}
          <tr>
            <td>Total Order Amount:</td>
            <td className="num">{formatMoney(po.subtotalCents + freight)}</td>
          </tr>
        </tbody>
      </table>

      <footer className="po-foot">
        Please reference PO {po.number} on all correspondence, packing slips, and invoices.
      </footer>
    </div>
  );
}

const DOC_RULES = `
  font-family: Verdana, Tahoma, Arial, sans-serif; color: #000; font-size: 11px;
  line-height: 1.35; background: #fff;
`;

const PO_CSS = `
.po-doc--hidden { display: none; }
.po-doc--page { ${DOC_RULES} max-width: 760px; margin: 0 auto; padding: 24px; }
@media print {
  .po-doc--hidden { display: block !important; ${DOC_RULES}
    position: absolute; inset: 0; margin: 0; padding: 0; }
  body:has(.po-doc--hidden) * { visibility: hidden !important; }
  .po-doc--hidden, .po-doc--hidden * { visibility: visible !important; }
  .po-doc--page { padding: 0; max-width: none; }
  @page { margin: 12mm; }
}
.po-doc .po-top { display: flex; justify-content: space-between; align-items: flex-start;
  gap: 24px; margin-bottom: 18px; }
.po-doc .po-letterhead { padding-top: 22px; }
.po-doc .po-idblock { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.po-doc .po-barcode svg { display: block; width: 230px; }
.po-doc table { border-collapse: collapse; }
.po-doc .po-idtable { width: 230px; text-align: center; }
.po-doc .po-idtable th, .po-doc .po-idtable td { border: 1px solid #555; padding: 2px 6px;
  width: 50%; }
.po-doc .po-idtable th { background: #c8c8c8; font-weight: 400; }
.po-doc .po-idtable .po-blank { border: none; background: none; }
.po-doc .po-strong { font-weight: 400; }
.po-doc .po-parties { display: flex; justify-content: space-between; gap: 40px;
  margin-bottom: 14px; }
.po-doc .po-party { width: 42%; }
.po-doc .po-tab { display: inline-block; background: #c8c8c8; border: 1px solid #555;
  border-bottom: none; padding: 1px 28px; margin-left: 0; }
.po-doc .po-box { border: 1px solid #555; min-height: 72px; padding: 4px 6px; }
.po-doc .po-strip { width: 100%; margin-bottom: 12px; }
.po-doc .po-strip th { background: #c8c8c8; border: 1px solid #555; padding: 2px 6px;
  text-align: center; }
.po-doc .po-strip td { border: 1px solid #555; height: 18px; padding: 2px 6px; }
.po-doc .po-left { text-align: left !important; }
.po-doc .po-remarks { white-space: pre-wrap; }
.po-doc .po-lines { width: 100%; }
.po-doc .po-lines th { background: #c8c8c8; border: 1px solid #555; padding: 2px 6px;
  text-align: left; }
.po-doc .po-lines td { padding: 6px 6px 2px; vertical-align: top; }
.po-doc .num { text-align: right !important; white-space: nowrap; }
.po-doc .po-lineno { display: inline-block; min-width: 16px; }
.po-doc .po-lines .po-reserved td { padding: 0 6px 2px 28px; }
.po-doc .po-totals { margin: 20px 0 0 auto; width: 52%; border-top: 1px solid #000; }
.po-doc .po-totals td { padding: 1px 6px; }
.po-doc .po-totals td:first-child { text-align: right; padding-right: 40px; }
.po-doc .po-foot { margin-top: 28px; font-size: 9.5px; color: #444; }
`;
