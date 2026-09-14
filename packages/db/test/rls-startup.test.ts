import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sql = postgres(
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_test',
  { max: 2, prepare: false, onnotice: () => {} },
);
const policies = readFileSync(new URL('../src/migrations/rls.sql', import.meta.url), 'utf8');

beforeAll(async () => {
  await sql.begin((tx) => tx.unsafe(policies));
});
afterAll(() => sql.end());

describe('RLS setup during rolling deployment', () => {
  it('keeps unchanged policies usable while readers hold all live tables', async () => {
    await sql.begin(async (reader) => {
      const [{ tables }] = await reader<{ tables: string }[]>`
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables
        FROM pg_tables WHERE schemaname = 'public'
      `;
      await reader.unsafe(`LOCK TABLE ${tables} IN ACCESS SHARE MODE`);
      const before = await reader`SELECT oid FROM pg_policy ORDER BY oid`;
      await sql.begin(async (setup) => {
        await setup.unsafe("SET LOCAL lock_timeout = '250ms'");
        await setup.unsafe(policies);
      });
      const after = await reader`SELECT oid FROM pg_policy ORDER BY oid`;
      expect(after).toEqual(before);
    });
  });

  it('repairs missing and changed policies, including role restrictions', async () => {
    const [expected] = await sql`
      SELECT polcmd, polpermissive, polroles, pg_get_expr(polqual, polrelid) AS qual,
        pg_get_expr(polwithcheck, polrelid) AS check_expr
      FROM pg_policy WHERE polrelid = 'public.chat_settings'::regclass AND polname = 'tenant_isolation'
    `;
    await sql.begin(async (tx) => {
      await tx.unsafe('DROP POLICY tenant_isolation ON public.chat_settings');
      await tx.unsafe(policies);
      await tx.unsafe(
        'ALTER POLICY tenant_isolation ON public.chat_settings TO app_user USING (false)',
      );
      await tx.unsafe(policies);
      const [actual] = await tx`
        SELECT polcmd, polpermissive, polroles, pg_get_expr(polqual, polrelid) AS qual,
          pg_get_expr(polwithcheck, polrelid) AS check_expr
        FROM pg_policy WHERE polrelid = 'public.chat_settings'::regclass AND polname = 'tenant_isolation'
      `;
      expect(actual).toEqual(expected);
    });
  });

  it('restores disabled row security and force flags', async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe('ALTER TABLE public.chat_settings DISABLE ROW LEVEL SECURITY');
      await tx.unsafe('ALTER TABLE public.chat_settings NO FORCE ROW LEVEL SECURITY');
      await tx.unsafe(policies);
      const [flags] = await tx`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = 'public.chat_settings'::regclass
      `;
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });
});
