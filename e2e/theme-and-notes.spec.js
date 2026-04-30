import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('theme toggle switches between dark and light, persists across reload', async ({ page }) => {
  await adminLogin(page);

  // Default is dark — the toggle shows the SUN icon (clicking would go to light).
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveAttribute('aria-label', /light mode/i);

  // Toggle to light → moon icon now shown.
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-label', /dark mode/i);

  // Reload — preference persists via localStorage.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Toggle back to dark and confirm persistence again.
  await page.getByTestId('theme-toggle').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('clicking the topbar version link opens release notes', async ({ page }) => {
  await adminLogin(page);

  // Version link sits on the right; clickable; takes you to /release-notes.
  const versionLink = page.getByTestId('version-link');
  await expect(versionLink).toBeVisible();
  await expect(versionLink).toHaveText(/^v\d+\.\d+\.\d+/);

  await versionLink.click();
  await expect(page).toHaveURL(/\/release-notes$/);
  await expect(page.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  await expect(page.locator('.markdown h2').first()).toBeVisible();
  await expect(page.getByText(/Theme toggle/)).toBeVisible();
});
