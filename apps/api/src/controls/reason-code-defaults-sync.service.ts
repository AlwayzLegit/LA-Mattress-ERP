import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { schema } from '@jetnine/db';
import { DEFAULT_AS_IS_REASON_CODES } from '@jetnine/shared';
import { DRIZZLE } from '../database/database.module';

/**
 * Owner 2026-11-02: every business gets the standard As-Is reason catalog
 * (`DEFAULT_AS_IS_REASON_CODES`). Business creation seeds it; this boot
 * pass backfills the businesses that already existed, the way
 * `SystemRoleSyncService` backfills roles. Insert-only and idempotent:
 * a code the business already has — LA Mattress's own DMG, say — is left
 * exactly as it is (the unique index on business, class and code makes
 * that row a no-op), and a code the owner later retires stays retired
 * because `active` is never touched.
 *
 * Done at boot rather than in a migration so the catalog lives in one
 * place (`@jetnine/shared`) and a later addition to it reaches every
 * tenant on the next deploy.
 */
@Injectable()
export class ReasonCodeDefaultsSyncService implements OnModuleInit {
  private readonly logger = new Logger(ReasonCodeDefaultsSyncService.name);

  constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test' && process.env.REASON_CODE_DEFAULTS_SYNC !== '1') return;
    try {
      const businesses = await this.db.select({ id: schema.businesses.id }).from(schema.businesses);
      if (businesses.length === 0) return;
      const values = businesses.flatMap((b) =>
        DEFAULT_AS_IS_REASON_CODES.map((c) => ({
          businessId: b.id,
          code: c.code,
          description: c.description,
          usageClass: 'as_is',
        })),
      );
      let added = 0;
      for (let i = 0; i < values.length; i += 1000) {
        const result = await this.db
          .insert(schema.reasonCodes)
          .values(values.slice(i, i + 1000))
          .onConflictDoNothing()
          .returning({ id: schema.reasonCodes.id });
        added += result.length;
      }
      if (added > 0) {
        this.logger.log(
          `Reason code defaults: added ${added} As-Is reason(s) across ${businesses.length} business(es)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Reason code defaults sync failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
