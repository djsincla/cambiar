import { expect } from '@playwright/test';

export const ADMIN_NEW_PW = 'AdminPass1234';

/**
 * Log in as the bootstrap admin and complete the forced password change if
 * required. Idempotent across tests in a run — falls back to ADMIN_NEW_PW
 * once the password has been changed.
 *
 * Race signal note: the post-login URL briefly hits /changes before
 * Protected bounces to /change-password, so we race on stable DOM state
 * (force-change heading vs the topbar) rather than URL.
 */
export async function adminLogin(page) {
  await page.goto('/login');

  await page.locator('input').first().fill('admin');
  await page.locator('input[type=password]').first().fill('admin');
  await page.getByRole('button', { name: /sign in/i }).click();

  const outcome = await Promise.race([
    page.waitForSelector('text=Set a new password', { state: 'visible', timeout: 5000 })
       .then(() => 'force-change').catch(() => null),
    page.waitForSelector('header.topbar', { state: 'visible', timeout: 5000 })
       .then(() => 'success').catch(() => null),
    page.waitForSelector('text=invalid credentials', { state: 'visible', timeout: 5000 })
       .then(() => 'bad-creds').catch(() => null),
  ]);

  if (outcome === 'bad-creds') {
    // Password was already changed by an earlier test — log in with the new one.
    await page.locator('input[type=password]').first().fill(ADMIN_NEW_PW);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForSelector('header.topbar', { state: 'visible' });
  } else if (outcome === 'force-change') {
    await page.locator('input[type=password]').nth(0).fill('admin');
    await page.locator('input[type=password]').nth(1).fill(ADMIN_NEW_PW);
    await page.locator('input[type=password]').nth(2).fill(ADMIN_NEW_PW);
    await page.getByRole('button', { name: /update password/i }).click();
    await page.waitForSelector('header.topbar', { state: 'visible' });
  }
  // success path: already on the main app

  await expect(page).toHaveURL(/\/changes/);
}
