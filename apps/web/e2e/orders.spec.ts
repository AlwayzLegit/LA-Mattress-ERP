/**
 * STORIS cutover Day 2 acceptance: write an order with a deposit
 * end-to-end in the browser, and see the committed quantity in the
 * inventory view.
 *
 * Flow: order writer (/orders/new) → search, add a line, attach a
 * customer, confirm → order detail shows OPEN with the line reserved →
 * take a cash deposit → paid/balance move → /inventory shows the
 * reserved unit → the orders table row opens the slide-over, whose
 * full-page link lands back on the order. Then the POS variant: cart →
 * "Save as order / take deposit" → confirmed order with the deposit
 * already posted.
 */
import { expect, request, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const API_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 4001);
const API_URL = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_e2e';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');

const PASSWORD = 'OrdersE2E!2026';
const EMAIL = `orders+${Date.now()}@example.com`;

let businessId = '';
let variantSku = '';

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
    data: { email: EMAIL, password: PASSWORD, name: 'Order Writer' },
  });
  if (!signup.ok()) {
    throw new Error(`signup failed: ${signup.status()} ${await signup.text()}`);
  }
  const captured = await api
    .get(`${API_URL}/v1/dev/email/last`, { params: { to: EMAIL } })
    .then((r) => r.json());
  const match = (captured.html as string).match(/href="([^"]+)"/);
  if (!match) throw new Error('no verify link in email');
  await api.get(match[1]!.replace(/&amp;/g, '&'), { maxRedirects: 0 });

  const seed = await api.post(`${API_URL}/v1/dev/e2e-seed`, {
    data: { ownerEmail: EMAIL, businessSlug: `orders-${Date.now()}` },
  });
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const seeded = (await seed.json()) as { businessId: string; variantSku: string };
  businessId = seeded.businessId;
  variantSku = seeded.variantSku;
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

/**
 * Record a cash payment at the register. Complete stays disabled until the
 * order carries money (no-money completion gate); cash needs no brand or
 * term, so it is the shortest path through the payment panel.
 */
async function payCashAtRegister(page: Page, amount: string) {
  await page.getByTestId('take-payment').click();
  await page.getByTestId('pay-method').selectOption('cash');
  await page.getByTestId('pay-amount').fill(amount);
  await page.getByTestId('add-payment').click();
  // The panel closes itself once the balance is paid; otherwise close it.
  const done = page.getByTestId('pay-done');
  if (await done.isVisible()) await done.click();
}

/** Record a cash payment on the full order page (card is the default tender and needs a brand). */
async function payCashOnOrder(page: Page, amount: string) {
  await page.getByTestId('order-pay-method').selectOption('cash');
  await page.getByTestId('payment-amount').fill(amount);
  await page.getByTestId('take-payment').click();
}

/**
 * Redesign Phase 6: `/orders/[id]` is the slide-over over the book — the
 * quick answer. Editing lines, taking money and scheduling happen on the
 * full order page at `/orders/[id]/full`.
 */
async function openFullOrder(page: Page) {
  const m = /\/orders\/([0-9a-f-]{36})/.exec(page.url());
  if (!m) throw new Error(`not on an order: ${page.url()}`);
  await page.goto(`/orders/${m[1]}/full`);
  await expect(page.getByTestId('order-status')).toBeVisible();
}

test.describe('Day 2 — order writer', () => {
  test('write order → deposit → committed stock visible → board', async ({ page }) => {
    test.slow();
    await loginAndPickBusiness(page);

    // --- Write the order ---
    await page.goto('/orders/new');
    // Single-screen New Sale: create the customer inline...
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.getByPlaceholder('First name').fill('Dana');
    await page.getByPlaceholder('Last name').fill('Buyer');
    await page.getByTestId('create-customer').click();
    await expect(page.getByTestId('order-customer')).toContainText('Dana Buyer');

    // ...add the product through the popup search...
    await page.getByTestId('add-product').click();
    await page.getByTestId('product-query').fill(variantSku);
    const result = page.getByTestId('product-result').first();
    await expect(result).toBeVisible();
    await result.click();

    // ...take a $2.50 deposit (Complete needs money on the order), and complete.
    await payCashAtRegister(page, '2.50');
    await page.getByTestId('complete-sale').click();
    await page.getByRole('button', { name: 'Open order' }).click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);

    // --- Detail: open, line reserved, the register deposit on it ---
    await expect(page.getByTestId('order-status')).toHaveText(/reserved/i);
    await openFullOrder(page);
    const lineRow = page.locator('tbody tr').first();
    await expect(lineRow).toContainText('Widget'); // seeded product name
    // Columns mirror New Sale (item, type, qty, price, disc, fulfillment,
    // from, amount); the reserved count sits under the item name —
    // confirming committed the full quantity.
    await expect(lineRow.getByTestId('order-line-qty')).toHaveValue('1');
    await expect(lineRow).toContainText('1 reserved');
    await expect(lineRow.getByTestId('order-line-price')).toHaveValue('10.00');
    await expect(page.getByTestId('balance-due')).toContainText('$7.50');

    // --- Take a second deposit on the detail page ---
    await payCashOnOrder(page, '2.50');
    // The register's money is the deposit; a later payment is against the balance.
    await expect(page.locator('tbody tr', { hasText: 'deposit' })).toContainText('$2.50');
    await expect(page.locator('tbody tr', { hasText: 'balance' })).toContainText('$2.50');
    await expect(page.getByTestId('balance-due')).toContainText('$5.00');
    const orderId = /\/orders\/([0-9a-f-]{36})/.exec(page.url())![1]!;

    // --- Committed stock visible in inventory ---
    await page.goto('/inventory');
    const invRow = page.locator('tr', { hasText: variantSku });
    await expect(invRow).toBeVisible();
    // Columns: product, sku, barcode, on hand, reserved, floor, available.
    await expect(invRow.locator('td').nth(3)).toHaveText('100');
    await expect(invRow.locator('td').nth(4)).toHaveText('1');
    await expect(invRow.locator('td').nth(6)).toHaveText('99');

    // --- Orders book: the row opens the order's slide-over at /orders/[id] ---
    await page.goto('/orders');
    await expect(page.getByTestId('orders-table')).toBeVisible();
    await page.getByTestId('order-row').first().click();
    await page.waitForURL(new RegExp(`/orders/${orderId}(\\?.*)?$`));
    await expect(page.getByTestId('order-sheet')).toBeVisible();
    await expect(page.getByTestId('order-status')).toBeVisible();

    // --- View Customer Activity: lookup → open orders and deposits agree with the order ---
    await page.goto('/customers/activity');
    await page.getByTestId('activity-lookup').fill('Dana');
    await page.getByTestId('activity-lookup-hit').first().click();
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}\/activity$/);
    await expect(page.getByTestId('activity-name')).toContainText('Dana Buyer');
    await page.getByTestId('activity-tab-open-orders').click();
    await expect(page.getByTestId('open-order-row')).toHaveCount(1);
    await expect(page.getByTestId('sum-deposits')).toContainText('$5.00');
    await expect(page.getByTestId('sum-unpaid')).toContainText('$5.00');
    await page.getByTestId('activity-tab-deposits').click();
    await expect(page.getByTestId('deposits-total')).toContainText('$5.00');
    await page.getByTestId('activity-tab-order-lines').click();
    await expect(page.getByTestId('order-line-row').first()).toContainText('Reserved');
  });

  test('new-customer panel opens blank after Cancel, Change and a completed sale', async ({
    page,
  }) => {
    // Owner 2026-09-10: the panel kept the previous shopper's fields until a
    // reload, so "+ New customer" opened prefilled and the dedupe banner
    // fired before anyone typed. Every exit from the panel must wipe it.
    test.slow();
    await loginAndPickBusiness(page);
    await page.goto('/orders/new');
    const firstName = page.getByPlaceholder('First name');
    const openPanel = () => page.getByRole('button', { name: 'New customer' }).click();

    // Cancel.
    await openPanel();
    await firstName.fill('Stale');
    await page.getByPlaceholder('Last name').fill('Entry');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openPanel();
    await expect(firstName).toHaveValue('');
    await expect(page.getByPlaceholder('Last name')).toHaveValue('');

    // Create, then Change (customer detached; the panel must not remember them).
    await firstName.fill('Fresh');
    await page.getByPlaceholder('Last name').fill('Shopper');
    await page.getByTestId('create-customer').click();
    await expect(page.getByTestId('order-customer')).toContainText('Fresh Shopper');
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await openPanel();
    await expect(firstName).toHaveValue('');

    // Complete a sale, start the next one from the "New Sale" button.
    await firstName.fill('Second');
    await page.getByPlaceholder('Last name').fill('Shopper');
    await page.getByTestId('create-customer').click();
    await expect(page.getByTestId('order-customer')).toContainText('Second Shopper');
    await page.getByTestId('add-product').click();
    await page.getByTestId('product-query').fill(variantSku);
    const result = page.getByTestId('product-result').first();
    await expect(result).toBeVisible();
    await result.click();
    await payCashAtRegister(page, '10.00');
    await page.getByTestId('complete-sale').click();
    await page.getByTestId('new-sale-again').click();
    await openPanel();
    await expect(firstName).toHaveValue('');
    // Scoped to the panel itself: the ship-to block and the second phone
    // field also carry "phone" in their placeholders.
    await expect(
      page.getByTestId('new-customer-form').getByPlaceholder('Phone', { exact: true }),
    ).toHaveValue('');
  });

  test('delivery lifecycle: schedule → deliver → collect balance → complete', async ({ page }) => {
    test.slow();
    await loginAndPickBusiness(page);

    // Write and confirm a fresh order for 1 unit.
    await page.goto('/orders/new');
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.getByPlaceholder('First name').fill('Del');
    await page.getByPlaceholder('Last name').fill('Ivery');
    await page.getByTestId('create-customer').click();
    await expect(page.getByTestId('order-customer')).toContainText('Del Ivery');
    await page.getByTestId('add-product').click();
    await page.getByTestId('product-query').fill(variantSku);
    const result = page.getByTestId('product-result').first();
    await expect(result).toBeVisible();
    await result.click();
    await payCashAtRegister(page, '2.50');
    await page.getByTestId('complete-sale').click();
    await page.getByRole('button', { name: 'Open order' }).click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('order-status')).toHaveText(/reserved/i);
    await openFullOrder(page);

    // Schedule a delivery for today.
    const today = new Date().toISOString().slice(0, 10);
    await page.getByTestId('delivery-date').fill(today);
    await page.getByTestId('schedule-delivery').click();
    await expect(page.locator('a', { hasText: today }).first()).toBeVisible();

    // The calendar shows the stop.
    await page.goto('/deliveries');
    await expect(page.getByTestId('delivery-card').first()).toBeVisible();

    // Drive the truck: open the delivery, mark delivered.
    await page.getByTestId('delivery-card').first().click();
    await page.waitForURL(/\/deliveries\/[0-9a-f-]{36}$/);
    await page.getByTestId('mark-delivered').click();
    await expect(page.getByTestId('delivery-status')).toHaveText(/delivered/i);

    // Back on the order: fulfilled, balance still due.
    await page.getByRole('link', { name: 'Open order' }).click();
    await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('order-status')).toHaveText(/delivered/i);
    await openFullOrder(page);

    // Collect the whole balance, then complete.
    await payCashOnOrder(page, '7.50');
    await expect(page.getByTestId('balance-due')).toContainText('$0.00');
    await page.getByTestId('complete-order').click();
    await expect(page.getByTestId('order-status')).toHaveText(/delivered/i);
  });

  test('New Sale saves a confirmed order with deposit', async ({ page }) => {
    test.slow();
    await loginAndPickBusiness(page);

    await page.goto('/pos');
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.getByPlaceholder('First name').fill('Kim');
    await page.getByPlaceholder('Last name').fill('Walkin');
    await page.getByTestId('create-customer').click();
    await expect(page.getByTestId('order-customer')).toContainText('Kim Walkin');

    await page.getByTestId('add-product').click();
    await page.getByTestId('product-query').fill(variantSku);
    const result = page.getByTestId('product-result').first();
    await expect(result).toBeVisible();
    await result.click();

    // Partial payment = a deposit on a delivery order. A card tender must
    // name its brand before the register records it.
    await page.getByTestId('take-payment').click();
    await page.getByTestId('pay-method').selectOption('card');
    await page.getByTestId('pay-card-brand').selectOption('visa');
    await page.getByTestId('pay-amount').fill('2.50');
    await page.getByTestId('add-payment').click();
    await expect(page.getByTestId('balance-due')).toContainText('$7.50');
    await page.getByTestId('complete-sale').click();
    await page.getByRole('button', { name: 'Open order' }).click();

    await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('order-status')).toHaveText(/reserved/i);
    await openFullOrder(page);
    await expect(page.locator('tbody tr', { hasText: 'deposit' })).toContainText('$2.50');
    await expect(page.getByTestId('balance-due')).toContainText('$7.50');
  });
});
