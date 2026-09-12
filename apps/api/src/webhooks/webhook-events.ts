/**
 * The complete catalog of outbound webhook event types Jetnine emits.
 * Adding a new event:
 *   1. Add it to this enum.
 *   2. Call WebhookDispatcher.fire() from the controller that produces it.
 *   3. Document the payload shape on this file alongside the constant.
 *
 * Endpoints subscribe to event types by name; the literal `*` in an
 * endpoint's `events` array matches every type, including future ones.
 */
export const WEBHOOK_EVENT_TYPES = [
  'sale.created',
  'sale.refunded',
  'order.created',
  'order.payment_received',
  'order.cancelled',
  'order.completed',
  // Payload: { orderId, orderNumber, newOrderId, newOrderNumber,
  // lines: [{ lineId, variantId, description, quantity }] } — the
  // backorder split that moves lines onto a new order.
  'order.split',
  'delivery.scheduled',
  'delivery.delivered',
  'customer.created',
  /**
   * A duplicate customer was merged away. Payload: customerId (the
   * keeper), mergedCustomerId (now deleted), mergedPhone, mergedEmail.
   */
  'customer.merged',
  'inventory.adjusted',
  'purchase_order.received',
  'stock_transfer.received',
  // Exchange container lifecycle (docs/erp-exchange). Payloads carry
  // { exchangeId, number } plus per-event context; 'exchange.settled'
  // adds { creditIssuedCents?, appliedToSaleCents, saleOrderId,
  // saleOrderNumber } for the credit applied to the replacement order.
  'exchange.created',
  'exchange.approved',
  'exchange.settled',
  'exchange.split',
  'exchange.cancelled',
  // Payload: { campaignId, name, segmentId, recipientCount }
  'campaign.sent',
  // Payload: { paymentId, docKind, docId, docNumber, amountCents,
  // locationId, receivedByMembershipId } — the owner's or Operations'
  // tick that a cash payment was physically picked up (dashboard 2026-09-10).
  'cash_pickup.confirmed',
  // Payload: { pickupId, number, locationId, countedCents, expectedCents,
  // varianceCents, slip, paymentIds, recordedByMembershipId } — a posted
  // drawer pickup (redesign Phase 9).
  'cash_pickup.posted',
  'close_out.signed_off',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const ALL_EVENTS_WILDCARD = '*';

export function endpointMatchesEvent(
  subscribed: string[] | null | undefined,
  type: string,
): boolean {
  if (!subscribed || subscribed.length === 0) return false;
  if (subscribed.includes(ALL_EVENTS_WILDCARD)) return true;
  return subscribed.includes(type);
}
