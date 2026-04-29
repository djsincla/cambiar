import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function ChangeDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['change', id],
    queryFn: () => api.get(`/api/changes/${id}`),
  });

  const action = useMutation({
    mutationFn: ({ verb, body }) => api.post(`/api/changes/${id}/${verb}`, body ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['change', id] }),
    onError: (e) => setErr(e.message),
  });

  if (isLoading || !data) return <div className="muted">Loading…</div>;
  const c = data.change;
  const isOwner = c.submitter.id === user.id;
  const canApprove = ['admin', 'approver'].includes(user.role) && c.submitter.id !== user.id;

  return (
    <>
      <div className="row between">
        <h1>#{c.id} · {c.title}</h1>
        <span className={`badge ${c.status}`}>{c.status.replace('_', ' ')}</span>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        {c.typeKey} · submitted by {c.submitter.displayName || c.submitter.username} · created {c.createdAt}
      </div>

      {err && <div className="error">{err}</div>}

      <div className="panel">
        <h2>Description</h2>
        <div>{c.description || <span className="muted">No description</span>}</div>

        <h2>Details</h2>
        <table>
          <tbody>
            {Object.keys(c.fields).length === 0 && <tr><td colSpan={2} className="muted">No fields</td></tr>}
            {Object.entries(c.fields).map(([k, v]) => (
              <tr key={k}><td className="muted" style={{ width: 220 }}>{k}</td><td>{String(v)}</td></tr>
            ))}
          </tbody>
        </table>

        {c.scheduledAt && <p className="muted">Scheduled: {c.scheduledAt}</p>}
      </div>

      <div className="panel">
        <h2>Actions</h2>
        {(c.status === 'submitted' || c.status === 'approved') && (
          <>
            <label>Comment (optional)</label>
            <textarea value={comment} onChange={e => setComment(e.target.value)} />
          </>
        )}
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          {c.status === 'draft' && isOwner &&
            <button onClick={() => action.mutate({ verb: 'submit' })}>Submit for approval</button>}
          {c.status === 'submitted' && canApprove && <>
            <button onClick={() => action.mutate({ verb: 'approve', body: { comment } })}>Approve</button>
            <button className="danger" onClick={() => action.mutate({ verb: 'reject', body: { comment } })}>Reject</button>
          </>}
          {c.status === 'approved' && (isOwner || user.role === 'admin') &&
            <button onClick={() => action.mutate({ verb: 'implement' })}>Mark implemented</button>}
          {c.status === 'implemented' && (isOwner || user.role === 'admin') && <>
            <button onClick={() => action.mutate({ verb: 'close' })}>Close</button>
            <button className="secondary" onClick={() => action.mutate({ verb: 'rollback', body: { comment } })}>Roll back</button>
          </>}
          <Link to="/changes"><button className="secondary">Back to list</button></Link>
        </div>
      </div>

      <div className="panel">
        <h2>Approval policy</h2>
        {data.requiredApprovalGroups?.length ? (
          <div>Any one member of: {data.requiredApprovalGroups.map(g => <span key={g.id} className="badge" style={{ marginRight: 6 }}>{g.name}</span>)}</div>
        ) : (
          <div className="muted">No approver groups configured for this type — admin or anyone with <code>approver</code> role can approve (legacy fallback).</div>
        )}
      </div>

      {data.approvals.length > 0 && (
        <div className="panel">
          <h2>Approvals</h2>
          {data.approvals.map(a => (
            <div key={a.id} className="audit-item">
              <span className="who">{a.approver.displayName || a.approver.username}</span> {a.decision} at {a.decidedAt}
              {a.comment && <div style={{ marginTop: 4 }}>"{a.comment}"</div>}
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <h2>History</h2>
        {data.audit.map(a => (
          <div key={a.id} className="audit-item">
            <span className="who">{a.user?.displayName || a.user?.username || 'system'}</span> · {a.action}
            {a.fromStatus && a.toStatus && ` · ${a.fromStatus} → ${a.toStatus}`}
            {' · '}{a.createdAt}
          </div>
        ))}
      </div>
    </>
  );
}
