import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { STATUS_LABELS } from '../statuses.js';

export default function Digests() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['digests'], queryFn: () => api.get('/api/digests'),
  });
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/digests/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digests'] }),
    onError: (e) => setErr(e.message),
  });
  const runNow = useMutation({
    mutationFn: (id) => api.post(`/api/digests/${id}/run-now`, {}),
    onSuccess: (r) => {
      setErr(null);
      if (r.ok) setInfo(`Sent to ${r.recipients.length} recipient${r.recipients.length === 1 ? '' : 's'} (${r.changes} change${r.changes === 1 ? '' : 's'} in window).`);
      else setInfo(`No email sent: ${r.error}`);
      qc.invalidateQueries({ queryKey: ['digests'] });
    },
    onError: (e) => { setInfo(null); setErr(e.message); },
  });

  return (
    <>
      <div className="row between">
        <h1>Digest schedules</h1>
        <button onClick={() => { setEditing('new'); setErr(null); setInfo(null); }}>+ New digest</button>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Send a recurring email digest of upcoming changes on a cron schedule. Useful for "every weekday at 6 PM, mail the next 7 days of approved changes to ops".
      </div>

      {err && <div className="error">{err}</div>}
      {info && <div className="banner" style={{ background: 'rgba(91,157,255,0.1)', borderColor: 'var(--accent)', color: 'var(--accent)' }}>{info}</div>}

      {editing && (
        <DigestForm
          scheduleId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['digests'] }); }}
          onError={setErr}
        />
      )}

      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Name</th><th>Cron</th><th>Time zone</th><th>Window</th><th>Statuses</th><th>Last run</th><th>Last error</th><th>Active</th><th></th></tr>
            </thead>
            <tbody>
              {data.schedules.length === 0 && <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No digest schedules. Click "+ New digest" to create one.</td></tr>}
              {data.schedules.map(s => (
                <tr key={s.id} style={{ opacity: s.enabled ? 1 : 0.6 }}>
                  <td>{s.name}</td>
                  <td><code>{s.cronExpression}</code></td>
                  <td className="muted">{s.timezone}</td>
                  <td>{s.lookaheadDays}d</td>
                  <td>{s.statusFilter.length === 0 ? <span className="muted">all</span> : s.statusFilter.join(', ')}</td>
                  <td className="muted">{s.lastSentAt ?? s.lastRunAt ?? '—'}</td>
                  <td className="muted" style={{ color: s.lastError ? 'var(--danger)' : undefined }}>{s.lastError ?? '—'}</td>
                  <td>{s.enabled ? 'yes' : 'no'}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button className="secondary" onClick={() => runNow.mutate(s.id)} disabled={runNow.isPending}>Send now</button>
                    <button className="secondary" onClick={() => { setEditing(s.id); setErr(null); setInfo(null); }}>Edit</button>
                    <button className="danger" onClick={() => { if (confirm(`Delete digest "${s.name}"?`)) remove.mutate(s.id); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DigestForm({ scheduleId, onClose, onSaved, onError }) {
  const isNew = scheduleId == null;
  const { data: existing } = useQuery({
    queryKey: ['digest', scheduleId],
    queryFn: () => api.get(`/api/digests/${scheduleId}`),
    enabled: !isNew,
  });
  const { data: usersData } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const users = usersData?.users ?? [];

  const [f, setF] = useState({
    name: '', cronExpression: '0 18 * * *', timezone: 'UTC', lookaheadDays: 7,
    statusFilter: [], recipientUserIds: [], recipientEmails: '', enabled: true,
  });
  const [hydrated, setHydrated] = useState(isNew);

  if (!hydrated && existing?.schedule) {
    const s = existing.schedule;
    setF({
      name: s.name,
      cronExpression: s.cronExpression,
      timezone: s.timezone,
      lookaheadDays: s.lookaheadDays,
      statusFilter: s.statusFilter,
      recipientUserIds: s.recipientUserIds,
      recipientEmails: s.recipientEmails.join(', '),
      enabled: s.enabled,
    });
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: (body) => isNew ? api.post('/api/digests', body) : api.patch(`/api/digests/${scheduleId}`, body),
    onSuccess: onSaved,
    onError: (e) => onError(e.message),
  });

  const submit = (e) => {
    e.preventDefault();
    const recipientEmails = f.recipientEmails
      .split(/[,;\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
    save.mutate({
      name: f.name,
      cronExpression: f.cronExpression,
      timezone: f.timezone,
      lookaheadDays: Number(f.lookaheadDays),
      statusFilter: f.statusFilter,
      recipientUserIds: f.recipientUserIds,
      recipientEmails,
      enabled: f.enabled,
    });
  };

  const toggleStatus = (s) => setF(prev => ({
    ...prev,
    statusFilter: prev.statusFilter.includes(s)
      ? prev.statusFilter.filter(x => x !== s)
      : [...prev.statusFilter, s],
  }));

  const toggleUser = (id) => setF(prev => ({
    ...prev,
    recipientUserIds: prev.recipientUserIds.includes(id)
      ? prev.recipientUserIds.filter(x => x !== id)
      : [...prev.recipientUserIds, id],
  }));

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{isNew ? 'New digest schedule' : `Edit ${existing?.schedule?.name ?? '…'}`}</h2>

      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Name</label>
          <input aria-label="Name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required />
        </div>
        <div style={{ flex: 1 }}>
          <label>Cron expression</label>
          <input aria-label="Cron expression" value={f.cronExpression} onChange={e => setF({ ...f, cronExpression: e.target.value })} required placeholder="0 18 * * *" />
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Five fields: minute hour day-of-month month day-of-week. Examples:&nbsp;
            <code>0 18 * * *</code> = daily at 18:00,&nbsp;
            <code>0 9 * * 1-5</code> = weekdays at 09:00.
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Time zone</label>
          <input aria-label="Time zone" value={f.timezone} onChange={e => setF({ ...f, timezone: e.target.value })} placeholder="America/Los_Angeles" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Lookahead window (days)</label>
          <input aria-label="Lookahead days" type="number" min={1} max={365} value={f.lookaheadDays} onChange={e => setF({ ...f, lookaheadDays: e.target.value })} required />
        </div>
      </div>

      <label>Statuses to include</label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Leave all unchecked to include every status.</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.entries(STATUS_LABELS).map(([k, label]) => (
          <label key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={f.statusFilter.includes(k)} onChange={() => toggleStatus(k)} style={{ width: 'auto' }} />
            <span className={`badge ${k}`} style={{ fontSize: 11 }}>{label}</span>
          </label>
        ))}
      </div>

      <label>Recipient users</label>
      <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, maxHeight: 180, overflow: 'auto' }}>
        {users.length === 0 && <span className="muted">No users.</span>}
        {users.map(u => (
          <label key={u.id} style={{ display: 'flex', gap: 8, margin: 0, padding: '4px 0', alignItems: 'center' }}>
            <input type="checkbox" checked={f.recipientUserIds.includes(u.id)} onChange={() => toggleUser(u.id)} style={{ width: 'auto' }} />
            <span>{u.displayName || u.username} <span className="muted">({u.username}{u.email ? `, ${u.email}` : ', no email'})</span></span>
          </label>
        ))}
      </div>

      <label>Additional recipient emails</label>
      <input aria-label="Recipient emails" value={f.recipientEmails} onChange={e => setF({ ...f, recipientEmails: e.target.value })} placeholder="ops@example.com, on-call@example.com" />
      <div className="muted" style={{ fontSize: 12 }}>Comma-, semicolon-, or whitespace-separated.</div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} style={{ width: 'auto' }} /> Enabled
      </label>

      <div className="row" style={{ marginTop: 16 }}>
        <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
