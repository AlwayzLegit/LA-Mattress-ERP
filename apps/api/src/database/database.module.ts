import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { tryGetRequestContext } from '../tenancy/request-context';

export const DRIZZLE = Symbol('DRIZZLE');
/**
 * The unscoped root connection — RLS does NOT apply. For the few
 * deliberately privileged operations a tenant request performs on
 * platform tables (e.g. creating the `users` row for an invitee).
 * Everything else should inject DRIZZLE.
 */
export const ROOT_DRIZZLE = Symbol('ROOT_DRIZZLE');
export const PG_SQL = Symbol('PG_SQL');

/**
 * Tenant-aware Drizzle handle. Inside a `@TenantScoped()` request the RLS
 * interceptor has already opened a transaction on which
 * `SET LOCAL ROLE app_user` + the tenant GUCs ran; every query issued
 * through this proxy is routed onto that transaction, so Postgres RLS
 * actually applies to it. Outside a request scope — startup, schedulers,
 * the auth stack, or fire-and-forget work that outlives its request
 * (ctx.closed) — queries fall through to the root connection, which
 * bypasses RLS exactly as before.
 *
 * This exists because injecting the raw root pool into controllers made
 * every query that relied on RLS instead of an explicit `business_id`
 * filter read across tenants: the SET LOCAL only ever ran on the
 * interceptor's transaction, never on the pool connections the
 * controllers were actually using.
 */
function tenantAwareDrizzle(sql: Sql): PostgresJsDatabase {
  const root = drizzle(sql);
  return new Proxy(root, {
    get(target, prop, _receiver) {
      const ctx = tryGetRequestContext();
      const active = ctx && !ctx.closed ? (ctx.db as unknown as PostgresJsDatabase) : target;
      const value = Reflect.get(active as object, prop, active);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(active)
        : value;
    },
  });
}

@Global()
@Module({
  providers: [
    {
      provide: PG_SQL,
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('DATABASE_URL');
        if (!url) throw new Error('DATABASE_URL is required');
        return postgres(url, {
          max: Number(config.get<string>('DATABASE_POOL_MAX') ?? '10'),
          prepare: false,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: DRIZZLE,
      useFactory: (sql: Sql) => tenantAwareDrizzle(sql),
      inject: [PG_SQL],
    },
    {
      provide: ROOT_DRIZZLE,
      useFactory: (sql: Sql) => drizzle(sql),
      inject: [PG_SQL],
    },
  ],
  exports: [DRIZZLE, ROOT_DRIZZLE, PG_SQL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_SQL) private readonly sql: Sql) {}

  /**
   * Close the pool when the application shuts down (`app.close()`, or a
   * signal once shutdown hooks are enabled). This runs after every
   * module's onModuleDestroy, so nothing is still mid-query. Factory
   * providers get no lifecycle hooks of their own, and without this the
   * idle pool connections outlive the Nest app: the integration suite
   * runs every spec file in one process, and each spec's app left its
   * connections open until Postgres refused new clients.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
