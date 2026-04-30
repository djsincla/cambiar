import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('planned duration is captured at create time and shown on detail', async ({ page }) => {
  await adminLogin(page);
  await page.goto('/changes/new');

  await page.getByLabel('Change type').selectOption('server_reboot');
  await page.getByLabel('Title', { exact: true }).fill('Duration smoke test');
  await page.getByLabel('Hostname / FQDN').fill('h.local');
  await page.getByLabel('Reason for reboot').fill('Patch');
  await page.getByLabel('Expected downtime (minutes)').fill('5');
  await page.getByLabel('Planned duration').fill('120');
  await page.getByRole('button', { name: /save as draft/i }).click();

  // Schedule panel on detail shows planned duration.
  await expect(page).toHaveURL(/\/changes\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '2h', exact: true })).toBeVisible();
});
