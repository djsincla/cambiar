import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';

export default function Groups() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['groups'], queryFn: () => api.get('/api/groups') });
  const [editing, setEditing] = useState(null); // group id or 'new'
  const [err, setErr] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/groups/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
    onError: (e) => setErr(e.message),
  });

  return (
    <>
      <div className="row between">
        <h1>Groups</h1>
        <button onClick={() => { setEditing('new'); setErr(null); }}>+ New group</button>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>Groups define who can approve changes. Assign one or more groups to a change type and any member of an assigned group can approve.</div>

      {err && <div className="error">{err}</div>}

      {editing && (
        <GroupForm
          groupId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['groups'] }); }}
          onError={setErr}
        />
      )}

      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Name</th><th>Description</th><th>Members</th><th></th></tr>
            </thead>
            <tbody>
              {data.groups.length === 0 && <tr><td colSpan={4} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No groups yet.</td></tr>}
              {data.groups.map(g => (
                <tr key={g.id}>
                  <td>
                    {g.name}
                    {g.adManaged && <span className="badge ad-managed" title="Reconciled from Active Directory on every AD login. Edit the AD group, not Cambiar." style={{ marginLeft: 8 }}>AD-managed</span>}
                  </td>
                  <td>{g.description || <span className="muted">—</span>}</td>
                  <td>{g.memberCount}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    {g.adManaged ? (
                      <button className="secondary" onClick={() => { setEditing(g.id); setErr(null); }}>View</button>
                    ) : (
                      <>
                        <button className="secondary" onClick={() => { setEditing(g.id); setErr(null); }}>Edit</button>
                        <button className="danger" onClick={() => { if (confirm(`Delete group "${g.name}"?`)) remove.mutate(g.id); }}>Delete</button>
                      </>
                    )}
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

function GroupForm({ groupId, onClose, onSaved, onError }) {
  const isNew = groupId == null;
  const { data: group } = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => api.get(`/api/groups/${groupId}`),
    enabled: !isNew,
  });
  const { data: usersData } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const users = usersData?.users ?? [];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState([]);
  const [hydrated, setHydrated] = useState(isNew);

  if (!hydrated && group?.group) {
    setName(group.group.name);
    setDescription(group.group.description ?? '');
    setMemberIds(group.group.members.map(m => m.id));
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: (body) => isNew ? api.post('/api/groups', body) : api.patch(`/api/groups/${groupId}`, body),
    onSuccess: onSaved,
    onError: (e) => onError(e.message),
  });

  const toggle = (id) => setMemberIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const adManaged = Boolean(group?.group?.adManaged);

  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); if (adManaged) return; save.mutate({ name, description: description || null, memberIds }); }}>
      <h2>
        {isNew ? 'New group' : `${adManaged ? 'View' : 'Edit'} ${group?.group?.name ?? '…'}`}
        {adManaged && <span className="badge ad-managed" style={{ marginLeft: 8, fontSize: '0.75em' }}>AD-managed</span>}
      </h2>
      {adManaged && (
        <div className="muted" style={{ marginBottom: 12 }}>
          This group is reconciled from Active Directory on every AD login. To change its name, description, or members, edit the corresponding AD group — Cambiar will pick up the change on the next AD login.
        </div>
      )}
      <label>Name</label>
      <input aria-label="Name" value={name} onChange={e => setName(e.target.value)} required disabled={adManaged} />
      <label>Description</label>
      <input aria-label="Description" value={description} onChange={e => setDescription(e.target.value)} disabled={adManaged} />
      <label>Members</label>
      <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, maxHeight: 220, overflow: 'auto', opacity: adManaged ? 0.7 : 1 }}>
        {users.length === 0 && <span className="muted">No users yet.</span>}
        {users.map(u => (
          <label key={u.id} style={{ display: 'flex', gap: 8, margin: 0, padding: '4px 0', alignItems: 'center', color: 'var(--text)' }}>
            <input type="checkbox" checked={memberIds.includes(u.id)} onChange={() => toggle(u.id)} disabled={adManaged} style={{ width: 'auto' }} />
            <span>{u.displayName || u.username} <span className="muted">({u.username}, {u.role})</span></span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        {!adManaged && <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>}
        <button type="button" className="secondary" onClick={onClose}>{adManaged ? 'Close' : 'Cancel'}</button>
      </div>
    </form>
  );
}
