import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('admin can create a server-reboot change as a draft', async ({ page }) => {
  await adminLogin(page);

  // Navigate via URL — avoids ambiguity with the "+ New change" link inside the changes table.
  await page.goto('/changes/new');
  await expect(page).toHaveURL(/\/changes\/new/);

  await page.getByLabel('Change type').selectOption('server_reboot');
  await page.getByLabel('Title', { exact: true }).fill('E2E reboot test');

  await page.getByLabel('Hostname / FQDN').fill('e2e-host.local');
  await page.getByLabel('Reason for reboot').fill('Test reboot');
  await page.getByLabel('Expected downtime (minutes)').fill('5');

  await page.getByRole('button', { name: /save as draft/i }).click();

  await expect(page).toHaveURL(/\/changes\/\d+$/);
  await expect(page.getByRole('heading', { name: /E2E reboot test/ })).toBeVisible();
  await expect(page.locator('span.badge.draft')).toBeVisible();
});

test('the change appears in the list after creation', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/changes');
  await expect(page.getByRole('link', { name: 'E2E reboot test' })).toBeVisible();
});
