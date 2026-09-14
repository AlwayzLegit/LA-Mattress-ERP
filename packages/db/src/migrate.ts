import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from './client';
import { retryPolicySetup } from './retry-policy-setup';

const MIGRATIONS_FOLDER = join(__dirname, '..', 'drizzle');

type Journal = { entries: { idx: number; tag: string }[] };

/**
 * Migration tags in journal order. Drizzle inserts one `__drizzle_migrations`
 * row per applied file in exactly this order, so a row count is an index into
 * this list — which is what lets the boot log name the migrations by tag.
 */
function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  return journal.entries.map((e) => e.tag);
}

/** Rows in drizzle's bookkeeping table; 0 before the first migration ever runs. */
async function appliedCount(sql: ReturnType<typeof createClient>['sql']): Promise<number> {
  try {
    const rows = await sql.unsafe<{ n: number }[]>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required to run migrations.');
    process.exit(1);
  }

  const { db, sql } = createClient({ url, max: 1 });

  try {
    // 1. Extensions must exist before tables that reference them (citext).
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS citext');

    // 2. Drizzle-managed schema migrations.
    const before = await appliedCount(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await appliedCount(sql);

    // 3. Name what happened. A deploy log that only says "applied" cannot
    //    answer "is migration 00NN live?" after the fact — this can.
    const tags = journalTags();
    const newly = tags.slice(before, after);
    const head = tags[after - 1] ?? 'none';
    console.error(
      `Schema migrations: ${after}/${tags.length} applied, head=${head}; ` +
        `this run applied ${newly.length ? newly.join(', ') : 'none (already up to date)'}.`,
    );
    if (after < tags.length) {
      console.error(
        `WARNING: ${tags.length - after} migration(s) still pending: ${tags.slice(after).join(', ')}`,
      );
    }

    // 4. RLS / roles / policies. Idempotent; safe to re-run on every deploy.
    const rlsPath = join(__dirname, 'migrations', 'rls.sql');
    const rls = readFileSync(rlsPath, 'utf8');
    // Fail quickly on a busy table rather than holding earlier table locks
    // while the old API waits on them. Each failed attempt rolls back all
    // grants and policies; the API only starts after a complete successful run.
    await retryPolicySetup(
      async () => {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL lock_timeout = '250ms'");
          await tx.unsafe(rls);
        });
      },
      { onRetry: (attempt) => console.error(`RLS setup lock contention; retry ${attempt}/20.`) },
    );

    console.error('Migrations applied (schema + RLS).');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
