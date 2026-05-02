import { test, expect } from '@playwright/test';
import { adminLogin, ADMIN_NEW_PW, openAdminPage } from './helpers.js';

test('approver inbox: admin sees submitted change in Approvals, approves it, badge clears', async ({ page }) => {
  await adminLogin(page);

  // Create a submitter "bob" so we have someone other than admin to submit a change.
  await openAdminPage(page, 'Users');
  await page.getByRole('button', { name: '+ New user' }).click();
  await page.getByLabel('Username', { exact: true }).fill('bob');
  await page.getByLabel('Initial password', { exact: true }).fill('BobInitialPwd1234');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('cell', { name: 'bob' })).toBeVisible();

  // Sign out, sign in as bob, change forced password, submit a change.
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL(/\/login/);
  await page.locator('input').first().fill('bob');
  await page.locator('input[type=password]').first().fill('BobInitialPwd1234');
  await page.getByRole('button', { name: /sign in/i }).click();

  // Forced password change for bob
  await expect(page.getByText(/set a new password/i)).toBeVisible();
  await page.locator('input[type=password]').nth(0).fill('BobInitialPwd1234');
  await page.locator('input[type=password]').nth(1).fill('BobNewSecure1234');
  await page.locator('input[type=password]').nth(2).fill('BobNewSecure1234');
  await page.getByRole('button', { name: /update password/i }).click();
  await page.waitForSelector('header.topbar', { state: 'visible' });

  // Bob creates and submits a change.
  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('server_reboot');
  await page.getByLabel('Title', { exact: true }).fill('Approvals E2E reboot');
  await page.getByLabel('Hostname / FQDN').fill('e2e.local');
  await page.getByLabel('Reason for reboot').fill('Test approvals flow');
  await page.getByLabel('Expected downtime (minutes)').fill('10');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await page.getByRole('button', { name: /submit for approval/i }).click();
  await expect(page.locator('span.badge.submitted')).toBeVisible();

  // Bob signs out, admin signs in.
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL(/\/login/);
  await page.locator('input').first().fill('admin');
  await page.locator('input[type=password]').first().fill(ADMIN_NEW_PW);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForSelector('header.topbar', { state: 'visible' });

  // Admin sees the Approvals badge with count.
  const badge = page.getByTestId('awaiting-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/^[1-9]\d*$/);

  // Click the Approvals link in the topbar (scoped to avoid matching the change title).
  await page.locator('header.topbar a.approvals-link').click();
  await expect(page.getByRole('heading', { name: 'Awaiting my approval' })).toBeVisible();
  await page.getByRole('link', { name: 'Approvals E2E reboot' }).click();
  await page.getByRole('button', { name: /^Approve$/ }).click();
  await expect(page.locator('span.badge.approved')).toBeVisible();

  // Badge disappears (no more pending). It polls every 60s but is also
  // refetched when we navigate; force a navigation back to /changes to
  // re-evaluate quickly.
  await page.goto('/changes');
  await expect(page.getByTestId('awaiting-badge')).toHaveCount(0);
});

test('auto-approve: admin marks a type auto-approve, submission goes straight to approved', async ({ page }) => {
  await adminLogin(page);

  // Open Change Types admin → Edit server_reboot → check Auto-approve → save.
  await openAdminPage(page, 'Change types');
  // Find the row for server_reboot and click Edit.
  await page.locator('tr', { has: page.locator('code', { hasText: 'server_reboot' }) }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Auto-approve', { exact: true }).check();
  // Save.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Back on the list — the row should now show "auto-approve" badge.
  await expect(page.locator('tr', { has: page.locator('code', { hasText: 'server_reboot' }) })
    .locator('span.badge.approved'))
    .toContainText(/auto-approve/i);

  // Now submit a change of that type — admins are the submitter here, which
  // is fine because auto-approve doesn't go through anyone else.
  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('server_reboot');
  await page.getByLabel('Title', { exact: true }).fill('Standard reboot');
  await page.getByLabel('Hostname / FQDN').fill('std.local');
  await page.getByLabel('Reason for reboot').fill('Routine');
  await page.getByLabel('Expected downtime (minutes)').fill('3');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await page.getByRole('button', { name: /submit for approval/i }).click();

  // Status badge should be "approved", not "submitted" — it skipped the gate.
  await expect(page.locator('span.badge.approved')).toBeVisible();

  // The detail page's Approval policy section says auto-approve.
  await expect(page.getByText(/configured for auto-approval/i)).toBeVisible();
});
