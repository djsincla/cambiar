import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('add a note to a change, see it in the timeline', async ({ page }) => {
  await adminLogin(page);

  // Quick draft to attach a note to.
  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('generic');
  await page.getByLabel('Title', { exact: true }).fill('Notes-test change');
  await page.getByLabel('Change details').fill('Need notes on this');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await expect(page).toHaveURL(/\/changes\/\d+$/);

  await page.getByLabel('New note').fill('First note **with bold**');
  await page.getByRole('button', { name: 'Post note' }).click();

  await expect(page.locator('.note-item').first()).toContainText('First note');
  await expect(page.locator('.note-item .markdown strong')).toContainText('with bold');
});

test('save a change as a template, then start a new change from it', async ({ page }) => {
  await adminLogin(page);

  // Create a source change.
  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('generic');
  await page.getByLabel('Title', { exact: true }).fill('Template source');
  await page.getByLabel('Change details').fill('Pre-filled details');
  await page.getByLabel('Planned duration').fill('45');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await expect(page).toHaveURL(/\/changes\/\d+$/);

  // Save as template.
  await page.getByRole('button', { name: 'Save as template' }).click();
  await page.getByLabel('Template name').fill('e2e-template-source');
  await page.getByRole('button', { name: 'Save template' }).click();

  // We land on /templates listing.
  await expect(page).toHaveURL(/\/templates/);
  await expect(page.getByRole('cell', { name: 'e2e-template-source' })).toBeVisible();

  // Click "Start a change" → new-change form pre-filled.
  await page.getByRole('row', { name: /e2e-template-source/ }).getByRole('button', { name: 'Start a change' }).click();
  await expect(page).toHaveURL(/\/changes\/new\?templateId=\d+/);
  await expect(page.getByText(/Pre-filled from template/i)).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Template source');
  await expect(page.getByLabel('Planned duration')).toHaveValue('45');
});

test('copy an existing change to a new draft', async ({ page }) => {
  await adminLogin(page);

  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('generic');
  await page.getByLabel('Title', { exact: true }).fill('Copy-source');
  await page.getByLabel('Change details').fill('Will be copied');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await expect(page).toHaveURL(/\/changes\/\d+$/);

  await page.getByRole('button', { name: 'Copy as new change' }).click();
  await expect(page).toHaveURL(/\/changes\/new\?copyFrom=\d+/);
  await expect(page.getByText(/Copying from change/i)).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Copy of Copy-source');
});
