import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('admin can create a digest schedule and see it listed', async ({ page }) => {
  await adminLogin(page);

  await page.getByRole('link', { name: 'Digests', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/digests/);
  await expect(page.getByRole('heading', { name: 'Digest schedules' })).toBeVisible();

  await page.getByRole('button', { name: '+ New digest' }).click();
  await page.getByLabel('Name').fill('E2E Daily 6pm');
  await page.getByLabel('Cron expression').fill('0 18 * * *');
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByLabel('Recipient emails').fill('ops@example.com');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByRole('cell', { name: 'E2E Daily 6pm' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '0 18 * * *' })).toBeVisible();
});

test('upcoming view is reachable from the topbar with both list and calendar modes', async ({ page }) => {
  await adminLogin(page);

  await page.getByRole('link', { name: 'Upcoming', exact: true }).click();
  await expect(page).toHaveURL(/\/upcoming/);
  await expect(page.getByRole('heading', { name: 'Upcoming changes' })).toBeVisible();

  // Default mode = list. Toggle to calendar.
  await page.getByRole('button', { name: 'Calendar' }).click();
  // The calendar grid renders weekday headers.
  await expect(page.locator('.cal-head').first()).toBeVisible();

  // Toggle back.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  // List mode shows the "Next 14 days" hint.
  await expect(page.getByText(/Next 14 days/)).toBeVisible();
});
