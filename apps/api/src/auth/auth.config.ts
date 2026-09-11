import { schema } from '@jetnine/db';
import type { BetterAuthOptions, betterAuth as BetterAuthFactory } from 'better-auth';
import type { drizzleAdapter as DrizzleAdapterFactory } from 'better-auth/adapters/drizzle';
import type { twoFactor as TwoFactorFactory } from 'better-auth/plugins';
import type { Redis } from 'ioredis';
import type { EmailService } from '../email/email.service';
import { importESM } from '../utils/import-esm';

export interface AuthDeps {
  db: unknown; // Drizzle DB instance
  email: EmailService;
  redis: Redis | null;
  baseURL: string;
  trustedOrigins: string[];
  secret: string;
  productionMode: boolean;
  /**
   * When true, signups must verify their email before signing in.
   * Set to false on deployments without a working email transport so
   * the user isn't stuck waiting for an email that's only logged.
   */
  requireEmailVerification: boolean;
}

export type AuthInstance = Awaited<ReturnType<typeof createAuth>>;

export async function createAuth(deps: AuthDeps) {
  const { db, email, redis, baseURL, trustedOrigins, secret, productionMode } = deps;
  const { requireEmailVerification } = deps;

  // better-auth ships ESM only. importESM bypasses TS's require()-shim for
  // dynamic imports so the CJS-compiled apps/api output running in the
  // Vercel function loads it via real `import(...)` instead.
  const { betterAuth } = await importESM<{ betterAuth: typeof BetterAuthFactory }>('better-auth');
  const { drizzleAdapter } = await importESM<{ drizzleAdapter: typeof DrizzleAdapterFactory }>(
    'better-auth/adapters/drizzle',
  );
  const { twoFactor } = await importESM<{ twoFactor: typeof TwoFactorFactory }>(
    'better-auth/plugins',
  );

  const adapter = drizzleAdapter(db as Record<string, unknown>, {
    provider: 'pg',
    usePlural: true,
    transaction: false,
    // We pass our Drizzle tables explicitly so the adapter binds against the
    // exact instances rather than re-introspecting via reflection.
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
      twoFactors: schema.twoFactors,
    },
  });

  const options = {
    appName: 'LA Mattress ERP',
    baseURL,
    secret,
    trustedOrigins,
    database: adapter,

    // Cookies. Cross-site (Lax) is fine for our single-domain setup.
    advanced: {
      cookiePrefix: 'jetnine',
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: productionMode,
        httpOnly: true,
      },
      // Our schema uses uuid PKs everywhere; tell better-auth to emit UUIDs
      // instead of its default nanoid-style strings.
      database: {
        generateId: 'uuid',
      },
    },

    // Per-user identity columns we own; better-auth treats them as
    // additional fields it must not touch. is_super_admin is set by the
    // platform; the user shouldn't be able to flip it via update calls.
    user: {
      additionalFields: {
        isSuperAdmin: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
          returned: true,
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      // Auto-sign-in only when the merchant hasn't configured email
      // delivery — otherwise they'd never receive the verification
      // link and the signup would dead-end.
      autoSignIn: !requireEmailVerification,
      requireEmailVerification,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      sendResetPassword: async ({ user, url }) => {
        await email.send({
          to: user.email,
          subject: 'Reset your LA Mattress ERP password',
          text: `Click to reset your password: ${url}`,
          html: passwordResetEmail(url),
        });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await email.send({
          to: user.email,
          subject: 'Verify your LA Mattress ERP email',
          text: `Click to verify your email: ${url}`,
          html: verificationEmail(url),
        });
      },
    },

    plugins: [
      twoFactor({
        issuer: 'LA Mattress ERP',
        otpOptions: {
          period: 30,
          digits: 6,
        },
      }),
    ],

    rateLimit: {
      // Disabled in tests because vitest shares process state across the
      // integration suites and the cumulative sign-in count quickly trips
      // a 429 in the second-or-third spec file. The Playwright suite runs
      // the API under NODE_ENV=development (prod-like auth flows) and
      // signs in once per test — enough to trip the 5/min sign-in rule as
      // the suite grows — so it opts out explicitly instead. Production +
      // dev keep the PLAN.md §10.6 limits.
      enabled: process.env.NODE_ENV !== 'test' && process.env.AUTH_RATE_LIMIT_DISABLED !== '1',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
        '/forget-password': { window: 60, max: 5 },
        '/reset-password': { window: 60, max: 5 },
        '/two-factor/verify-totp': { window: 60, max: 10 },
      },
      storage: redis ? 'secondary-storage' : 'memory',
    },

    secondaryStorage: redis ? makeRedisStorage(redis) : undefined,
    // A22 slice 7 (Settings → Active sessions): with Redis as the session
    // store the `sessions` table would stay empty, so the tenant-wide
    // listing would see nothing. Keep a row per session in the database
    // as well; better-auth still serves reads from Redis.
    session: { storeSessionInDatabase: true },
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

function makeRedisStorage(redis: Redis) {
  return {
    get: async (key: string) => {
      const value = await redis.get(key);
      return value;
    },
    set: async (key: string, value: string, ttl?: number) => {
      if (ttl) {
        await redis.set(key, value, 'EX', ttl);
      } else {
        await redis.set(key, value);
      }
    },
    delete: async (key: string) => {
      await redis.del(key);
    },
  };
}

function verificationEmail(url: string): string {
  return `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px;">Verify your email</h1>
  <p>Click the button below to confirm this email address is yours.</p>
  <p>
    <a href="${escapeHtml(url)}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;">Verify email</a>
  </p>
  <p style="color:#666;font-size:12px;">If you didn't create an LA Mattress ERP account, you can ignore this email.</p>
</body></html>`;
}

function passwordResetEmail(url: string): string {
  return `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px;">Reset your password</h1>
  <p>Click the button below to choose a new password. The link expires in one hour.</p>
  <p>
    <a href="${escapeHtml(url)}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;">Reset password</a>
  </p>
  <p style="color:#666;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
