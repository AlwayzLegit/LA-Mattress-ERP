import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import type { RequestTenantContext } from '../tenancy/request-context';

/**
 * Where a payment is taken, and by whom (owner 2026-10-01): "if the
 * customer comes into a different store to make a payment, the payment
 * registers at the store that the payment was taken at with the member
 * who took it." The document (order, ticket) stays its own store's; the
 * tender belongs to the taking store's drawer, pickups and close-out.
 *
 * Taking money on an existing document is not selling, so a member with
 * approved-only selling may take a payment on any store's order — but
 * only as taken at a store they are set up for (they are standing in it).
 */
export interface TakenAt {
  locationId: string;
  takenByMembershipId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveTakenAt(
  db: PostgresJsDatabase,
  tenant: RequestTenantContext,
  docLocationId: string,
  requested?: unknown,
): Promise<TakenAt> {
  const takenByMembershipId = tenant.membershipId ?? null;
  const approvedOnly = tenant.sellingScope === 'approved';
  const scope = tenant.scopeLocationIds ?? [];

  if (requested != null && requested !== '') {
    if (typeof requested !== 'string' || !UUID.test(requested)) {
      throw new BadRequestException('takenAtLocationId must be a location id');
    }
    const [loc] = await db
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(
        and(
          eq(schema.locations.businessId, tenant.businessId!),
          eq(schema.locations.id, requested),
          eq(schema.locations.isActive, true),
        ),
      )
      .limit(1);
    if (!loc) throw new BadRequestException('takenAtLocationId is not an active store');
    if (approvedOnly && !scope.includes(requested)) {
      throw new ForbiddenException(
        'You can take a payment only at a store you are set up for — switch the store chip to where you are',
      );
    }
    return { locationId: requested, takenByMembershipId };
  }

  // No store named (an older screen, an API client): the document's own
  // store, unless an approved-only member is not set up there — then the
  // one store they are set up for, or a request to say which.
  if (!approvedOnly || scope.includes(docLocationId)) {
    return { locationId: docLocationId, takenByMembershipId };
  }
  if (scope.length === 1) return { locationId: scope[0]!, takenByMembershipId };
  throw new BadRequestException(
    'Choose the store you are taking this payment at (the store chip at the top), then try again',
  );
}
