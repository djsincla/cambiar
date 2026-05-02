import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('admin can open /admin/alerts and run a check on demand', async ({ page }) => {
  await adminLogin(page);

  // Open the admin dropdown then... actually Alerts is top-level for admins.
  await page.getByRole('link', { name: /^Alerts/ }).click();
  await expect(page).toHaveURL(/\/admin\/alerts/);
  await expect(page.getByRole('heading', { name: /^Alerts/ })).toBeVisible();

  // No active alerts in a fresh DB — empty-state copy is shown.
  await expect(page.locator('text=No active alerts')).toBeVisible();

  // Run an on-demand check; UI doesn't change but the request succeeds.
  const resp = page.waitForResponse(r => r.url().includes('/api/alerts/check-now') && r.status() === 200);
  await page.getByRole('button', { name: /check now/i }).click();
  await resp;

  // Resolved tab loads (still empty).
  await page.getByRole('button', { name: /^Resolved$/i }).click();
  await expect(page.locator('text=No resolved alerts yet')).toBeVisible();
});
