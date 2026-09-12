import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const API_URL = `http://localhost:${process.env.PLAYWRIGHT_API_PORT ?? 4001}`;
const WEB_URL = `http://localhost:${process.env.PLAYWRIGHT_WEB_PORT ?? 3001}`;
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jetnine_e2e';
const PASSWORD = 'TeamE2E!2026';
const stamp = Date.now();
const OWNER = `team-owner+${stamp}@example.com`;
const TEAMMATE = `team-member+${stamp}@example.com`;
let ownerApi: APIRequestContext;
let businessId = '',
  orderId = '',
  orderNumber = '',
  teammateId = '';

test.beforeAll(async () => {
  const cwd = join(__dirname, '..', '..', '..', 'packages', 'db');
  for (const script of ['src/reset.ts', 'src/migrate.ts']) {
    execFileSync('pnpm', ['exec', 'tsx', script], {
      cwd,
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: 'inherit',
    });
  }
  ownerApi = await request.newContext({ extraHTTPHeaders: { Origin: WEB_URL } });
  const signup = await ownerApi.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { email: OWNER, password: PASSWORD, name: 'Task Creator' },
  });
  expect(signup.ok(), await signup.text()).toBe(true);
  const mail = await ownerApi
    .get(`${API_URL}/v1/dev/email/last`, { params: { to: OWNER } })
    .then((r) => r.json());
  const verify = (mail.html as string).match(/href="([^"]+)"/)![1]!;
  await ownerApi.get(verify.replace(/&amp;/g, '&'), { maxRedirects: 0 });
  const seed = await ownerApi.post(`${API_URL}/v1/dev/e2e-seed`, {
    data: { ownerEmail: OWNER, businessSlug: `team-${stamp}` },
  });
  expect(seed.ok(), await seed.text()).toBe(true);
  const seeded = await seed.json();
  businessId = seeded.businessId;
  const login = await ownerApi.post(`${API_URL}/api/auth/sign-in/email`, {
    data: { email: OWNER, password: PASSWORD },
  });
  expect(login.ok(), await login.text()).toBe(true);
  const headers = { 'x-business-id': businessId };
  // This fixture uses the seed's existing Owner role; permission restrictions
  // and Cashier/Warehouse collaboration are covered by the integration suite.
  const invite = await ownerApi.post(`${API_URL}/v1/business/members/invite`, {
    headers,
    data: { email: TEAMMATE, name: 'Team Member', roleName: 'Owner' },
  });
  expect(invite.ok(), await invite.text()).toBe(true);
  const invited = await invite.json();
  teammateId = invited.membershipId;
  const accept = await request.newContext({ extraHTTPHeaders: { Origin: WEB_URL } });
  const accepted = await accept.post(`${API_URL}/v1/auth/accept-invite`, {
    data: { token: new URL(invited.inviteLink).searchParams.get('token'), password: PASSWORD },
  });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  await accept.dispose();
  const customer = await ownerApi
    .post(`${API_URL}/v1/customers`, { headers, data: { firstName: 'Team', lastName: 'Buyer' } })
    .then((r) => r.json());
  const order = await ownerApi.post(`${API_URL}/v1/orders`, {
    headers,
    data: {
      customerId: customer.id,
      locationId: seeded.locationId,
      fulfillmentType: 'pickup',
      lines: [{ variantId: seeded.variantId, quantity: 1 }],
      confirm: true,
    },
  });
  expect(order.ok(), await order.text()).toBe(true);
  const created = await order.json();
  orderId = created.id;
  orderNumber = created.number;
});
test.afterAll(async () => {
  await ownerApi?.dispose();
});

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/(pos|business-picker)/);
  const activeBusiness = await page.request.post(`${API_URL}/v1/auth/active-business`, {
    headers: { Origin: WEB_URL },
    data: { businessId },
  });
  expect(activeBusiness.ok(), await activeBusiness.text()).toBe(true);
}

test('assign work, complete it as the owner, and persist personal note read state', async ({
  page,
  browser,
}) => {
  test.slow();
  await login(page, OWNER);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Team Tasks', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const form = page.getByTestId('task-form');
  await form.getByRole('textbox', { name: 'Find an order', exact: true }).fill(orderNumber);
  const orderSelect = form.getByRole('combobox', { name: 'Order', exact: true });
  await expect(orderSelect.locator('option')).toHaveCount(2);
  await orderSelect.selectOption(orderId);
  await form.getByRole('textbox', { name: 'Task', exact: true }).fill('Confirm delivery access');
  await form
    .getByRole('textbox', { name: 'Details', exact: true })
    .fill('Check the rear entrance before dispatch.');
  await form.getByRole('combobox', { name: 'Owner', exact: true }).selectOption(teammateId);
  await form.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('high');
  const dueInput = form.locator('input[type="datetime-local"]');
  await expect(dueInput).toBeVisible();
  await dueInput.fill('2040-01-01T10:00');
  await expect(dueInput).toHaveValue('2040-01-01T10:00');
  await form.getByRole('button', { name: 'Create task' }).click();
  await expect(form).toHaveCount(0);
  await page
    .getByRole('group', { name: 'Task queues' })
    .getByRole('button', { name: 'Team', exact: true })
    .click();
  await expect(page.getByTestId('task-row')).toContainText('Team Member');
  await expect(page.getByTestId('task-row')).not.toContainText('No deadline');

  const teammateContext = await browser.newContext({
    baseURL: WEB_URL,
  });
  const teammate = await teammateContext.newPage();
  try {
    await login(teammate, TEAMMATE);
    await teammate.goto('/tasks');
    const task = teammate.getByTestId('task-row');
    await expect(task).toContainText('Confirm delivery access');
    await task.getByRole('button', { name: 'Edit task' }).click();
    await teammate.getByRole('combobox', { name: 'Status', exact: true }).selectOption('blocked');
    await teammate.getByRole('button', { name: 'Save task' }).click();
    await expect(task).toContainText('Blocked');
    await expect(task).toContainText('Team Member');
    await expect(task).not.toContainText('No deadline');
    await task.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(task).toHaveCount(0);
    await teammate.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(task).toContainText('Done');

    await page.goto(`/orders/${orderId}/full`);
    const notes = page.getByTestId('order-notes-card');
    await notes
      .getByLabel('New note', { exact: true })
      .fill('Customer confirmed the rear entrance.');
    await notes.getByRole('checkbox', { name: 'Team Member', exact: true }).check();
    await notes.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByTestId('order-notes-list')).toContainText('Notified: Team Member');
    await teammate.getByRole('button', { name: 'Notifications', exact: true }).click();
    const inbox = teammate.getByTestId('personal-inbox');
    await inbox.getByRole('button', { name: 'Refresh inbox' }).click();
    await expect(inbox).toContainText('Customer confirmed the rear entrance.');
    await inbox.getByRole('button', { name: 'Mark shown updates read' }).click();
    await expect(inbox).toContainText('0 unread');
    await teammate.reload();
    await teammate.getByRole('button', { name: 'Notifications', exact: true }).click();
    await expect(teammate.getByTestId('personal-inbox')).toContainText('0 unread');
    await teammate
      .getByTestId('inbox-update')
      .filter({ hasText: 'Customer confirmed the rear entrance.' })
      .getByRole('link')
      .click();
    await expect(teammate.getByTestId('order-notes-list')).toContainText(
      'Customer confirmed the rear entrance.',
    );
  } finally {
    await teammateContext.close();
  }
});
