// Google Calendar event CRUD via a service-account JWT.
//
// Setup (one-time, by the workshop admin):
//   1. Google Cloud console → enable the Calendar API on the project.
//   2. Create a service account, generate a JSON key.
//   3. Save the JSON to <repo>/config/gcal-service-account.json (or
//      wherever notifications.googleCalendar.credentialsFile points).
//   4. Open the target Google Calendar's "Settings and sharing", and
//      under "Share with specific people or groups" add the service
//      account's email (it ends in iam.gserviceaccount.com) with
//      "Make changes to events" permission.
//   5. Copy that calendar's "Calendar ID" into
//      notifications.googleCalendar.calendarId, then restart Cambiar.
//
// We use the `google-auth-library` JWT directly rather than `googleapis`
// to keep the dependency graph small.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { google } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../logger.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

let cachedClient = null;

export function gcalConfig() {
  return config.notifications?.googleCalendar ?? {};
}

export function gcalEnabled() {
  const c = gcalConfig();
  if (!c?.enabled) return false;
  if (!c.calendarId) return false;
  const credPath = resolveCredentialsPath(c.credentialsFile);
  if (!credPath || !existsSync(credPath)) return false;
  return true;
}

export function gcalStatus() {
  const c = gcalConfig();
  const credPath = resolveCredentialsPath(c.credentialsFile);
  return {
    enabled: gcalEnabled(),
    configEnabled: Boolean(c?.enabled),
    calendarId: c?.calendarId ?? null,
    credentialsFile: c?.credentialsFile ?? null,
    credentialsResolved: credPath,
    credentialsExist: credPath ? existsSync(credPath) : false,
    syncIntervalMinutes: Number(c?.syncIntervalMinutes ?? 5),
  };
}

function resolveCredentialsPath(p) {
  if (!p) return null;
  return p.startsWith('/') ? p : resolve(config.repoRoot, p);
}

function getCalendarClient() {
  if (cachedClient) return cachedClient;
  const c = gcalConfig();
  const credPath = resolveCredentialsPath(c.credentialsFile);
  const raw = readFileSync(credPath, 'utf8');
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  cachedClient = google.calendar({ version: 'v3', auth });
  return cachedClient;
}

// Test seam: lets the test suite swap in a fake without touching the
// network. Pass null to clear and re-init from config on the next call.
export function setCalendarClientForTests(client) {
  cachedClient = client;
}

/**
 * Build the Google Calendar event payload for a change row. Same shape
 * (DTSTART/DTEND, summary, description, status mapping) as the iCal feed,
 * so the calendar reads consistently across both subscription paths.
 */
export function buildEventResource(change) {
  const start = new Date(change.scheduled_at);
  const durMin = change.planned_duration_minutes ?? 30;
  const end = new Date(start.getTime() + durMin * 60_000);
  const url = changeUrl(change.id);
  const description = [
    change.description ? change.description.trim() : '',
    `Status: ${change.status}`,
    `Type: ${change.type_key}`,
    `Open in Cambiar: ${url}`,
  ].filter(Boolean).join('\n');

  return {
    summary: `[Cambiar #${change.id}] ${change.title}`,
    description,
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    source: { title: 'Cambiar', url },
    // 'tentative' for submitted, 'confirmed' otherwise. Google's only
    // other option is 'cancelled' which we use via deleteEvent rather
    // than as a status field.
    status: change.status === 'submitted' ? 'tentative' : 'confirmed',
  };
}

export async function insertEvent(change) {
  const c = gcalConfig();
  const client = getCalendarClient();
  const res = await client.events.insert({
    calendarId: c.calendarId,
    requestBody: buildEventResource(change),
  });
  return res.data?.id ?? null;
}

export async function updateEvent(eventId, change) {
  const c = gcalConfig();
  const client = getCalendarClient();
  await client.events.update({
    calendarId: c.calendarId,
    eventId,
    requestBody: buildEventResource(change),
  });
}

export async function deleteEvent(eventId) {
  const c = gcalConfig();
  const client = getCalendarClient();
  try {
    await client.events.delete({ calendarId: c.calendarId, eventId });
  } catch (err) {
    // 404/410 = the event was already gone (manually deleted in Google
    // Calendar). Treat as success so the caller can clear the local id.
    const code = err?.code ?? err?.response?.status;
    if (code === 404 || code === 410) {
      logger.info({ eventId }, 'gcal event already gone — treating as deleted');
      return;
    }
    throw err;
  }
}

function changeUrl(id) {
  const base = (config.baseUrl || '').replace(/\/$/, '');
  return base ? `${base}/changes/${id}` : `/changes/${id}`;
}
