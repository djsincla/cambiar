import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Attachments({ changeId }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['attachments', changeId],
    queryFn: () => api.get(`/api/changes/${changeId}/attachments`),
  });

  const [file, setFile] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/changes/${changeId}/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachments', changeId] }),
    onError: (e) => setErr(e.message),
  });

  const upload = async (e) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/changes/${changeId}/attachments`, {
        method: 'POST', credentials: 'include', body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setFile(null);
      qc.invalidateQueries({ queryKey: ['attachments', changeId] });
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const canDelete = (att) => att.uploader?.id === user.id || user.role === 'admin';

  return (
    <div className="panel">
      <h2>Attachments</h2>
      <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Images, PDFs, text/CSV/JSON. 10 MB max. Click an image to enlarge. Use a note's <code>![](url)</code> syntax to embed an attachment inline.
      </div>
      {err && <div className="error">{err}</div>}

      {isLoading && <div className="muted">Loading…</div>}
      {data && data.attachments.length === 0 && <div className="muted" style={{ fontStyle: 'italic', marginBottom: 12 }}>No attachments yet.</div>}

      {data && data.attachments.length > 0 && (
        <div className="att-grid">
          {data.attachments.map(a => {
            const isImage = a.mimeType.startsWith('image/');
            return (
              <div key={a.id} className="att-card">
                {isImage ? (
                  <button type="button" className="att-image-button" onClick={() => setLightbox(a)} aria-label={`Enlarge ${a.originalFilename}`}>
                    <img src={a.url} alt={a.originalFilename} className="att-thumb" />
                  </button>
                ) : (
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="att-file">
                    <div className="att-file-icon">{a.mimeType.includes('pdf') ? 'PDF' : 'FILE'}</div>
                    <div className="att-file-name">{a.originalFilename}</div>
                  </a>
                )}
                <div className="att-meta">
                  <span title={a.originalFilename} className="att-name">{a.originalFilename}</span>
                  <span className="muted"> · {fmtBytes(a.sizeBytes)}</span>
                </div>
                <div className="att-actions">
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="muted" style={{ fontSize: 12 }}>Open</a>
                  {canDelete(a) && (
                    <button className="danger" style={{ padding: '2px 6px', fontSize: 11 }}
                            onClick={() => { if (confirm(`Delete ${a.originalFilename}?`)) remove.mutate(a.id); }}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <form onSubmit={upload} style={{ marginTop: 16 }}>
        <input
          type="file"
          aria-label="Upload attachment"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif,application/pdf,text/plain,text/csv,application/json"
        />
        <div style={{ marginTop: 6 }}>
          <button type="submit" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        </div>
      </form>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Image preview">
          <img src={lightbox.url} alt={lightbox.originalFilename} />
        </div>
      )}
    </div>
  );
}
