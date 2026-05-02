import { test, expect } from '@playwright/test';
import { adminLogin, openAdminPage } from './helpers.js';

test('admin can create an email rule from /admin/email and see it listed', async ({ page }) => {
  await adminLogin(page);

  await openAdminPage(page, 'Email rules');
  await expect(page).toHaveURL(/\/admin\/email/);
  await expect(page.getByRole('heading', { name: 'Email ingestion' })).toBeVisible();

  await page.getByRole('button', { name: '+ New rule' }).click();
  await page.getByLabel('Name').fill('e2e-monitoring-outage');
  await page.getByLabel('From pattern').fill('^monitoring@');
  await page.getByLabel('Subject pattern').fill('OUTAGE');
  // Default action_type is create_change with a default config — keep them.
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByRole('cell', { name: 'e2e-monitoring-outage' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'OUTAGE', exact: true })).toBeVisible();
});
