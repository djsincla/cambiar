import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDuration } from '../duration.js';

export default function ChangeTemplates() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['change-templates'],
    queryFn: () => api.get('/api/change-templates'),
  });
  const [err, setErr] = useState(null);

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/api/change-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['change-templates'] }),
    onError: (e) => setErr(e.message),
  });

  return (
    <>
      <div className="row between">
        <h1>Change templates</h1>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Pre-filled blueprints for common changes. Use <strong>Start a change</strong> to create a new draft from a template, or save an existing change as a template from its detail page.
      </div>
      {err && <div className="error">{err}</div>}

      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Name</th><th>Type</th><th>Title</th><th>Duration</th><th>Created by</th><th></th></tr>
            </thead>
            <tbody>
              {data.templates.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                  No templates yet. From any change's detail page, click <strong>Save as template</strong>.
                </td></tr>
              )}
              {data.templates.map(t => {
                const canEdit = t.createdBy?.id === user.id || user.role === 'admin';
                return (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong>{t.description && <div className="muted" style={{ fontSize: 12 }}>{t.description}</div>}</td>
                    <td><code>{t.typeKey}</code></td>
                    <td>{t.title}</td>
                    <td>{fmtDuration(t.plannedDurationMinutes) ?? <span className="muted">—</span>}</td>
                    <td>{t.createdBy?.displayName || t.createdBy?.username || <span className="muted">—</span>}</td>
                    <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => nav(`/changes/new?templateId=${t.id}`)}>Start a change</button>
                      {canEdit && (
                        <button className="danger" onClick={() => { if (confirm(`Delete template "${t.name}"?`)) remove.mutate(t.id); }}>Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
