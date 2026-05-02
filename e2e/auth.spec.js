import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('default admin/admin login forces password change and lands on changes list', async ({ page }) => {
  await adminLogin(page);
  await expect(page).toHaveURL(/\/changes/);
  await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible();
});

test('topbar shows the brand text when no logo is configured', async ({ page }) => {
  await adminLogin(page);
  await expect(page.locator('header.topbar .brand')).toContainText(/cambiar/i);
});

test('admin sees the Admin dropdown with all expected entries', async ({ page }) => {
  await adminLogin(page);
  // Open the dropdown and check each entry is reachable as a menuitem.
  await page.getByRole('button', { name: /^Admin/ }).click();
  for (const label of ['Users', 'Groups', 'Change types', 'Digests', 'Email rules', 'Settings']) {
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
  }
  // Alerts stays top-level (so the badge nags ops without a click).
  await expect(page.getByRole('link', { name: /^Alerts/ })).toBeVisible();
});

test('signing out returns to login screen', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
});
