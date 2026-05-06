import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';

function YesNo({ on }) {
  return <span className={`badge ${on ? 'approved' : 'draft'}`}>{on ? 'yes' : 'no'}</span>;
}

export default function GoogleCalendar() {
  const qc = useQueryClient();
  const [err, setErr] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ['gcal-status'],
    queryFn: () => api.get('/api/admin/gcal/status'),
    refetchInterval: 30_000,
  });
  const sync = useMutation({
    mutationFn: () => api.post('/api/admin/gcal/sync-now', {}),
    onSuccess: (r) => { setLastResult(r); setErr(null); qc.invalidateQueries({ queryKey: ['gcal-status'] }); },
    onError: (e) => setErr(e.message),
  });

  return (
    <>
      <div className="row between">
        <h1>Google Calendar</h1>
        <button onClick={() => sync.mutate()} disabled={!data?.enabled || sync.isPending}>
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Push-only sync. cambiar.world inserts, updates, and deletes events on the configured Google Calendar based on each change's status, schedule, and planned duration. Same scope as the iCal feed: scheduled non-recurring-parent changes in <em>submitted</em>, <em>approved</em>, <em>in_progress</em>, or <em>implemented</em>.
      </div>

      {err && <div className="error">{err}</div>}
      {isLoading && <div className="muted">Loading…</div>}

      {data && (
        <>
          <div className="panel">
            <h2>Status</h2>
            <table>
              <tbody>
                <tr><td className="muted" style={{ width: 240 }}>Active</td><td><YesNo on={data.enabled} /></td></tr>
                <tr><td className="muted">Config <code>googleCalendar.enabled</code></td><td><YesNo on={data.configEnabled} /></td></tr>
                <tr><td className="muted">Calendar ID</td><td>{data.calendarId ? <code>{data.calendarId}</code> : <span className="muted">— not set —</span>}</td></tr>
                <tr><td className="muted">Credentials file</td><td><code>{data.credentialsResolved ?? data.credentialsFile ?? '—'}</code></td></tr>
                <tr><td className="muted">Credentials present</td><td><YesNo on={data.credentialsExist} /></td></tr>
                <tr><td className="muted">Sync interval (minutes)</td><td>{data.syncIntervalMinutes}</td></tr>
              </tbody>
            </table>
            {!data.enabled && (
              <div className="banner" style={{ marginTop: 12 }}>
                Sync is inactive. Set <code>notifications.googleCalendar.enabled = true</code>, point <code>credentialsFile</code> at a service-account JSON key, fill in <code>calendarId</code>, share that calendar with the service account's email, then restart cambiar.world.
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Counts</h2>
            <table>
              <tbody>
                <tr><td className="muted" style={{ width: 240 }}>Eligible (will be published)</td><td>{data.counts.eligible}</td></tr>
                <tr><td className="muted">Currently published in Google</td><td>{data.counts.published}</td></tr>
                <tr><td className="muted">Never synced</td><td>{data.counts.neverSynced}</td></tr>
              </tbody>
            </table>
          </div>

          {lastResult && (
            <div className="panel">
              <h2>Last sync</h2>
              <table>
                <tbody>
                  <tr><td className="muted" style={{ width: 240 }}>Result</td><td><span className={`badge ${lastResult.ok ? 'approved' : 'rejected'}`}>{lastResult.ok ? 'ok' : 'error'}</span></td></tr>
                  {lastResult.reason && <tr><td className="muted">Reason</td><td>{lastResult.reason}</td></tr>}
                  <tr><td className="muted">Inserted</td><td>{lastResult.inserted ?? 0}</td></tr>
                  <tr><td className="muted">Updated</td><td>{lastResult.updated ?? 0}</td></tr>
                  <tr><td className="muted">Deleted</td><td>{lastResult.deleted ?? 0}</td></tr>
                  <tr><td className="muted">Skipped</td><td>{lastResult.skipped ?? 0}</td></tr>
                  <tr><td className="muted">Errors</td><td>{lastResult.errors ?? 0}</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
