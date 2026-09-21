/**
 * Database-error classification (owner 2026-09-21: creating a product
 * whose SKU already exists answered "Internal server error").
 *
 * Drizzle wraps every failed statement in a `DrizzleQueryError` whose
 * message is only `Failed query: <sql> params: <values>`. The real
 * postgres.js error — the one carrying SQLSTATE `23505` and
 * `constraint_name` — hangs off `.cause`:
 *
 *   DrizzleQueryError { query, params, cause }
 *     └── PostgresError { code: '23505', constraint_name, detail, … }
 *
 * Guards written as `err.message.includes('<constraint>_uniq')` therefore
 * never matched, and the raw error reached the exception filter as a 500.
 * Always classify through these helpers instead of reading `message`.
 */

/** How far down the `cause` chain to look; two levels is today's depth. */
const MAX_DEPTH = 5;

interface PgLikeError {
  code?: unknown;
  constraint_name?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** SQLSTATE class 23 codes worth naming. */
const UNIQUE_VIOLATION = '23505';

function chain(err: unknown): PgLikeError[] {
  const out: PgLikeError[] = [];
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
    if (typeof cursor !== 'object') break;
    const node = cursor as PgLikeError;
    out.push(node);
    cursor = node.cause;
  }
  return out;
}

/** The violated constraint's name, when the driver reported one. */
function constraintOf(node: PgLikeError): string | undefined {
  const name = node.constraint_name ?? node.constraint;
  return typeof name === 'string' && name ? name : undefined;
}

/**
 * True when `err` (or anything it wraps) is a unique-constraint
 * violation. Pass `constraint` to match one index by name — the driver
 * reports it as `constraint_name`, and the message is checked too so a
 * driver that only renders it in text still matches.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return chain(err).some((node) => {
    if (node.code !== UNIQUE_VIOLATION) return false;
    if (!constraint) return true;
    if (constraintOf(node) === constraint) return true;
    return typeof node.message === 'string' && node.message.includes(constraint);
  });
}

/**
 * The name of the violated unique index, when `err` is one and the
 * driver reported it. Useful where one insert can trip several indexes.
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  for (const node of chain(err)) {
    if (node.code === UNIQUE_VIOLATION) return constraintOf(node);
  }
  return undefined;
}
