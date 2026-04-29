import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('admin can open the Settings page and see the logo upload form', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/admin\/settings/);
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Logo' })).toBeVisible();
  await expect(page.locator('input[type=file]')).toBeVisible();
});

test('admin can open the Groups page and create a group', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('link', { name: 'Groups' }).click();
  await expect(page).toHaveURL(/\/admin\/groups/);

  await page.getByRole('button', { name: '+ New group' }).click();
  await page.getByLabel('Name', { exact: true }).fill('E2E Reviewers');
  await page.getByLabel('Description').fill('Created by E2E');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByRole('cell', { name: 'E2E Reviewers' })).toBeVisible();
});

test('admin can open the Change Types page and see the seeded catalog', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('link', { name: 'Change Types' }).click();
  await expect(page).toHaveURL(/\/admin\/change-types/);
  await expect(page.getByRole('heading', { name: 'Change types' })).toBeVisible();
  // server_reboot is one of the seeded keys.
  await expect(page.getByText('server_reboot').first()).toBeVisible();
});

test('admin can open the Users page', async ({ page }) => {
  await adminLogin(page);
  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'admin' }).first()).toBeVisible();
});
