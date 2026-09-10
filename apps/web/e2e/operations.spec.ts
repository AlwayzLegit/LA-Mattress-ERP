/**
 * Operations dashboard acceptance (owner 2026-08-31).
 *
 * The one journey that matters: a hand-made stock adjustment happens,
 * it appears on the operations feed at the top of the page, someone
 * reads it and clears it, and it is gone on the next load — with the
 * money tiles rendering all-store numbers underneath the whole time.
 */
import { expect, request, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const API_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 4001);
const API_URL = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_e2e';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');

const PASSWORD = 'OperationsE2E!2026';
const EMAIL = `ops+${Date.now()}@example.com`;

let businessId = '';
let locationId = '';
let variantId = '';

test.beforeAll(async () => {
  const env = { ...process.env, DATABASE_URL: DB_URL };
  execFileSync('pnpm', ['exec', 'tsx', 'src/reset.ts'], {
    cwd: dbPackageRoot,
    env,
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['exec', 'tsx', 'src/migrate.ts'], {
    cwd: dbPackageRoot,
    env,
    stdio: 'inherit',
  });

  const api = await request.newContext();
  const signup = await api.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { email: EMAIL, password: PASSWORD, name: 'Ops Watcher' },
  });
  if (!signup.ok()) throw new Error(`signup failed: ${signup.status()} ${await signup.text()}`);

  const captured = await api
    .get(`${API_URL}/v1/dev/email/last`, { params: { to: EMAIL } })
    .then((r) => r.json());
  const match = (captured.html as string).match(/href="([^"]+)"/);
  if (!match) throw new Error('no verify link in email');
  await api.get(match[1]!.replace(/&amp;/g, '&'), { maxRedirects: 0 });

  const seed = await api.post(`${API_URL}/v1/dev/e2e-seed`, {
    data: { ownerEmail: EMAIL, businessSlug: `ops-${Date.now()}` },
  });
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const seeded = (await seed.json()) as {
    businessId: string;
    locationId: string;
    variantId: string;
  };
  businessId = seeded.businessId;
  locationId = seeded.locationId;
  variantId = seeded.variantId;
  await api.dispose();
});

async function loginAndPickBusiness(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/(pos|business-picker)/);
  await page.evaluate(
    async ({ apiUrl, businessId }) => {
      await fetch(`${apiUrl}/v1/auth/active-business`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId }),
      });
    },
    { apiUrl: API_URL, businessId },
  );
}

/** An 8-unit hand-made write-down — over the 5-unit default threshold. */
async function makeAdjustment(page: import('@playwright/test').Page): Promise<void> {
  const status = await page.evaluate(
    async ({ apiUrl, variantId, locationId }) => {
      // Stock it first, so the write-down has something to take away.
      await fetch(`${apiUrl}/v1/inventory/adjust`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variantId, locationId, delta: 20, reason: 'count_correction' }),
      });
      const res = await fetch(`${apiUrl}/v1/inventory/adjust`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantId,
          locationId,
          delta: -8,
          reason: 'damage',
          notes: 'Forklift through the pallet',
        }),
      });
      return res.status;
    },
    { apiUrl: API_URL, variantId, locationId },
  );
  expect(status).toBe(201);
}

test.describe('Operations dashboard', () => {
  test('a stock write-down reaches the feed, gets cleared, and stays gone', async ({ page }) => {
    test.slow();
    await loginAndPickBusiness(page);

    await page.goto('/dashboard');
    await makeAdjustment(page);

    await page.goto('/operations');
    await expect(page.getByTestId('operations-dashboard')).toBeVisible();

    // The feed leads the page, and the write-down is on it. Scoped to
    // the feed rows: the by-person digest below names the same kinds.
    const feedRows = page.getByTestId('ops-feed-row');
    await expect(feedRows.first()).toBeVisible();
    const writeDown = feedRows.filter({ hasText: 'Forklift through the pallet' });
    await expect(writeDown).toHaveCount(1);
    await expect(writeDown).toContainText('Damage write-down');

    // The store cards lead the page (hand-off 2026-09-10): every store,
    // no store picker, each with its cash-pickup block.
    await expect(page.getByTestId('stores-section')).toBeVisible();
    await expect(page.getByTestId('store-card').first()).toBeVisible();
    await expect(page.getByTestId('cash-pickup').first()).toBeVisible();

    // Read it, clear it.
    const before = await feedRows.count();
    expect(before).toBeGreaterThan(0);
    await page.getByTestId('ops-feed-select-all').check();
    await page.getByTestId('ops-feed-clear').click();
    // Redesign 2026-09-04: clearing asks for a confirmation first.
    await page
      .getByTestId('ops-feed-clear-confirm')
      .getByRole('button', { name: 'Clear items' })
      .click();
    await expect(writeDown).toHaveCount(0);

    // The sign-off is durable, not just a hidden row in this tab.
    await page.reload();
    await expect(page.getByTestId('operations-dashboard')).toBeVisible();
    await expect(
      page.getByTestId('ops-feed-row').filter({ hasText: 'Forklift through the pallet' }),
    ).toHaveCount(0);
  });
});
