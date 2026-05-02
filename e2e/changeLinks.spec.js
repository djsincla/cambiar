import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers.js';

// Verifies the depends_on gate end-to-end: a dependent change can't be
// started while its prereq is still open, and the Start button enables once
// the prereq is implemented.
//
// Setup uses the JSON API rather than driving the UI through approval —
// admins can't approve their own submissions (submitter ≠ approver), so
// going through the UI here would need a second user. The interesting bit
// is the gate, so we shortcut to two approved changes via API.
test('depends_on link blocks Start until prereq is implemented', async ({ page }) => {
  await adminLogin(page);

  // Two changes via API, both moved into 'approved' state.
  async function makeApproved(title) {
    const create = await page.request.post('/api/changes', {
      data: {
        typeKey: 'generic',
        title,
        description: 'links e2e',
        fields: { details: 'details' },
        plannedDurationMinutes: 30,
      },
    });
    expect(create.ok()).toBeTruthy();
    const id = (await create.json()).change.id;
    // generic has no approver groups → falls back to "approver role"; admin
    // has admin role which always approves. But submitter ≠ approver. So
    // flip auto-approve on for generic just for these two creations? No —
    // simplest path: poke the DB-effective shortcut by using the
    // change-types admin API to give 'generic' auto-approve, create both
    // changes, then revert. Cleaner still: directly approve via the API
    // surface as someone other than admin. Simplest: temporarily make
    // generic auto-approve. Tests run serially so revert at end is safe.
    return id;
  }

  // Make 'generic' auto-approve for the duration of this test.
  const types = (await (await page.request.get('/api/change-types')).json()).types;
  const generic = types.find(t => t.key === 'generic');
  await page.request.patch(`/api/change-types/${generic.id}`, { data: { autoApprove: true } });

  // Now creating + submitting a 'generic' change auto-approves it.
  async function makeAutoApproved(title) {
    const create = await page.request.post('/api/changes', {
      data: { typeKey: 'generic', title, description: 'links e2e', fields: { details: 'x' }, plannedDurationMinutes: 30 },
    });
    expect(create.ok()).toBeTruthy();
    const id = (await create.json()).change.id;
    const submit = await page.request.post(`/api/changes/${id}/submit`);
    expect(submit.ok()).toBeTruthy();
    return id;
  }

  try {
    const stamp = Date.now();
    const prereqId = await makeAutoApproved(`LINK-prereq-${stamp}`);
    const dependentId = await makeAutoApproved(`LINK-dependent-${stamp}`);

    // Link dependent → prereq via the UI (this is the bit we're testing).
    await page.goto(`/changes/${dependentId}`);
    await page.getByRole('button', { name: /\+ Link a change/i }).click();
    await page.getByLabel('Other change ID').fill(String(prereqId));
    await page.getByRole('button', { name: /^Add link$/i }).click();

    // Blocked banner appears; Start button is disabled.
    await expect(page.locator('text=Blocked by 1 unfinished prerequisite').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /start implementation/i })).toBeDisabled();

    // Implement the prereq via API (UI flow tested elsewhere).
    const impl = await page.request.post(`/api/changes/${prereqId}/implement`, {
      data: { actualDurationMinutes: 5 },
    });
    expect(impl.ok()).toBeTruthy();

    // Refresh dependent — Start is now enabled.
    await page.goto(`/changes/${dependentId}`);
    await expect(page.getByRole('button', { name: /start implementation/i })).toBeEnabled();
  } finally {
    // Revert auto-approve on generic so we don't bleed into other specs.
    await page.request.patch(`/api/change-types/${generic.id}`, { data: { autoApprove: false } });
  }
});
