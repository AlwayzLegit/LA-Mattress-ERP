/**
 * Catalog vocab shared by the API and the web app (amendment A19).
 */

/** STORIS Purchase Status: may the buyer still order this product? */
export const PRODUCT_PURCHASE_STATUSES = [
  'active',
  'discontinued',
  'special_order',
  'closeout',
] as const;
export type ProductPurchaseStatus = (typeof PRODUCT_PURCHASE_STATUSES)[number];

export const PRODUCT_PURCHASE_STATUS_LABELS: Record<ProductPurchaseStatus, string> = {
  active: 'Active',
  discontinued: 'Discontinued',
  special_order: 'Special order only',
  closeout: 'Closeout',
};
