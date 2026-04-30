import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Markdown from './Markdown.jsx';

export default function Notes({ changeId }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['notes', changeId],
    queryFn: () => api.get(`/api/changes/${changeId}/notes`),
  });

  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [err, setErr] = useState(null);

  const create = useMutation({
    mutationFn: (b) => api.post(`/api/changes/${changeId}/notes`, { body: b }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['notes', changeId] }); },
    onError: (e) => setErr(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, body }) => api.patch(`/api/changes/${changeId}/notes/${id}`, { body }),
    onSuccess: () => { setEditingId(null); qc.invalidateQueries({ queryKey: ['notes', changeId] }); },
    onError: (e) => setErr(e.message),
  });
  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/changes/${changeId}/notes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notes', changeId] }),
    onError: (e) => setErr(e.message),
  });

  const canEdit = (note) => note.author?.id === user.id || user.role === 'admin';

  return (
    <div className="panel">
      <h2>Notes</h2>
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Markdown supported: <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, <code>[links](url)</code>, <code>![](url)</code> images. Reference uploaded attachments by their URL.
      </div>
      {err && <div className="error">{err}</div>}

      {isLoading && <div className="muted">Loading…</div>}
      {data && data.notes.length === 0 && <div className="muted" style={{ fontStyle: 'italic', marginBottom: 12 }}>No notes yet.</div>}
      {data && data.notes.map(n => (
        <div key={n.id} className="note-item">
          <div className="note-meta">
            <span className="who">{n.author?.displayName || n.author?.username || 'unknown'}</span>
            <span className="muted"> · {n.createdAt}{n.updatedAt !== n.createdAt && ' · edited'}</span>
            {canEdit(n) && editingId !== n.id && (
              <span className="row" style={{ display: 'inline-flex', gap: 6, marginLeft: 12 }}>
                <button className="secondary" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => { setEditingId(n.id); setEditBody(n.body); }}>Edit</button>
                <button className="danger" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => { if (confirm('Delete this note?')) remove.mutate(n.id); }}>Delete</button>
              </span>
            )}
          </div>
          {editingId === n.id ? (
            <div>
              <textarea aria-label="Edit note" value={editBody} onChange={e => setEditBody(e.target.value)} rows={4} />
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <button onClick={() => update.mutate({ id: n.id, body: editBody })} disabled={update.isPending}>Save</button>
                <button className="secondary" onClick={() => setEditingId(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="note-body"><Markdown source={n.body} /></div>
          )}
        </div>
      ))}

      <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) create.mutate(body); }}>
        <label>Add a note</label>
        <textarea aria-label="New note" value={body} onChange={e => setBody(e.target.value)} placeholder="What happened? Add markdown, link to an attachment, paste an image URL…" rows={3} />
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={create.isPending || !body.trim()}>
            {create.isPending ? 'Posting…' : 'Post note'}
          </button>
        </div>
      </form>
    </div>
  );
}
