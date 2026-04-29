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

test('admin sees admin nav links', async ({ page }) => {
  await adminLogin(page);
  for (const label of ['Users', 'Groups', 'Change Types', 'Settings']) {
    await expect(page.getByRole('link', { name: label })).toBeVisible();
  }
});

test('signing out returns to login screen', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
});
