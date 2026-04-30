import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';

export default function Users() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const { data: groupsData } = useQuery({ queryKey: ['groups'], queryFn: () => api.get('/api/groups') });
  const groups = groupsData?.groups ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [err, setErr] = useState(null);

  const create = useMutation({
    mutationFn: (body) => api.post('/api/users', body),
    onSuccess: () => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setErr(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/api/users/${id}`, body),
    onSuccess: () => { setEditingUser(null); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setErr(e.message),
  });

  return (
    <>
      <div className="row between">
        <h1>Users</h1>
        <button onClick={() => { setShowCreate(s => !s); setEditingUser(null); setErr(null); }}>
          {showCreate ? 'Cancel' : '+ New user'}
        </button>
      </div>

      {err && <div className="error">{err}</div>}
      {showCreate && (
        <CreateUserForm
          groups={groups}
          onSubmit={(b) => { setErr(null); create.mutate(b); }}
          pending={create.isPending}
        />
      )}
      {editingUser && (
        <EditUserForm
          user={editingUser}
          groups={groups}
          onSubmit={(b) => { setErr(null); update.mutate({ id: editingUser.id, ...b }); }}
          onCancel={() => setEditingUser(null)}
          pending={update.isPending}
        />
      )}

      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Username</th><th>Display name</th><th>Email</th><th>Source</th><th>Role</th><th>Groups</th><th>Active</th><th></th></tr>
            </thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.displayName || <span className="muted">—</span>}</td>
                  <td>{u.email || <span className="muted">—</span>}</td>
                  <td className="muted">{u.source}</td>
                  <td>
                    <select value={u.role} onChange={e => update.mutate({ id: u.id, role: e.target.value })}>
                      <option value="submitter">submitter</option>
                      <option value="approver">approver</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{u.groups?.length ? u.groups.map(g => g.name).join(', ') : <span className="muted">—</span>}</td>
                  <td>
                    <input type="checkbox" checked={u.active} onChange={e => update.mutate({ id: u.id, active: e.target.checked })} style={{ width: 'auto' }} />
                  </td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="secondary" onClick={() => { setEditingUser(u); setShowCreate(false); setErr(null); }}>Edit</button>
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

function GroupChecklist({ groups, selectedIds, onChange }) {
  return (
    <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, maxHeight: 180, overflow: 'auto' }}>
      {groups.length === 0 && <span className="muted">No groups yet. Create some on the Groups page.</span>}
      {groups.map(g => (
        <label key={g.id} style={{ display: 'flex', gap: 8, margin: 0, padding: '4px 0', alignItems: 'center' }}>
          <input type="checkbox" checked={selectedIds.includes(g.id)}
            onChange={() => onChange(selectedIds.includes(g.id) ? selectedIds.filter(x => x !== g.id) : [...selectedIds, g.id])}
            style={{ width: 'auto' }} />
          <span>{g.name}</span>
        </label>
      ))}
    </div>
  );
}

function CreateUserForm({ groups, onSubmit, pending }) {
  const [f, setF] = useState({ username: '', password: '', email: '', displayName: '', role: 'submitter', phone: '', groupIds: [] });
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...f, email: f.email || null, displayName: f.displayName || null, phone: f.phone || null }); }}>
      <h2>Create local user</h2>
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Username</label>
          <input aria-label="Username" value={f.username} onChange={e => setF({ ...f, username: e.target.value })} required />
        </div>
        <div style={{ flex: 1 }}>
          <label>Display name</label>
          <input aria-label="Display name" value={f.displayName} onChange={e => setF({ ...f, displayName: e.target.value })} />
        </div>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Email</label>
          <input aria-label="Email" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Phone (for SMS)</label>
          <input aria-label="Phone" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} />
        </div>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Initial password</label>
          <input aria-label="Initial password" type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required />
        </div>
        <div style={{ flex: 1 }}>
          <label>Role</label>
          <select aria-label="Role" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
            <option value="submitter">submitter</option>
            <option value="approver">approver</option>
            <option value="admin">admin</option>
          </select>
        </div>
      </div>
      <label>Groups</label>
      <GroupChecklist groups={groups} selectedIds={f.groupIds} onChange={(ids) => setF({ ...f, groupIds: ids })} />
      <div style={{ marginTop: 16 }}>
        <button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create user'}</button>
      </div>
      <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>The user must change their password on first login.</div>
    </form>
  );
}

function EditUserForm({ user, groups, onSubmit, onCancel, pending }) {
  const [f, setF] = useState({
    email: user.email ?? '',
    displayName: user.displayName ?? '',
    phone: user.phone ?? '',
    role: user.role,
    groupIds: (user.groups ?? []).map(g => g.id),
  });
  return (
    <form className="panel" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({
        email: f.email || null,
        displayName: f.displayName || null,
        phone: f.phone || null,
        role: f.role,
        groupIds: f.groupIds,
      });
    }}>
      <h2>Edit {user.username}</h2>
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Display name</label>
          <input value={f.displayName} onChange={e => setF({ ...f, displayName: e.target.value })} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Email</label>
          <input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} />
        </div>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: 1 }}>
          <label>Phone</label>
          <input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Role</label>
          <select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
            <option value="submitter">submitter</option>
            <option value="approver">approver</option>
            <option value="admin">admin</option>
          </select>
        </div>
      </div>
      <label>Groups</label>
      <GroupChecklist groups={groups} selectedIds={f.groupIds} onChange={(ids) => setF({ ...f, groupIds: ids })} />
      <div className="row" style={{ marginTop: 16 }}>
        <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
