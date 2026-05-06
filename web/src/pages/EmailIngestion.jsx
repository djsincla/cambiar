import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';

const ACTION_TYPES = [
  { key: 'create_change', label: 'Create change' },
  { key: 'transition',    label: 'Transition (submit/approve/start/implement/close/rollback)' },
  { key: 'add_note',      label: 'Add note to existing change' },
];

const DEFAULT_CONFIGS = {
  create_change: {
    typeKey: 'generic',
    useSubjectAs: 'title',
    useBodyAs: 'description',
    autoSubmit: true,
  },
  transition: {
    verb: 'close',
    changeIdFromSubjectRegex: '\\[cambiar\\.world #(\\d+)\\]',
    comment: 'via email',
  },
  add_note: {
    changeIdFromSubjectRegex: '\\[cambiar\\.world #(\\d+)\\]',
    useBodyAs: 'body',
  },
};

export default function EmailIngestion() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['email-rules'], queryFn: () => api.get('/api/email-rules') });
  const { data: logData, refetch: refetchLog } = useQuery({
    queryKey: ['email-log'],
    queryFn: () => api.get('/api/email-log?limit=50'),
    refetchInterval: 30_000,
  });

  const [editing, setEditing] = useState(null); // 'new' | id
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/email-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['email-rules'] }),
    onError: (e) => setErr(e.message),
  });
  const pollNow = useMutation({
    mutationFn: () => api.post('/api/email-rules/poll-now', {}),
    onSuccess: (r) => {
      setErr(null);
      if (r.skipped) setInfo(`Skipped: ${r.reason}`);
      else if (r.ok) setInfo(`Polled. Processed ${r.processed}, errors ${r.errors}.`);
      else setInfo(`Poll failed: ${r.error}`);
      refetchLog();
    },
    onError: (e) => { setInfo(null); setErr(e.message); },
  });

  return (
    <>
      <div className="row between">
        <h1>Email ingestion</h1>
        <div className="row" style={{ gap: 8 }}>
          <button className="secondary" onClick={() => pollNow.mutate()} disabled={pollNow.isPending}>Poll now</button>
          <button onClick={() => { setEditing('new'); setErr(null); setInfo(null); }}>+ New rule</button>
        </div>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Incoming email is matched against rules (highest-priority first; lower number = higher priority). The matched rule's action runs as the synthetic <code>email-system</code> user; the audit log on every affected change records the source. Rules and the IMAP credentials live in <code>config/notifications.json</code> and the <code>IMAP_PASSWORD</code> env var.
      </div>

      {err && <div className="error">{err}</div>}
      {info && <div className="banner" style={{ background: 'rgba(91,157,255,0.1)', borderColor: 'var(--accent)', color: 'var(--accent)' }}>{info}</div>}

      {editing && (
        <RuleForm
          ruleId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['email-rules'] }); }}
          onError={setErr}
        />
      )}

      <h2>Rules</h2>
      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Pri</th><th>Name</th><th>From</th><th>Subject</th><th>Action</th><th>Active</th><th></th></tr>
            </thead>
            <tbody>
              {data.rules.length === 0 && <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No rules yet.</td></tr>}
              {data.rules.map(r => (
                <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                  <td>{r.priority}</td>
                  <td><strong>{r.name}</strong></td>
                  <td><code>{r.fromPattern || <span className="muted">any</span>}</code></td>
                  <td><code>{r.subjectPattern || <span className="muted">any</span>}</code></td>
                  <td>{r.actionType}</td>
                  <td>{r.enabled ? 'yes' : 'no'}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button className="secondary" onClick={() => { setEditing(r.id); setErr(null); }}>Edit</button>
                    <button className="danger" onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) remove.mutate(r.id); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Recent email log</h2>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>Most recent 50 incoming messages. Polls every 30 s.</div>
      {logData && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Processed</th><th>From</th><th>Subject</th><th>Rule</th><th>Result</th><th>Change</th></tr>
            </thead>
            <tbody>
              {logData.entries.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No emails processed yet.</td></tr>}
              {logData.entries.map(e => (
                <tr key={e.id} style={{ background: e.error ? 'rgba(255,107,107,0.06)' : undefined }}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{e.processedAt}</td>
                  <td className="muted">{e.fromAddr}</td>
                  <td>{e.subject}</td>
                  <td>{e.matchedRule?.name ?? <span className="muted">—</span>}</td>
                  <td>{e.error
                      ? <span style={{ color: 'var(--danger)' }}>{e.error}</span>
                      : (e.actionSummary || <span className="muted">no rule matched</span>)}</td>
                  <td>{e.changeId ? <a href={`/changes/${e.changeId}`}>#{e.changeId}</a> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RuleForm({ ruleId, onClose, onSaved, onError }) {
  const isNew = ruleId == null;
  const { data } = useQuery({
    queryKey: ['email-rule', ruleId],
    queryFn: () => api.get(`/api/email-rules/${ruleId}`),
    enabled: !isNew,
  });
  const [hydrated, setHydrated] = useState(isNew);
  const [f, setF] = useState({
    name: '', enabled: true, priority: 100,
    fromPattern: '', subjectPattern: '',
    actionType: 'create_change',
    actionConfigText: JSON.stringify(DEFAULT_CONFIGS.create_change, null, 2),
  });

  if (!hydrated && data?.rule) {
    const r = data.rule;
    setF({
      name: r.name,
      enabled: r.enabled,
      priority: r.priority,
      fromPattern: r.fromPattern ?? '',
      subjectPattern: r.subjectPattern ?? '',
      actionType: r.actionType,
      actionConfigText: JSON.stringify(r.actionConfig ?? {}, null, 2),
    });
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: (body) => isNew ? api.post('/api/email-rules', body) : api.patch(`/api/email-rules/${ruleId}`, body),
    onSuccess: onSaved,
    onError: (e) => onError(e.message),
  });

  const submit = (e) => {
    e.preventDefault();
    let actionConfig = {};
    try { actionConfig = JSON.parse(f.actionConfigText || '{}'); }
    catch (err) { onError(`actionConfig is not valid JSON: ${err.message}`); return; }
    save.mutate({
      name: f.name,
      enabled: f.enabled,
      priority: Number(f.priority),
      fromPattern: f.fromPattern || null,
      subjectPattern: f.subjectPattern || null,
      actionType: f.actionType,
      actionConfig,
    });
  };

  const setActionType = (t) => {
    setF(s => ({ ...s, actionType: t, actionConfigText: JSON.stringify(DEFAULT_CONFIGS[t] ?? {}, null, 2) }));
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{isNew ? 'New email rule' : 'Edit rule'}</h2>

      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 2 }}>
          <label>Name</label>
          <input aria-label="Name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required />
        </div>
        <div style={{ flex: 1 }}>
          <label>Priority (lower = higher)</label>
          <input aria-label="Priority" type="number" min={0} max={1000} value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })} required />
        </div>
        <div style={{ paddingTop: 28 }}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} style={{ width: 'auto' }} /> Enabled
          </label>
        </div>
      </div>

      <label>From pattern (regex, case-insensitive — leave blank for any)</label>
      <input aria-label="From pattern" value={f.fromPattern} onChange={e => setF({ ...f, fromPattern: e.target.value })} placeholder="^monitoring@example\\.com$" />

      <label>Subject pattern (regex — leave blank for any)</label>
      <input aria-label="Subject pattern" value={f.subjectPattern} onChange={e => setF({ ...f, subjectPattern: e.target.value })} placeholder="\\bOUTAGE\\b" />

      <label>Action type</label>
      <select aria-label="Action type" value={f.actionType} onChange={e => setActionType(e.target.value)}>
        {ACTION_TYPES.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
      </select>

      <label>Action config (JSON)</label>
      <textarea aria-label="Action config"
        value={f.actionConfigText}
        onChange={e => setF({ ...f, actionConfigText: e.target.value })}
        rows={10}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Field reference:&nbsp;
        <strong>create_change</strong>: <code>typeKey</code>, <code>templateId</code>, <code>useSubjectAs</code>: "title", <code>useBodyAs</code>: "description", <code>autoSubmit</code>.&nbsp;
        <strong>transition</strong>: <code>verb</code>, <code>changeIdFromSubjectRegex</code>, <code>comment</code>.&nbsp;
        <strong>add_note</strong>: <code>changeIdFromSubjectRegex</code>, <code>useBodyAs</code>: "body".
      </div>

      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
