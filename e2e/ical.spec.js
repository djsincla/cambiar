import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

test('iCal subscribe panel shows a token URL and rotation replaces it', async ({ page }) => {
  await adminLogin(page);

  await page.goto('/upcoming');
  await page.getByRole('button', { name: /^Subscribe…/ }).click();

  // URL field renders with /ical/upcoming.ics?token=...
  const urlField = page.getByLabel('iCal subscription URL');
  await expect(urlField).toBeVisible();
  const url1 = await urlField.inputValue();
  expect(url1).toMatch(/\/ical\/upcoming\.ics\?token=/);

  // Rotate replaces the token.
  await page.getByRole('button', { name: /Rotate token/i }).click();
  await expect.poll(() => urlField.inputValue()).not.toBe(url1);
  const url2 = await urlField.inputValue();
  expect(url2).toMatch(/\/ical\/upcoming\.ics\?token=/);

  // Public fetch with the token returns a text/calendar body.
  const ics = await page.request.get(url2);
  expect(ics.status()).toBe(200);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  const body = await ics.text();
  expect(body).toContain('BEGIN:VCALENDAR');
  expect(body).toContain('END:VCALENDAR');
});
