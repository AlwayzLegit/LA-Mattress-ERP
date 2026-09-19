'use client';

import { formatMoney, formatPhone } from '@jetnine/shared';
import { useBusinessName } from '@/lib/business-settings';

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
  linkedOrders?: { orderId: string; orderNumber: string; quantity: number }[];
}

export interface PrintablePo {
  number: string;
  createdAt: string;
  expectedAt: string | null;
  vendorName: string | null;
  vendorContactName: string | null;
  vendorEmail: string | null;
  vendorPhone: string | null;
  locationName: string | null;
  notes: string | null;
  subtotalCents: number;
  /** PO-060: vendor ships straight to the customer named in shipToJson. */
  directShip?: boolean;
  shipToJson?: unknown;
  lines: PrintablePoLine[];
}

/** Best-effort address lines out of the opaque customer addressesJson. */
function addressLines(value: unknown): string[] {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return [];
  if (typeof first === 'string') return [first];
  if (typeof first !== 'object') return [];
  return Object.values(first as Record<string, unknown>)
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .filter((s) => s.trim().length > 0);
}

/**
 * Vendor-facing purchase-order document. Hidden on screen; `@media
 * print` shows only this element (same mechanics as the receipt), so
 * "Print" on the PO page produces a clean one-page document the buyer
 * can hand or email to the vendor. Line items lead with the VENDOR's
 * part number (falling back to ours) so the vendor can key the order
 * without a cross-reference.
 */
export function PrintablePurchaseOrder({ po }: { po: PrintablePo }) {
  const businessName = useBusinessName() ?? 'Purchase order';
  return (
    <div data-printable className="po-doc">
      <style>{PO_CSS}</style>
      <header className="po-head">
        <div>
          <h1>Purchase Order</h1>
          <p className="po-number">{po.number}</p>
        </div>
        <div className="po-from">
          <strong>{businessName}</strong>
          <span>Issued {new Date(po.createdAt).toLocaleDateString()}</span>
          {po.expectedAt && <span>Expected {new Date(po.expectedAt).toLocaleDateString()}</span>}
        </div>
      </header>

      <section className="po-parties">
        <div>
          <h2>Vendor</h2>
          <p>
            <strong>{po.vendorName ?? '—'}</strong>
            {po.vendorContactName && (
              <>
                <br />
                Attn: {po.vendorContactName}
              </>
            )}
            {po.vendorEmail && (
              <>
                <br />
                {po.vendorEmail}
              </>
            )}
            {po.vendorPhone && (
              <>
                <br />
                {formatPhone(po.vendorPhone)}
              </>
            )}
          </p>
        </div>
        <div>
          <h2>Ship to{po.directShip ? ' (customer — direct shipment)' : ''}</h2>
          {po.directShip ? (
            <p>
              {(() => {
                const shipTo = (po.shipToJson ?? {}) as {
                  name?: string | null;
                  phone?: string | null;
                  email?: string | null;
                  address?: unknown;
                  orderNumber?: string | null;
                };
                return (
                  <>
                    <strong>{shipTo.name ?? '—'}</strong>
                    {addressLines(shipTo.address).map((line) => (
                      <span key={line}>
                        <br />
                        {line}
                      </span>
                    ))}
                    {shipTo.phone && (
                      <>
                        <br />
                        {formatPhone(shipTo.phone)}
                      </>
                    )}
                    {shipTo.orderNumber && (
                      <>
                        <br />
                        Our sales order {shipTo.orderNumber}
                      </>
                    )}
                  </>
                );
              })()}
            </p>
          ) : (
            <p>
              <strong>{businessName}</strong>
              {po.locationName && (
                <>
                  <br />
                  {po.locationName}
                </>
              )}
            </p>
          )}
        </div>
      </section>

      <table className="po-lines">
        <thead>
          <tr>
            <th>Item #</th>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit cost</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <code>{l.vendorSku ?? l.sku ?? '—'}</code>
                {l.vendorSku && l.sku && l.vendorSku !== l.sku && (
                  <span className="po-oursku">ref {l.sku}</span>
                )}
              </td>
              <td>
                {l.productName}
                {l.variantName ? ` — ${l.variantName}` : ''}
                {l.linkedOrders && l.linkedOrders.length > 0 && (
                  <div className="po-oursku">
                    For sales order{l.linkedOrders.length > 1 ? 's' : ''}:{' '}
                    {l.linkedOrders.map((o) => `${o.orderNumber} ×${o.quantity}`).join(', ')}
                  </div>
                )}
              </td>
              <td className="num">{l.quantityOrdered}</td>
              <td className="num">{formatMoney(l.unitCostCents)}</td>
              <td className="num">{formatMoney(l.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4}>Subtotal</td>
            <td className="num">{formatMoney(po.subtotalCents)}</td>
          </tr>
        </tfoot>
      </table>

      {po.notes && (
        <section className="po-notes">
          <h2>Notes</h2>
          <p>{po.notes}</p>
        </section>
      )}

      <footer className="po-foot">
        Please reference PO {po.number} on all correspondence, packing slips, and invoices.
      </footer>
    </div>
  );
}

const PO_CSS = `
.po-doc { display: none; }
@media print {
  body * { visibility: hidden !important; }
  .po-doc { display: block !important; visibility: visible !important;
    position: absolute; inset: 0; margin: 0; padding: 4mm;
    font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; }
  .po-doc * { visibility: visible !important; }
  .po-doc h1 { font-size: 20px; margin: 0; letter-spacing: 0.02em; }
  .po-doc h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #555; margin: 0 0 4px; }
  .po-doc .po-head { display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #111; padding-bottom: 8px; }
  .po-doc .po-number { font-family: ui-monospace, Consolas, monospace; font-size: 13px;
    margin: 2px 0 0; }
  .po-doc .po-from { text-align: right; display: grid; gap: 1px; font-size: 12px; }
  .po-doc .po-parties { display: flex; gap: 40px; margin: 12px 0 16px; }
  .po-doc .po-parties p { margin: 0; line-height: 1.5; }
  .po-doc table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .po-doc th { text-align: left; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #999; padding: 4px 6px; }
  .po-doc td { padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .po-doc .num { text-align: right; white-space: nowrap; }
  .po-doc code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
  .po-doc .po-oursku { display: block; font-size: 10.5px; color: #555; }
  .po-doc tfoot td { border-bottom: none; border-top: 2px solid #111; font-weight: 700;
    padding-top: 6px; }
  .po-doc .po-notes { margin-top: 14px; }
  .po-doc .po-notes p { margin: 0; white-space: pre-wrap; }
  .po-doc .po-foot { margin-top: 18px; font-size: 10.5px; color: #666;
    border-top: 1px solid #ddd; padding-top: 6px; }
  @page { margin: 12mm; }
}
`;
