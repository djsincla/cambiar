import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';

export default function ChangeTypesAdmin() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['change-types-admin'],
    queryFn: () => api.get('/api/change-types?includeInactive=true'),
  });
  const [editing, setEditing] = useState(null); // id or 'new'
  const [err, setErr] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/change-types/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['change-types-admin'] }),
    onError: (e) => setErr(e.message),
  });

  return (
    <>
      <div className="row between">
        <h1>Change types</h1>
        <button onClick={() => { setEditing('new'); setErr(null); }}>+ New type</button>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Define what kinds of changes can be tracked, what fields each one captures, and which groups must approve.
      </div>
      {err && <div className="error">{err}</div>}

      {editing && (
        <TypeForm
          typeId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['change-types-admin'] }); }}
          onError={setErr}
        />
      )}

      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Key</th><th>Name</th><th>Fields</th><th>Approval</th><th>Active</th><th></th></tr>
            </thead>
            <tbody>
              {data.types.map(t => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                  <td><code>{t.key}</code></td>
                  <td>{t.name}</td>
                  <td>{t.fields.length}</td>
                  <td>
                    {t.autoApprove
                      ? <span className="badge approved">auto-approve</span>
                      : t.approverGroups?.length
                        ? t.approverGroups.map(g => g.name).join(', ')
                        : <span className="muted">— legacy fallback —</span>}
                  </td>
                  <td>{t.active ? 'yes' : 'no'}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button className="secondary" onClick={() => { setEditing(t.id); setErr(null); }}>Edit</button>
                    <button className="danger" onClick={() => { if (confirm(`Delete change type "${t.name}"? If used by any change, it will be deactivated instead.`)) remove.mutate(t.id); }}>Delete</button>
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

const FIELD_TYPES = ['string', 'text', 'number', 'select', 'boolean'];

function TypeForm({ typeId, onClose, onSaved, onError }) {
  const isNew = typeId == null;
  const { data: typeData } = useQuery({
    queryKey: ['change-type', typeId],
    queryFn: () => api.get(`/api/change-types/${typeId}`),
    enabled: !isNew,
  });
  const { data: groupsData } = useQuery({ queryKey: ['groups'], queryFn: () => api.get('/api/groups') });
  const groups = groupsData?.groups ?? [];

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [active, setActive] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [approvalSlaMinutes, setApprovalSlaMinutes] = useState('');
  const [fields, setFields] = useState([]);
  const [approverGroupIds, setApproverGroupIds] = useState([]);
  const [hydrated, setHydrated] = useState(isNew);

  if (!hydrated && typeData?.type) {
    const t = typeData.type;
    setKey(t.key); setName(t.name); setDescription(t.description ?? '');
    setIcon(t.icon ?? ''); setActive(t.active); setAutoApprove(Boolean(t.autoApprove));
    setApprovalSlaMinutes(t.approvalSlaMinutes ?? '');
    setFields(t.fields ?? []);
    setApproverGroupIds((t.approverGroups ?? []).map(g => g.id));
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: (body) => isNew ? api.post('/api/change-types', body) : api.patch(`/api/change-types/${typeId}`, body),
    onSuccess: onSaved,
    onError: (e) => onError(e.message),
  });

  const submit = (e) => {
    e.preventDefault();
    const sla = approvalSlaMinutes === '' ? null : Number(approvalSlaMinutes);
    const body = isNew
      ? { key, name, description: description || null, icon: icon || null, fields, approverGroupIds: autoApprove ? [] : approverGroupIds, autoApprove, approvalSlaMinutes: sla }
      : { name, description: description || null, icon: icon || null, fields, approverGroupIds: autoApprove ? [] : approverGroupIds, autoApprove, active, approvalSlaMinutes: sla };
    if (isNew) body.key = key;
    save.mutate(body);
  };

  const updateField = (i, patch) => setFields(s => s.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  const removeField = (i) => setFields(s => s.filter((_, idx) => idx !== i));
  const addField = () => setFields(s => [...s, { key: '', label: '', type: 'string', required: false }]);
  const move = (i, dir) => setFields(s => {
    const next = [...s];
    const j = i + dir;
    if (j < 0 || j >= next.length) return s;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{isNew ? 'New change type' : `Edit ${typeData?.type?.name ?? '…'}`}</h2>

      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Key (lowercase, _ allowed)</label>
          <input value={key} onChange={e => setKey(e.target.value)} required pattern="^[a-z][a-z0-9_]*$" disabled={!isNew} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} required />
        </div>
      </div>

      <label>Description</label>
      <input value={description} onChange={e => setDescription(e.target.value)} />

      <label>Icon (optional)</label>
      <input value={icon} onChange={e => setIcon(e.target.value)} placeholder="server, shield, package, …" />

      {!isNew && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} style={{ width: 'auto' }} /> Active
        </label>
      )}

      <h2>Approval policy</h2>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '8px 0 12px' }}>
        <input type="checkbox" aria-label="Auto-approve" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} style={{ width: 'auto', marginTop: 4 }} />
        <span>
          <strong style={{ color: 'var(--text)' }}>Auto-approve (standard change)</strong>
          <div className="muted" style={{ fontSize: 13 }}>
            Skip the approval gate. Submissions go straight from <em>draft → approved</em> in one step. Use this for routine, low-risk, well-understood changes (planned reboots in a maintenance window, recurring patch jobs). Field validation still runs.
          </div>
        </span>
      </label>

      {!autoApprove && (
        <>
          <label>Approval SLA override (minutes)</label>
          <input
            aria-label="Approval SLA minutes"
            type="number" min={1} max={43200}
            value={approvalSlaMinutes}
            onChange={e => setApprovalSlaMinutes(e.target.value)}
            placeholder="Leave blank to use the global default"
            style={{ maxWidth: 240 }}
          />
          <div className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
            Optional. If set, alerts fire when a change of this type has been waiting in <em>submitted</em> for this many minutes. Use a smaller value (e.g. 60) for emergency-bypass types and a larger one (or leave blank) for routine types.
          </div>

          <label>Approver groups</label>
          <div className="muted" style={{ marginBottom: 8 }}>Any one member of any selected group can approve. Leave empty to fall back to the legacy "approver" role.</div>
          <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
            {groups.length === 0 && <span className="muted">No groups yet — create some on the Groups page first.</span>}
            {groups.map(g => (
              <label key={g.id} style={{ display: 'flex', gap: 8, margin: 0, padding: '4px 0', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={approverGroupIds.includes(g.id)}
                  onChange={() => setApproverGroupIds(s => s.includes(g.id) ? s.filter(x => x !== g.id) : [...s, g.id])}
                  style={{ width: 'auto' }}
                />
                <span>{g.name} <span className="muted">({g.memberCount} members)</span></span>
              </label>
            ))}
          </div>
        </>
      )}
      {autoApprove && (
        <div className="banner">Approver groups are not consulted while auto-approve is on. They have been hidden but will be saved as empty.</div>
      )}

      <h2>Fields</h2>
      <div className="muted" style={{ marginBottom: 8 }}>What information should be captured when someone creates a change of this type?</div>
      <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
        {fields.length === 0 && <div className="muted" style={{ padding: 8 }}>No fields. Click below to add one.</div>}
        {fields.map((f, i) => (
          <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input style={{ flex: 1, minWidth: 140 }} placeholder="key (e.g. host_name)" value={f.key} onChange={e => updateField(i, { key: e.target.value })} pattern="^[a-z][a-z0-9_]*$" required />
              <input style={{ flex: 2, minWidth: 200 }} placeholder="Label shown to users" value={f.label} onChange={e => updateField(i, { label: e.target.value })} required />
              <select value={f.type} onChange={e => updateField(i, { type: e.target.value, ...(e.target.value !== 'select' ? { options: undefined } : {}) })}>
                {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', margin: 0 }}>
                <input type="checkbox" checked={!!f.required} onChange={e => updateField(i, { required: e.target.checked })} style={{ width: 'auto' }} /> required
              </label>
              <div className="row" style={{ gap: 4 }}>
                <button type="button" className="secondary" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="secondary" onClick={() => move(i, 1)} disabled={i === fields.length - 1}>↓</button>
                <button type="button" className="danger" onClick={() => removeField(i)}>×</button>
              </div>
            </div>
            {f.type === 'select' && (
              <input style={{ marginTop: 6 }} placeholder="comma-separated options"
                value={(f.options ?? []).join(', ')}
                onChange={e => updateField(i, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                required />
            )}
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <button type="button" className="secondary" onClick={addField}>+ Add field</button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
