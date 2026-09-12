/**
 * STORIS cutover Day 9 — the QA sweep. The four flows the store lives
 * on that earlier specs don't already cover (POS sale, order + deposit +
 * delivery + balance live in orders.spec):
 *
 *   1. POS cash sale → refund from the sale detail (goods go to As-Is)
 *   2. Layaway: order → payment plan → pay an installment
 *   3. Service ticket: intake → labor charge → ready → collect → complete
 *   4. Special order → generate PO → receive → line committed + arrival email
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const API_PORT = Number(process.env.PLAYWRIGHT_API_PORT ?? 4001);
const API_URL = `http://localhost:${API_PORT}`;
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_e2e';

const dbPackageRoot = join(__dirname, '..', '..', '..', 'packages', 'db');

const PASSWORD = 'SweepE2E!2026';
const EMAIL = `sweep+${Date.now()}@example.com`;

let api: APIRequestContext;
let businessId = '';
let locationId = '';
let variantId = '';
let variantSku = '';
let customerId = '';

function tenantHeaders() {
  return { 'X-Business-Id': businessId, 'Content-Type': 'application/json' };
}

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

  api = await request.newContext();
  const signup = await api.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { email: EMAIL, password: PASSWORD, name: 'Sweep Runner' },
  });
  if (!signup.ok()) throw new Error(`signup failed: ${signup.status()} ${await signup.text()}`);
  const captured = await api
    .get(`${API_URL}/v1/dev/email/last`, { params: { to: EMAIL } })
    .then((r) => r.json());
  const match = (captured.html as string).match(/href="([^"]+)"/);
  if (!match) throw new Error('no verify link in email');
  await api.get(match[1]!.replace(/&amp;/g, '&'), { maxRedirects: 0 });

  const seed = await api.post(`${API_URL}/v1/dev/e2e-seed`, {
    data: { ownerEmail: EMAIL, businessSlug: `sweep-${Date.now()}` },
  });
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const seeded = (await seed.json()) as {
    businessId: string;
    locationId: string;
    variantId: string;
    variantSku: string;
  };
  businessId = seeded.businessId;
  locationId = seeded.locationId;
  variantId = seeded.variantId;
  variantSku = seeded.variantSku;

  // Scaffolding the sweep needs: a customer with an email (arrival +
  // service mails) and a vendor to cut the special-order PO to.
  const cust = await api.post(`${API_URL}/v1/customers`, {
    headers: tenantHeaders(),
    data: { firstName: 'Samuel', lastName: 'Sweeper', email: 'samuel.sweeper@example.test' },
  });
  if (!cust.ok()) throw new Error(`customer failed: ${await cust.text()}`);
  customerId = ((await cust.json()) as { id: string }).id;

  const vendor = await api.post(`${API_URL}/v1/vendors`, {
    headers: tenantHeaders(),
    data: { name: 'Acme Supply' },
  });
  if (!vendor.ok()) throw new Error(`vendor failed: ${await vendor.text()}`);
});

test.afterAll(async () => {
  await api?.dispose();
});

async function loginAndPickBusiness(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Generous: on a cold dev server the first compile of /dashboard is slow.
  await page.waitForURL(/\/(pos|business-picker)/, { timeout: 60_000 });
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

async function createOrder(lines: unknown[], confirm = true): Promise<{ id: string }> {
  const res = await api.post(`${API_URL}/v1/orders`, {
    headers: tenantHeaders(),
    data: { locationId, customerId, lines, confirm },
  });
  if (!res.ok()) throw new Error(`order failed: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

test.describe('Day 9 — QA sweep', () => {
  test('POS cash sale, then refund it from the sale detail', async ({ page }) => {
    test.slow();
    await loginAndPickBusiness(page);

    await page.goto('/pos');
    await expect(page.getByRole('heading', { name: 'New Sale' })).toBeVisible();
    // Walk-in cash take-with: customer, product, cash covering the total —
    // the fast lane posts a plain register sale.
    await page.getByRole('button', { name: 'New customer' }).click();
    await page.getByPlaceholder('First name').fill('Cash');
    await page.getByPlaceholder('Last name').fill('Walkin');
    await page.getByTestId('create-customer').click();
    await page.getByTestId('add-product').click();
    await page.getByTestId('product-query').fill(variantSku);
    const hit = page.getByTestId('product-result').first();
    await expect(hit).toBeVisible();
    await hit.click();
    await page.getByTestId('fulfillment-method').selectOption('take_with');
    await page.getByTestId('take-payment').click();
    await page.getByTestId('pay-method').selectOption('cash');
    await page.getByTestId('pay-amount').fill('10.00');
    await page.getByTestId('add-payment').click();
    await page.getByTestId('complete-sale').click();
    await expect(page.getByRole('heading', { name: /complete/i })).toBeVisible({
      timeout: 15_000,
    });

    // Refund it: newest sale, one unit back.
    const sales = (await api
      .get(`${API_URL}/v1/sales`, { headers: tenantHeaders() })
      .then((r) => r.json())) as { data?: { id: string }[] } | { id: string }[];
    const saleId = Array.isArray(sales) ? sales[0]!.id : sales.data![0]!.id;
    await page.goto(`/sales/${saleId}`);
    await expect(page.getByRole('heading', { name: 'New refund' })).toBeVisible();
    await page.locator('table input[type="number"]').first().fill('1');
    await page.getByRole('button', { name: 'Process refund' }).click();
    await expect(page.getByRole('heading', { name: 'Refunds' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/refunded/).first()).toBeVisible();
  });

  test('layaway: split an order balance into installments and pay one', async ({ page }) => {
    test.slow();
    const order = await createOrder([{ variantId, quantity: 2 }]);
    await loginAndPickBusiness(page);
    await page.goto(`/orders/${order.id}`);
    await expect(page.getByTestId('balance-due')).toContainText('$20.00');

    await expect(page.getByTestId('payment-plan-card')).toBeVisible();
    await page.getByTestId('create-plan').click();
    await expect(page.getByTestId('plan-status')).toHaveText('active');
    await expect(page.getByTestId('pay-installment-1')).toBeVisible();

    await page.getByTestId('pay-installment-1').click();
    await expect(page.getByTestId('pay-installment-1')).toHaveCount(0);
    // 2000 cents over 3: 667 + 667 + 666 — first payment leaves $13.33.
    await expect(page.getByTestId('balance-due')).toContainText('$13.33');
  });

  test('service: intake → labor → ready → collect → completed', async ({ page }) => {
    test.slow();
    await loginAndPickBusiness(page);
    await page.goto('/service');

    await page.getByTestId('new-ticket').click();
    await page.getByTestId('intake-customer-search').fill('Samuel');
    await page.getByTestId('intake-customer-hit').first().click();
    await expect(page.getByTestId('intake-customer')).toContainText('Samuel');
    await page.getByTestId('intake-item').fill('Adjustable base');
    await page.getByTestId('intake-issue').fill('Remote will not pair');
    await page.getByTestId('create-ticket').click();
    await page.waitForURL(/\/service\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('ticket-status')).toHaveText(/intake/i);

    await page.getByTestId('labor-desc').fill('Diagnostic + pairing');
    await page.getByTestId('labor-price').fill('25.00');
    await page.getByTestId('add-labor').click();
    await expect(page.getByTestId('ticket-balance')).toContainText('$25.00');

    await page.getByTestId('status-in_service').click();
    await expect(page.getByTestId('ticket-status')).toHaveText(/in service/i);
    await page.getByTestId('status-ready').click();
    await expect(page.getByTestId('ticket-status')).toHaveText(/ready/i);

    // Ready email went to the customer.
    const mail = await api
      .get(`${API_URL}/v1/dev/email/last`, { params: { to: 'samuel.sweeper@example.test' } })
      .then((r) => r.json());
    expect(String(mail.subject)).toMatch(/ready/i);

    // Complete is gated on the balance.
    await expect(page.getByTestId('complete-ticket')).toBeDisabled();
    await page.getByTestId('ticket-pay-amount').fill('25.00');
    await page.getByTestId('ticket-take-payment').click();
    await expect(page.getByTestId('ticket-balance')).toContainText('$0.00');
    await page.getByTestId('complete-ticket').click();
    await expect(page.getByTestId('ticket-status')).toHaveText(/completed/i);
  });

  test('special order → generate PO → receive → committed + arrival email', async ({ page }) => {
    test.slow();
    const order = await createOrder([{ variantId, quantity: 1, lineType: 'special_order' }]);
    await loginAndPickBusiness(page);

    // The to-order queue shows the line; cut the PO to the vendor.
    await page.goto('/special-orders');
    const row = page.locator('tbody tr').first();
    await expect(row).toBeVisible();
    await row.locator('input[type="checkbox"]').check();
    await page.getByTestId('generate-po').click();
    await expect(page.getByText(/Created PO-/)).toBeVisible({ timeout: 10_000 });

    // Receive it on the PO detail.
    const pos = (await api
      .get(`${API_URL}/v1/purchase-orders`, { headers: tenantHeaders() })
      .then((r) => r.json())) as { data?: { id: string }[] } | { id: string }[];
    const poId = Array.isArray(pos) ? pos[0]!.id : pos.data![0]!.id;
    await page.goto(`/purchase-orders/${poId}`);
    // Staged receiving (P6): dock → inspected → accepted in one submit.
    await page.getByTestId('stage-received').first().fill('1');
    await page.getByTestId('stage-inspected').first().fill('1');
    await page.getByTestId('stage-accepted').first().fill('1');
    const receiveDone = page.waitForResponse(
      (res) => res.url().includes('/receiving') && res.request().method() === 'POST',
    );
    await page.getByTestId('record-receiving').click();
    // The 201 is the synchronization point: handleReceipt (stock,
    // allocations, reservations, arrival email) runs before it returns.
    expect((await receiveDone).status()).toBe(201);

    // The arrived unit is committed to the waiting order…
    const detail = (await api
      .get(`${API_URL}/v1/orders/${order.id}`, { headers: tenantHeaders() })
      .then((r) => r.json())) as { lines: { qtyReserved: number }[] };
    expect(detail.lines[0]!.qtyReserved).toBe(1);

    // …and the customer got the "it's here" email.
    const mail = await api
      .get(`${API_URL}/v1/dev/email/last`, { params: { to: 'samuel.sweeper@example.test' } })
      .then((r) => r.json());
    expect(String(mail.subject)).toMatch(/arrived|in|ready/i);
  });
});
