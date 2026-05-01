import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const KIND_LABEL = {
  approval_sla: 'Approval SLA',
  recurring_drift: 'Recurring drift',
};

function fmtAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export default function Alerts() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('active');
  const [err, setErr] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ['alerts', status],
    queryFn: () => api.get(`/api/alerts?status=${status}`),
  });

  const checkNow = useMutation({
    mutationFn: () => api.post('/api/alerts/check-now', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (e) => setErr(e.message),
  });

  const resolve = useMutation({
    mutationFn: (id) => api.post(`/api/alerts/${id}/resolve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (e) => setErr(e.message),
  });

  return (
    <>
      <div className="row between">
        <h1>Alerts</h1>
        <div className="row" style={{ gap: 8 }}>
          <div className="tabs">
            {['active', 'resolved'].map(s => (
              <button key={s} className={`tab ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <button onClick={() => { setErr(null); checkNow.mutate(); }} disabled={checkNow.isPending}>
            {checkNow.isPending ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Operational alerts raised by the scheduled check. Approval-SLA fires when a submitted change has been waiting past the configured threshold (default 24 h). Recurring-drift fires when a recurring parent's last fire is older than the most recent expected fire — usually a sign that the scheduler missed an interval or a fire failed silently.
      </div>

      {err && <div className="error">{err}</div>}
      {isLoading && <div className="muted">Loading…</div>}

      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Subject</th>
                <th>Fired</th>
                <th>Age</th>
                <th>Notified</th>
                {status === 'active' && <th></th>}
                {status === 'resolved' && <th>Resolved</th>}
              </tr>
            </thead>
            <tbody>
              {data.alerts.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                  {status === 'active' ? 'No active alerts. Quiet day.' : 'No resolved alerts yet.'}
                </td></tr>
              )}
              {data.alerts.map(a => (
                <tr key={a.id}>
                  <td><span className={`badge ${a.kind === 'approval_sla' ? 'submitted' : 'rolled_back'}`}>{KIND_LABEL[a.kind] ?? a.kind}</span></td>
                  <td>
                    {a.change ? (
                      <Link to={`/changes/${a.change.id}`}>#{a.change.id} · {a.change.title}</Link>
                    ) : <span className="muted">— change deleted —</span>}
                  </td>
                  <td>{a.firedAt}</td>
                  <td>{fmtAge(a.firedAt)}</td>
                  <td>{a.notifiedAt ? <span className="muted">sent</span> : <span className="muted">—</span>}</td>
                  {status === 'active' && (
                    <td className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button className="secondary" onClick={() => resolve.mutate(a.id)}>Resolve</button>
                    </td>
                  )}
                  {status === 'resolved' && <td>{a.resolvedAt}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
