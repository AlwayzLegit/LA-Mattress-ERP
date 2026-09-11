/**
 * Reason-code usage classes (PLAN-STORIS-GAP §0.2, mirroring STORIS
 * "Reason Code Settings" usage codes). A reason code is only legal at
 * prompts that ask for its class; the server refuses a code of the
 * wrong class.
 */
export const REASON_USAGE_CLASSES = [
  'exception',
  'as_is',
  'return',
  'adjustment',
  'delivery_failure',
  'manifest_removal',
  'inventory_adjustment',
  'transfer_variance',
  'transfer',
  'write_off',
  'physical_variance',
] as const;

export type ReasonUsageClass = (typeof REASON_USAGE_CLASSES)[number];

export const REASON_USAGE_CLASS_LABELS: Record<ReasonUsageClass, string> = {
  exception: 'Exceptions (overrides, unlocks)',
  as_is: 'As-Is intake',
  return: 'Returns',
  adjustment: 'Price / dollar adjustments',
  delivery_failure: 'Failed deliveries',
  manifest_removal: 'Removed from a delivery run',
  inventory_adjustment: 'Inventory adjustments',
  transfer_variance: 'Transfer variances',
  transfer: 'Transfers (reason for the move)',
  write_off: 'Write-offs / scrap',
  physical_variance: 'Physical count variances',
};
