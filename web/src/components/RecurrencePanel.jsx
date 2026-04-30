import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { statusLabel } from '../statuses.js';

const COMMON_CRONS = [
  { label: 'Daily at 02:00', value: '0 2 * * *' },
  { label: 'Weekdays at 09:00', value: '0 9 * * 1-5' },
  { label: 'Mondays at 08:00', value: '0 8 * * 1' },
  { label: 'First of every month at 03:00', value: '0 3 1 * *' },
];

export default function RecurrencePanel({ change, recurring, onChanged, setErr }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = change.submitter.id === user.id || user.role === 'admin';

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    cronExpression: recurring?.cronExpression ?? '0 2 * * *',
    timezone: recurring?.timezone ?? 'UTC',
    leadMinutes: recurring?.leadMinutes ?? 0,
    autoSubmit: recurring?.autoSubmit ?? true,
    enabled: recurring?.enabled ?? true,
  });

  const save = useMutation({
    mutationFn: (body) => api.post(`/api/changes/${change.id}/recurrence`, body),
    onSuccess: () => { setEditing(false); onChanged(); },
    onError: (e) => setErr(e.message),
  });
  const clear = useMutation({
    mutationFn: () => api.delete(`/api/changes/${change.id}/recurrence`),
    onSuccess: () => onChanged(),
    onError: (e) => setErr(e.message),
  });
  const spawn = useMutation({
    mutationFn: () => api.post(`/api/changes/${change.id}/spawn-now`, {}),
    onSuccess: (r) => { setErr(null); onChanged(); /* surface child link via parent re-fetch */ },
    onError: (e) => setErr(e.message),
  });

  // No recurring config yet — show a "Make recurring" affordance.
  if (!recurring && !editing) {
    if (!canManage) return null;
    return (
      <div className="panel">
        <h2>Recurring</h2>
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Make this a recurring parent so it automatically spawns child changes on a cron schedule. The parent itself doesn't run the lifecycle — children do.
        </div>
        <button onClick={() => setEditing(true)}>Make recurring…</button>
      </div>
    );
  }

  // Editing form (initial setup or update).
  if (editing) {
    return (
      <div className="panel">
        <h2>{recurring ? 'Edit recurrence' : 'Make recurring'}</h2>

        <label>Cron expression</label>
        <input
          aria-label="Cron expression"
          value={form.cronExpression}
          onChange={e => setForm({ ...form, cronExpression: e.target.value })}
          required
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 8 }}>
          Five fields: minute hour day-of-month month day-of-week. Quick picks:&nbsp;
          {COMMON_CRONS.map((c, i) => (
            <span key={c.value}>
              <button
                type="button"
                className="secondary"
                style={{ padding: '1px 6px', fontSize: 11, marginRight: 4 }}
                onClick={() => setForm({ ...form, cronExpression: c.value })}
              >{c.label}</button>
            </span>
          ))}
        </div>

        <div className="row" style={{ gap: 16 }}>
          <div style={{ flex: 1 }}>
            <label>Time zone</label>
            <input aria-label="Time zone" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} placeholder="UTC, America/Los_Angeles, …" />
          </div>
          <div style={{ flex: 1 }}>
            <label>Lead time (minutes)</label>
            <input
              aria-label="Lead minutes"
              type="number" min={0} max={525600}
              value={form.leadMinutes}
              onChange={e => setForm({ ...form, leadMinutes: e.target.value })}
            />
            <div className="muted" style={{ fontSize: 12 }}>How far in the future the child's <em>scheduled at</em> is set, relative to fire time. 0 = "right now".</div>
          </div>
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input type="checkbox" checked={form.autoSubmit} onChange={e => setForm({ ...form, autoSubmit: e.target.checked })} style={{ width: 'auto' }} />
          Auto-submit children (and auto-approve if the change type is set to auto-approve)
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} style={{ width: 'auto' }} />
          Enabled
        </label>

        <div className="row" style={{ marginTop: 16, gap: 8 }}>
          <button onClick={() => save.mutate({
            cronExpression: form.cronExpression,
            timezone: form.timezone,
            leadMinutes: Number(form.leadMinutes),
            autoSubmit: form.autoSubmit,
            enabled: form.enabled,
          })} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button className="secondary" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  // Read-only view of an existing recurrence.
  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Recurring</h2>
        {canManage && (
          <div className="row" style={{ gap: 6 }}>
            <button onClick={() => spawn.mutate()} disabled={spawn.isPending}>Spawn now</button>
            <button className="secondary" onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" onClick={() => { if (confirm('Stop this from spawning further children? Existing children remain untouched.')) clear.mutate(); }}>Stop recurring</button>
          </div>
        )}
      </div>
      <table style={{ marginTop: 8 }}>
        <tbody>
          <tr><td className="muted" style={{ width: 200 }}>Cron</td><td><code>{recurring.cronExpression}</code></td></tr>
          <tr><td className="muted">Time zone</td><td>{recurring.timezone}</td></tr>
          <tr><td className="muted">Lead time</td><td>{recurring.leadMinutes} min</td></tr>
          <tr><td className="muted">Auto-submit children</td><td>{recurring.autoSubmit ? 'yes' : 'no'}</td></tr>
          <tr><td className="muted">Enabled</td><td>{recurring.enabled ? 'yes' : <span style={{ color: 'var(--danger)' }}>no</span>}</td></tr>
          <tr><td className="muted">Last fired</td><td>{recurring.lastFiredAt ?? <span className="muted">— not yet —</span>}</td></tr>
        </tbody>
      </table>

      {recurring.recentChildren?.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 }}>Recent children</h3>
          <table>
            <thead><tr><th>#</th><th>Title</th><th>Status</th><th>Scheduled</th></tr></thead>
            <tbody>
              {recurring.recentChildren.map(c => (
                <tr key={c.id}>
                  <td><Link to={`/changes/${c.id}`}>{c.id}</Link></td>
                  <td><Link to={`/changes/${c.id}`}>{c.title}</Link></td>
                  <td><span className={`badge ${c.status}`}>{statusLabel(c.status)}</span></td>
                  <td className="muted">{(c.scheduledAt ?? '').replace('T', ' ').slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
