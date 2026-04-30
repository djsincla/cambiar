import { test, expect } from '@playwright/test';
import { adminLogin, ADMIN_NEW_PW } from './helpers.js';

test('approved → start → implement flow with audit and badge transitions', async ({ page }) => {
  await adminLogin(page);

  // Need a second user so admin can approve someone else's submission.
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByRole('button', { name: '+ New user' }).click();
  await page.getByLabel('Username', { exact: true }).fill('carl');
  await page.getByLabel('Initial password', { exact: true }).fill('CarlInitialPwd1234');
  await page.getByRole('button', { name: 'Create user' }).click();
  // Wait for the new row to appear before navigating away — otherwise the
  // sign-out can race the create POST.
  await expect(page.getByRole('cell', { name: 'carl', exact: true })).toBeVisible();

  // Sign in as carl, change forced password, submit a change.
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL(/\/login/);
  await page.locator('input').first().fill('carl');
  await page.locator('input[type=password]').first().fill('CarlInitialPwd1234');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText(/set a new password/i)).toBeVisible();
  await page.locator('input[type=password]').nth(0).fill('CarlInitialPwd1234');
  await page.locator('input[type=password]').nth(1).fill('CarlNewSecure1234');
  await page.locator('input[type=password]').nth(2).fill('CarlNewSecure1234');
  await page.getByRole('button', { name: /update password/i }).click();
  await page.waitForSelector('header.topbar', { state: 'visible' });

  await page.goto('/changes/new');
  // Use 'generic' to avoid colliding with state from earlier tests that flip
  // server_reboot to auto-approve.
  await page.getByLabel('Change type').selectOption('generic');
  await page.getByLabel('Title', { exact: true }).fill('In-progress flow test');
  await page.getByLabel('Change details').fill('Testing the in_progress lifecycle');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await page.getByRole('button', { name: /submit for approval/i }).click();
  // Wait for the submit POST to land before signing out — otherwise the
  // sign-out can race the request and admin never sees the change.
  await expect(page.locator('span.badge.submitted')).toBeVisible();

  // Sign back in as admin and approve.
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL(/\/login/);
  await page.locator('input').first().fill('admin');
  await page.locator('input[type=password]').first().fill(ADMIN_NEW_PW);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForSelector('header.topbar', { state: 'visible' });

  await page.locator('header.topbar a.approvals-link').click();
  await page.getByRole('link', { name: 'In-progress flow test' }).click();
  await page.getByRole('button', { name: /^Approve$/ }).click();
  await expect(page.locator('span.badge.approved')).toBeVisible();

  // Start implementation.
  await page.getByRole('button', { name: 'Start implementation' }).click();
  await expect(page.locator('span.badge.in_progress')).toBeVisible();
  await expect(page.getByText('Implementation in progress')).toBeVisible();

  // Mark implemented.
  await page.getByRole('button', { name: 'Mark implemented' }).click();
  await expect(page.locator('span.badge.implemented')).toBeVisible();

  // History (audit) shows the start row.
  await expect(page.getByText(/start.*approved.*in_progress/i).first()).toBeVisible();
});
