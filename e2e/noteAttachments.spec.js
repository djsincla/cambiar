import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

// 1×1 PNG as a buffer.
const PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
);

test('attach a file under a note — chip appears, deleting the note removes it', async ({ page }) => {
  await adminLogin(page);

  // Draft change to attach notes to.
  await page.goto('/changes/new');
  await page.getByLabel('Change type').selectOption('generic');
  await page.getByLabel('Title', { exact: true }).fill('Note-attachments E2E ' + Date.now());
  await page.getByLabel('Change details').fill('seed');
  await page.getByRole('button', { name: /save as draft/i }).click();
  await expect(page).toHaveURL(/\/changes\/\d+$/);

  // Post a note.
  await page.getByLabel('New note').fill('investigation step 1');
  await page.getByRole('button', { name: 'Post note' }).click();
  const noteItem = page.locator('.note-item').filter({ hasText: 'investigation step 1' });
  await expect(noteItem).toBeVisible();

  // Attach a file under that note. The file input is hidden — fire a
  // setInputFiles directly on the input that lives inside the note row.
  const fileInput = noteItem.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: PNG_BUFFER });

  // Threaded chip with the filename appears under that note.
  await expect(noteItem.locator('text=evidence.png')).toBeVisible();

  // Change-wide Attachments panel below remains empty (or at least doesn't
  // include this file — it's threaded, not change-wide).
  const widePanel = page.locator('.panel', { has: page.getByRole('heading', { name: /^Attachments$/ }) });
  await expect(widePanel.locator('text=evidence.png')).toHaveCount(0);

  // Delete the note → cascade removes the chip.
  page.once('dialog', d => d.accept());
  await noteItem.getByRole('button', { name: /^Delete$/ }).click();
  await expect(page.locator('text=evidence.png')).toHaveCount(0);
});
