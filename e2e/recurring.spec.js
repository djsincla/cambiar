import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('admin can mark a change recurring, spawn now, and see the child in /recurring', async ({ page }) => {
  await adminLogin(page);

  // Create a parent change.
  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('generic');
  await page.getByLabel('Title', { exact: true }).fill('Recurring smoke test');
  await page.getByLabel('Change details').fill('Parent for the recurring smoke test');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await expect(page).toHaveURL(/\/changes\/\d+$/);

  // Make it recurring.
  await page.getByRole('button', { name: 'Make recurring…' }).click();
  await page.getByLabel('Cron expression').fill('0 2 * * *');
  await page.getByLabel('Time zone').fill('UTC');
  await page.getByLabel('Lead minutes').fill('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Read-only recurrence panel now visible.
  await expect(page.getByRole('cell', { name: '0 2 * * *' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Spawn now' })).toBeVisible();

  // Spawn a child immediately.
  await page.getByRole('button', { name: 'Spawn now' }).click();
  await expect(page.locator('h3', { hasText: 'Recent children' })).toBeVisible();

  // /recurring lists the parent.
  await page.getByRole('link', { name: 'Recurring', exact: true }).click();
  await expect(page).toHaveURL(/\/recurring/);
  await expect(page.getByRole('cell', { name: 'Recurring smoke test' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '0 2 * * *' })).toBeVisible();
});
