import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { statusLabel } from '../statuses.js';
import { fmtDuration, variance } from '../duration.js';

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
  // Trust the server's eligibility check — it knows about groups + roles + auto-approve.
  const canApprove = c.viewerCanApprove;

  return (
    <>
      <div className="row between">
        <h1>#{c.id} · {c.title}</h1>
        <span className={`badge ${c.status}`}>{statusLabel(c.status)}</span>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        {c.typeKey} · submitted by {c.submitter.displayName || c.submitter.username} · created {c.createdAt}
      </div>

      <WhyPanel change={c} requiredApprovalGroups={data.requiredApprovalGroups ?? []} changeType={data.changeType} userRole={user.role} />

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

      </div>

      <SchedulePanel change={c} canEditActual={(c.viewerIsSubmitter || user.role === 'admin') && ['implemented', 'closed'].includes(c.status)} onChanged={() => qc.invalidateQueries({ queryKey: ['change', id] })} setErr={setErr} />

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
        {data.changeType?.autoApprove ? (
          <div>
            <span className="badge approved" style={{ marginRight: 8 }}>auto-approve</span>
            This change type is configured for auto-approval — submissions go straight from <em>draft</em> to <em>approved</em>.
          </div>
        ) : data.requiredApprovalGroups?.length ? (
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

/**
 * Explains the current state of the change in viewer-context terms, so the
 * user understands WHY there's no Approve button (or which one they should
 * press next).
 */
function SchedulePanel({ change, canEditActual, onChanged, setErr }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(change.actualDurationMinutes ?? '');

  const save = useMutation({
    mutationFn: (body) => api.patch(`/api/changes/${change.id}/actual-duration`, body),
    onSuccess: () => { setEditing(false); onChanged(); },
    onError: (e) => setErr(e.message),
  });

  const v = variance({ planned: change.plannedDurationMinutes, actual: change.actualDurationMinutes });

  return (
    <div className="panel">
      <h2>Schedule</h2>
      <table>
        <tbody>
          <tr>
            <td className="muted" style={{ width: 200 }}>Scheduled at</td>
            <td>{change.scheduledAt ? change.scheduledAt.replace('T', ' ').slice(0, 16) : <span className="muted">— not scheduled —</span>}</td>
          </tr>
          <tr>
            <td className="muted">Planned duration</td>
            <td>{fmtDuration(change.plannedDurationMinutes) ?? <span className="muted">— not set —</span>}</td>
          </tr>
          {(change.actualDurationMinutes != null || canEditActual) && (
            <tr>
              <td className="muted">Actual duration</td>
              <td className="row" style={{ gap: 12, alignItems: 'center' }}>
                {editing ? (
                  <>
                    <input
                      aria-label="Actual duration minutes"
                      type="number" min={1} max={43200}
                      value={val}
                      onChange={e => setVal(e.target.value)}
                      style={{ width: 120 }}
                      placeholder="minutes"
                    />
                    <button onClick={() => save.mutate({ actualDurationMinutes: val === '' ? null : Number(val) })} disabled={save.isPending}>Save</button>
                    <button className="secondary" onClick={() => { setEditing(false); setVal(change.actualDurationMinutes ?? ''); }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span>
                      {fmtDuration(change.actualDurationMinutes) ?? <span className="muted">— not recorded —</span>}
                    </span>
                    {v && <span className={`badge ${v.tone === 'success' ? 'approved' : 'submitted'}`}>{v.label}</span>}
                    {canEditActual && (
                      <button className="secondary" onClick={() => setEditing(true)}>
                        {change.actualDurationMinutes == null ? 'Record actual' : 'Edit'}
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          )}
          {change.implementedAt && (
            <tr>
              <td className="muted">Implemented at</td>
              <td>{change.implementedAt}</td>
            </tr>
          )}
          {change.closedAt && (
            <tr>
              <td className="muted">Closed at</td>
              <td>{change.closedAt}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function WhyPanel({ change, requiredApprovalGroups, changeType, userRole }) {
  const { status, viewerIsSubmitter, viewerCanApprove } = change;

  let title = '';
  let body = null;
  let tone = 'info';

  if (status === 'draft') {
    if (viewerIsSubmitter) {
      title = 'This is your draft';
      body = <span>Submit it for approval when you’re ready. Once submitted, only the approvers can move it forward.</span>;
    } else {
      title = `Draft owned by ${change.submitter.displayName || change.submitter.username}`;
      body = <span>Drafts are private to their owner — only the submitter (or an admin) can edit or submit it.</span>;
      tone = 'muted';
    }
  } else if (status === 'submitted') {
    if (changeType?.autoApprove) {
      title = 'Pending — but this should never sit here';
      body = <span>This change type is set to auto-approve, so submissions normally bounce straight through to <em>approved</em>. If you’re seeing it stuck here, the auto-approve flag was flipped on after the fact — flip it off and approve manually, or contact an admin.</span>;
      tone = 'warning';
    } else if (viewerCanApprove) {
      title = 'Awaiting your approval';
      body = <span>Press <strong>Approve</strong> or <strong>Reject</strong> below. Add a comment if you want it on the audit log.</span>;
      tone = 'attention';
    } else if (viewerIsSubmitter) {
      title = 'You submitted this — someone else has to approve it';
      body = (
        <span>
          Cambiar enforces segregation of duties: a submitter can never approve their own change.
          {requiredApprovalGroups.length > 0
            ? <> Approval can come from any one member of: {requiredApprovalGroups.map(g => <span key={g.id} className="badge" style={{ marginLeft: 4 }}>{g.name}</span>)}, or any admin.</>
            : <> Any admin{userRole === 'approver' ? ' or anyone with the legacy approver role' : ''} can approve this.</>}
        </span>
      );
      tone = 'muted';
    } else {
      title = 'You can’t approve this change';
      if (requiredApprovalGroups.length > 0) {
        body = <span>Only members of {requiredApprovalGroups.map(g => <span key={g.id} className="badge" style={{ marginLeft: 4 }}>{g.name}</span>)} (or an admin) can approve. Ask an admin to add you to one of those groups if you should have access.</span>;
      } else {
        body = <span>This change type has no approver groups configured, so only an admin{userRole !== 'admin' ? ' or someone with the legacy approver role' : ''} can approve it.</span>;
      }
      tone = 'muted';
    }
  } else if (status === 'approved') {
    if (viewerIsSubmitter) {
      title = 'Approved — ready to implement';
      body = <span>Once you’ve actually made the change in the field, press <strong>Mark implemented</strong>.</span>;
      tone = 'attention';
    } else if (userRole === 'admin') {
      title = 'Approved';
      body = <span>The submitter (or any admin) marks this implemented when the change is made.</span>;
      tone = 'muted';
    } else {
      title = 'Approved';
      body = <span>Waiting on the submitter to mark this implemented.</span>;
      tone = 'muted';
    }
  } else if (status === 'implemented') {
    if (viewerIsSubmitter || userRole === 'admin') {
      title = 'Implemented — ready to close';
      body = <span>If everything held, press <strong>Close</strong>. If something went sideways, press <strong>Roll back</strong>.</span>;
    } else {
      title = 'Implemented';
      body = <span>Waiting on the submitter (or an admin) to close it out.</span>;
      tone = 'muted';
    }
  } else if (status === 'closed') {
    title = 'Closed';
    body = <span>This change is complete. It can still be rolled back if something turns up later.</span>;
    tone = 'muted';
  } else if (status === 'rejected') {
    title = 'Rejected';
    body = <span>An approver declined this change. To try again, create a new draft.</span>;
    tone = 'muted';
  } else if (status === 'rolled_back') {
    title = 'Rolled back';
    body = <span>This change was rolled back after implementation.</span>;
    tone = 'muted';
  }

  if (!title) return null;
  return (
    <div className={`panel why-panel ${tone}`}>
      <strong>{title}</strong>
      <div style={{ marginTop: 6 }}>{body}</div>
    </div>
  );
}
