import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Markdown from './Markdown.jsx';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Notes({ changeId }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['notes', changeId],
    queryFn: () => api.get(`/api/changes/${changeId}/notes`),
  });
  const { data: attData } = useQuery({
    queryKey: ['attachments', changeId, 'all'],
    queryFn: () => api.get(`/api/changes/${changeId}/attachments`),
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
  const attachmentsFor = (noteId) =>
    (attData?.attachments ?? []).filter(a => a.noteId === noteId);

  const refreshAttachments = () => {
    qc.invalidateQueries({ queryKey: ['attachments', changeId, 'all'] });
    qc.invalidateQueries({ queryKey: ['attachments', changeId, 'change-wide'] });
  };

  return (
    <div className="panel">
      <h2>Notes</h2>
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Markdown supported: <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, <code>[links](url)</code>, <code>![](url)</code> images. Attach files directly to a note with the Attach button — those upload threads under the note instead of as a change-wide attachment.
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
                <button className="danger" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => { if (confirm('Delete this note? Any attached files will be removed too.')) remove.mutate(n.id); }}>Delete</button>
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

          <NoteAttachments
            changeId={changeId}
            note={n}
            attachments={attachmentsFor(n.id)}
            canManage={canEdit(n)}
            onChanged={refreshAttachments}
            setErr={setErr}
          />
        </div>
      ))}

      <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) create.mutate(body); }}>
        <label>Add a note</label>
        <textarea aria-label="New note" value={body} onChange={e => setBody(e.target.value)} placeholder="What happened? Add markdown, link to an attachment, paste an image URL…" rows={3} />
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={create.isPending || !body.trim()}>
            {create.isPending ? 'Posting…' : 'Post note'}
          </button>
          <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>Post the note first, then attach files to it from the note's row below.</span>
        </div>
      </form>
    </div>
  );
}

function NoteAttachments({ changeId, note, attachments, canManage, onChanged, setErr }) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('noteId', String(note.id));
      const res = await fetch(`/api/changes/${changeId}/attachments`, {
        method: 'POST', credentials: 'include', body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onChanged();
    } catch (e) { setErr(e.message); }
    finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (attId) => {
    if (!confirm('Remove this attachment?')) return;
    try {
      await api.delete(`/api/changes/${changeId}/attachments/${attId}`);
      onChanged();
    } catch (e) { setErr(e.message); }
  };

  if (attachments.length === 0 && !canManage) return null;

  return (
    <div className="note-attachments" style={{ marginTop: 8 }}>
      {attachments.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {attachments.map(a => {
            const isImage = a.mimeType.startsWith('image/');
            return (
              <span key={a.id} className="row" style={{ alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}>
                {isImage && <img src={a.url} alt="" style={{ height: 24, width: 24, objectFit: 'cover', borderRadius: 2 }} />}
                <a href={a.url} target="_blank" rel="noopener noreferrer">{a.originalFilename}</a>
                <span className="muted">{fmtBytes(a.sizeBytes)}</span>
                {canManage && (
                  <button className="danger" style={{ padding: '0 6px', fontSize: 11 }} onClick={() => remove(a.id)}>×</button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {canManage && (
        <>
          <input
            ref={fileInput}
            type="file"
            style={{ display: 'none' }}
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif,application/pdf,text/plain,text/csv,application/json"
            onChange={e => upload(e.target.files?.[0])}
          />
          <button
            type="button"
            className="secondary"
            style={{ padding: '2px 8px', fontSize: 12 }}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? 'Uploading…' : '+ Attach file'}
          </button>
        </>
      )}
    </div>
  );
}
