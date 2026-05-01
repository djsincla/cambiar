#!/usr/bin/env node
//
// Seed demo activity into the running database.
//
// Creates two users (a submitter and an approver) if they don't exist, then
// pushes one change of every configured change type through a different point
// in the lifecycle, so the calendar / list / inboxes show varied content.
// Runs the changes through the real HTTP routes via supertest so audit_log,
// approvals, and viewer-context annotations are all populated naturally.
//
// Run from the project root or the server workspace:
//   npm run seed-activity                       # default 6 changes
//   npm run seed-activity -- --count=12         # multiply per-type
//
// The script is additive — it never deletes existing rows. Re-running it
// produces a fresh batch of "test change …" rows alongside whatever's already
// there. Demo titles are prefixed "test change <ISO timestamp>" so they're
// trivial to find or filter.

import bcrypt from 'bcrypt';
import request from 'supertest';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createApp } from '../app.js';

const DEMO_SUBMITTER = { username: 'demo', password: 'DemoPass1234', displayName: 'Demo Submitter', role: 'submitter' };
const DEMO_APPROVER  = { username: 'demo-approver', password: 'DemoPass1234', displayName: 'Demo Approver', role: 'approver' };

function nowStamp(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  // YYYY-MM-DD HH:MM in local time, suitable for a human-readable title
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoFuture(daysAhead) {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString();
}

// One valid sample fields blob per change type. Matches the required-field
// constraints in config/change-types.json.
const FIELDS_BY_TYPE = {
  server_reboot: () => ({
    host: 'render-node-07.studio.local',
    reason: 'Apply kernel security update; firmware update for NIC.',
    expected_downtime_minutes: 15,
    affected_services: 'render queue, NFS mount on /jobs',
    rollback_plan: 'Boot previous kernel from GRUB menu',
  }),
  firewall_rule: () => ({
    device: 'fw-edge-01',
    operation: 'add',
    direction: 'inbound',
    source: '10.20.0.0/16',
    destination: '10.10.5.42',
    ports: 'tcp/443',
    justification: 'Allow internal CI runners to reach artifact server.',
  }),
  software_update: () => ({
    hosts: 'render-node-01,render-node-02,render-node-03',
    package: 'nvidia-driver',
    from_version: '535.104.05',
    to_version: '550.54.14',
    release_notes_url: 'https://example.invalid/nvidia-550-notes',
    rollback_plan: 'Pin previous version via apt; reboot affected nodes.',
  }),
  storage_change: () => ({
    volume: '/jobs',
    operation: 'expand',
    capacity_change_tb: 20,
    affected_projects: 'project-aurora, project-borealis',
    downtime_window: '02:00-02:30 Saturday',
  }),
  network_change: () => ({
    device: 'sw-core-01',
    scope: 'vlan',
    ports_affected: '1/1/24 - 1/1/30',
    maintenance_window: '03:00-04:00 Sunday',
    rollback_plan: 'Revert running-config from last known-good snapshot.',
  }),
  generic: () => ({
    details: 'Reseat optical transceiver on uplink to ISP.',
    rollback_plan: 'Reinsert original transceiver if link does not come up.',
  }),
};

// What lifecycle state to leave each change in. Cycles through this list as
// we walk through the change-type catalogue, so each type lands in a
// different state. (`draft` is kept distinct from `not yet submitted` —
// drafts are owned and visible, just not in any inbox.)
const TARGET_STATES = ['draft', 'submitted', 'approved', 'in_progress', 'implemented', 'closed'];

async function ensureUser(opts) {
  const existing = db.prepare(`SELECT id FROM users WHERE username = ? AND source = 'local'`).get(opts.username);
  if (existing) return existing.id;
  const hash = bcrypt.hashSync(opts.password, 4);
  const info = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, source, role, must_change_password, active)
    VALUES (?, ?, ?, 'local', ?, 0, 1)
  `).run(opts.username, opts.displayName, hash, opts.role);
  return Number(info.lastInsertRowid);
}

async function login(app, username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

async function walkToState({ submitter, approver, changeId, target }) {
  if (target === 'draft') return;
  await submitter.post(`/api/changes/${changeId}/submit`);
  if (target === 'submitted') return;
  await approver.post(`/api/changes/${changeId}/approve`).send({ comment: 'looks good — approved' });
  if (target === 'approved') return;
  await submitter.post(`/api/changes/${changeId}/start`);
  if (target === 'in_progress') return;
  await submitter.post(`/api/changes/${changeId}/implement`).send({ actualDurationMinutes: 25 });
  if (target === 'implemented') return;
  await submitter.post(`/api/changes/${changeId}/close`);
}

async function main() {
  const argMultiplier = Number((process.argv.find(a => a.startsWith('--count=')) ?? '').split('=')[1]) || 1;

  await runMigrations();

  const submitterId = await ensureUser(DEMO_SUBMITTER);
  const approverId  = await ensureUser(DEMO_APPROVER);
  console.log(`✓ users ready  submitter=${DEMO_SUBMITTER.username} (id=${submitterId})  approver=${DEMO_APPROVER.username} (id=${approverId})`);

  const app = createApp({ httpLogger: false });
  const submitter = await login(app, DEMO_SUBMITTER.username, DEMO_SUBMITTER.password);
  const approver  = await login(app, DEMO_APPROVER.username,  DEMO_APPROVER.password);

  const types = Object.keys(FIELDS_BY_TYPE);
  let i = 0;
  let created = 0;
  for (let pass = 0; pass < argMultiplier; pass++) {
    for (const typeKey of types) {
      const stamp = nowStamp(i);
      const target = TARGET_STATES[i % TARGET_STATES.length];
      const scheduledAt = isoFuture(1 + (i % 14)); // 1 to 14 days out
      const planned = 15 + (i % 6) * 15;            // 15 / 30 / 45 / 60 / 75 / 90

      const create = await submitter.post('/api/changes').send({
        typeKey,
        title: `test change ${stamp}`,
        description: `Auto-generated by seed-activity on ${stamp}. Lifecycle target: ${target}.`,
        fields: FIELDS_BY_TYPE[typeKey](),
        scheduledAt,
        plannedDurationMinutes: planned,
      });
      if (create.status !== 201 && create.status !== 200) {
        console.error(`✗ create failed for ${typeKey}: ${create.status} ${JSON.stringify(create.body)}`);
        i++;
        continue;
      }
      const id = create.body.change.id;
      try {
        await walkToState({ submitter, approver, changeId: id, target });
      } catch (err) {
        console.error(`✗ lifecycle for #${id} (${typeKey} → ${target}) failed: ${err.message}`);
      }
      console.log(`  #${id}  ${typeKey.padEnd(16)}  →  ${target}`);
      created++;
      i++;
    }
  }

  console.log(`\n✓ seeded ${created} change(s) across ${types.length} types in ${TARGET_STATES.length} lifecycle states`);
  console.log(`  log in as ${DEMO_SUBMITTER.username} / ${DEMO_SUBMITTER.password} to see them in the UI`);
  process.exit(0);
}

main().catch(err => {
  console.error('seed-activity failed:', err);
  process.exit(1);
});
