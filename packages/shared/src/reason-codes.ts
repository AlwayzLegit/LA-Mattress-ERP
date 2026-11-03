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

/**
 * Owner 2026-11-02: the Move-to-As-Is prompt offered one reason
 * ("Damaged"). Every business gets this starter catalog of As-Is reasons
 * — seeded when the business is created, backfilled by migration 0115
 * for businesses that already exist, and skipped wherever a business
 * already has a code of the same name. Owners add, rename or retire
 * them under Settings → Reason codes as before.
 */
export const DEFAULT_AS_IS_REASON_CODES: readonly { code: string; description: string }[] = [
  { code: 'DMG', description: 'Damaged' },
  { code: 'MFG', description: 'Manufacturer damage / defect' },
  { code: 'DLV', description: 'Damaged in delivery or transit' },
  { code: 'CNH', description: 'Customer not happy with product' },
  { code: 'CMF', description: 'Comfort exchange' },
  { code: 'WAR', description: 'Warranty claim' },
  { code: 'MIS', description: 'Mislabeled / wrong item' },
  { code: 'FLR', description: 'Floor model / display piece' },
  { code: 'RTN', description: 'Returned — opened or used' },
  { code: 'SOI', description: 'Soiled or stained' },
  { code: 'DIS', description: 'Discontinued / clearance' },
  { code: 'OTH', description: 'Other' },
];

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
