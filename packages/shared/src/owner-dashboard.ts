import { z } from 'zod';

/** A correction of selling attribution, never an invoice repricing request. */
export const sellingStoreCorrectionSchema = z
  .object({
    locationId: z.string().uuid(),
    expectedLocationId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type SellingStoreCorrection = z.infer<typeof sellingStoreCorrectionSchema>;

/**
 * Owner 2026-11-19 (WE-10091): put the right salespeople on any order,
 * finished ones included — attribution only, the goods and money stay.
 */
export const salespersonCorrectionSchema = z
  .object({
    salespersonMembershipId: z.string().uuid().nullable(),
    secondSalespersonMembershipId: z.string().uuid().nullable().default(null),
    /** The primary's share in bps when there is a second salesperson. */
    splitBps: z.number().int().min(0).max(10000).nullable().default(null),
    /** What the screen showed, so two corrections can't cross. */
    expectedSalespersonMembershipId: z.string().uuid().nullable(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type SalespersonCorrection = z.infer<typeof salespersonCorrectionSchema>;

export const writtenOrdersQuerySchema = z.object({
  period: z.enum(['today', 'mtd']).default('today'),
  locationId: z.string().uuid().optional(),
  salespersonMembershipId: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
