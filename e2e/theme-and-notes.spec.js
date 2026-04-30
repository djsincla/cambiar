import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('theme toggle switches between dark and light, persists across reload', async ({ page }) => {
  await adminLogin(page);

  // Default is dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-toggle')).toContainText(/light mode/i);

  // Toggle to light.
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle')).toContainText(/dark mode/i);

  // Reload — preference persists via localStorage.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Toggle back to dark and confirm persistence again.
  await page.getByTestId('theme-toggle').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('release notes page is reachable from the topbar and renders the changelog', async ({ page }) => {
  await adminLogin(page);

  await page.getByRole('link', { name: 'Release notes' }).click();
  await expect(page).toHaveURL(/\/release-notes$/);
  await expect(page.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();

  // The page renders the markdown — at least one version heading should appear.
  await expect(page.locator('.markdown h2').first()).toBeVisible();
  // And it should contain text from the most recent release.
  await expect(page.getByText(/Theme toggle/)).toBeVisible();
});
