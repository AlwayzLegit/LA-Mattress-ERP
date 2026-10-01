/**
 * Turning one reorder suggestion into PO builder lines (owner
 * 2026-10-01). The customer part goes in as lines linked to the waiting
 * order lines, oldest order first, so the PO carries the sales order #,
 * the order shows "On PO", and receiving commits the units to that
 * customer. The shelf top-up goes in as one plain stock line.
 */

export interface WaitingOrderLine {
  orderLineId: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  quantity: number;
}

export interface ReorderSuggestion {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  available: number;
  reorderPoint: number | null;
  waitingQty?: number;
  waitingOrders?: WaitingOrderLine[];
  onPoQty?: number;
  customerQty?: number;
  stockQty?: number;
  suggestedQty: number;
  unitCostCents: number | null;
}

export interface StagedLine {
  variantId: string;
  description: string;
  sku: string | null;
  quantity: number;
  unitCostStr: string;
  orderLineId?: string;
  orderNumber?: string;
}

export function stageSuggestion(
  s: ReorderSuggestion,
  existing: readonly { variantId: string; orderLineId?: string }[],
): StagedLine[] {
  const description = [s.productName, s.variantName].filter(Boolean).join(' — ');
  const unitCostStr = s.unitCostCents != null ? (s.unitCostCents / 100).toFixed(2) : '';
  const linked = new Set(existing.map((l) => l.orderLineId).filter(Boolean));
  const hasStockLine = existing.some((l) => l.variantId === s.variantId && !l.orderLineId);
  // An older API sends only suggestedQty: all of it is shelf stock.
  const customerQty = s.customerQty ?? 0;
  const stockQty = s.stockQty ?? (s.customerQty == null ? s.suggestedQty : 0);

  const out: StagedLine[] = [];
  let left = customerQty;
  for (const w of s.waitingOrders ?? []) {
    if (left <= 0) break;
    const qty = Math.min(w.quantity, left);
    left -= qty;
    if (linked.has(w.orderLineId)) continue;
    out.push({
      variantId: s.variantId,
      description,
      sku: s.sku,
      quantity: qty,
      unitCostStr,
      orderLineId: w.orderLineId,
      orderNumber: w.orderNumber,
    });
  }
  // Whatever the customer part could not tie to a line rides with the stock line.
  const stock = stockQty + Math.max(0, left);
  if (stock > 0 && !hasStockLine) {
    out.push({ variantId: s.variantId, description, sku: s.sku, quantity: stock, unitCostStr });
  }
  return out;
}

/** "2 for KO-10031, KO-10040 + 1 for stock". */
export function suggestionBreakdown(s: ReorderSuggestion): string | null {
  const customer = s.customerQty ?? 0;
  if (customer <= 0) return null;
  const orders = (s.waitingOrders ?? []).map((w) => w.orderNumber);
  const unique = [...new Set(orders)];
  const named = unique.slice(0, 3).join(', ') + (unique.length > 3 ? ` +${unique.length - 3}` : '');
  const stock = s.stockQty ?? 0;
  return `${customer} for ${named || 'customer orders'}${stock > 0 ? ` + ${stock} for stock` : ''}`;
}
