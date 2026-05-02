import { test, expect } from '@playwright/test';
import { adminLogin, openAdminPage } from './helpers.js';

test('admin can create a digest schedule and see it listed', async ({ page }) => {
  await adminLogin(page);

  await openAdminPage(page, 'Digests');
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

test('upcoming view: Month / Week / Day / List toggle works', async ({ page }) => {
  await adminLogin(page);

  await page.getByRole('link', { name: 'Upcoming', exact: true }).click();
  await expect(page).toHaveURL(/\/upcoming/);
  await expect(page.getByRole('heading', { name: 'Upcoming changes' })).toBeVisible();

  // Default = Month grid (weekday header row).
  await expect(page.locator('.cal-head').first()).toBeVisible();

  // Week view → time-grid with hour rows.
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.time-grid')).toBeVisible();
  await expect(page.locator('.time-hour').first()).toBeVisible();

  // Day view → still time-grid (single column).
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(page.locator('.time-grid')).toBeVisible();

  // List view → "Next 14 days" hint.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByText(/Next 14 days/)).toBeVisible();
});
