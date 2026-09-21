import { describe, expect, it } from 'vitest';
import { isUniqueViolation, uniqueViolationConstraint } from './db-errors';

/**
 * The shapes below are copied from a real failed insert against Postgres
 * 16 through drizzle 0.45 + postgres.js: the outer error carries no code
 * at all, which is exactly why matching on `message` used to fail.
 */
function postgresError(constraint: string) {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      severity: 'ERROR',
      code: '23505',
      detail: `Key (business_id, sku)=(b819c499, 4760005) already exists.`,
      schema_name: 'public',
      table_name: 'products',
      constraint_name: constraint,
    },
  );
}

function drizzleWrapped(cause: unknown) {
  return Object.assign(
    new Error(
      'Failed query: insert into "products" ("id", "business_id", …)\nparams: b819c499,4760005',
    ),
    { query: 'insert into "products" …', params: ['b819c499', '4760005'], cause },
  );
}

describe('isUniqueViolation', () => {
  const wrapped = drizzleWrapped(postgresError('products_business_sku_uniq'));

  it('sees through the drizzle wrapper to the postgres error', () => {
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, 'products_business_sku_uniq')).toBe(true);
  });

  it('is false for a different constraint', () => {
    expect(isUniqueViolation(wrapped, 'gift_cards_business_code_uniq')).toBe(false);
  });

  it('matches an unwrapped driver error too', () => {
    const bare = postgresError('roles_business_name_uniq');
    expect(isUniqueViolation(bare)).toBe(true);
    expect(isUniqueViolation(bare, 'roles_business_name_uniq')).toBe(true);
  });

  it('falls back to the message when the driver names no constraint', () => {
    const noName = Object.assign(
      new Error('duplicate key value violates unique constraint "businesses_slug_uniq"'),
      { code: '23505' },
    );
    expect(isUniqueViolation(noName, 'businesses_slug_uniq')).toBe(true);
  });

  it('ignores other failures', () => {
    expect(
      isUniqueViolation(drizzleWrapped(Object.assign(new Error('nope'), { code: '23503' }))),
    ).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('does not loop forever on a self-referencing cause', () => {
    const loop: { cause?: unknown; code?: string } = { code: '23503' };
    loop.cause = loop;
    expect(isUniqueViolation(loop)).toBe(false);
  });
});

describe('uniqueViolationConstraint', () => {
  it('names the violated index', () => {
    expect(
      uniqueViolationConstraint(drizzleWrapped(postgresError('products_business_sku_uniq'))),
    ).toBe('products_business_sku_uniq');
    expect(uniqueViolationConstraint(new Error('boom'))).toBeUndefined();
  });
});
