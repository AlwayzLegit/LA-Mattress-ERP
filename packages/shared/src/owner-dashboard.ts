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

export const writtenOrdersQuerySchema = z.object({
  period: z.enum(['today', 'mtd']).default('today'),
  locationId: z.string().uuid().optional(),
  salespersonMembershipId: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
