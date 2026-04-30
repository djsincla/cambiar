import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../api.js';
import { statusLabel, STATUS_LABELS, viewerHint } from '../statuses.js';
import { fmtDuration } from '../duration.js';

export default function ChangeList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const inbox = searchParams.get('awaiting') === 'true';

  const [filter, setFilter] = useState({ status: '', mine: false });
  const params = new URLSearchParams();
  if (inbox) {
    params.set('awaitingMyApproval', 'true');
  } else {
    if (filter.status) params.set('status', filter.status);
    if (filter.mine) params.set('mine', 'true');
  }
  const qs = params.toString() ? `?${params}` : '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['changes', { inbox, filter }],
    queryFn: () => api.get(`/api/changes${qs}`),
  });

  const setView = (view) => {
    if (view === 'inbox') setSearchParams({ awaiting: 'true' });
    else setSearchParams({});
  };

  return (
    <>
      <div className="row between">
        <h1>{inbox ? 'Awaiting my approval' : 'Changes'}</h1>
        <Link to="/changes/new"><button>+ New change</button></Link>
      </div>

      <div className="panel" style={{ padding: '12px 16px' }}>
        <div className="tabs">
          <button className={`tab ${!inbox ? 'active' : ''}`} onClick={() => setView('all')}>All changes</button>
          <button className={`tab ${inbox ? 'active' : ''}`} onClick={() => setView('inbox')}>
            Awaiting my approval
            {data && inbox && data.changes.length > 0 && <span className="tab-count">{data.changes.length}</span>}
          </button>
        </div>
      </div>

      {!inbox && (
        <div className="panel">
          <div className="row">
            <div>
              <label>Status</label>
              <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
                <option value="">All</option>
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div style={{ paddingTop: 28 }}>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
                <input type="checkbox" checked={filter.mine} onChange={e => setFilter(f => ({ ...f, mine: e.target.checked }))} style={{ width: 'auto' }} /> My changes only
              </label>
            </div>
          </div>
        </div>
      )}

      {isLoading && <div className="muted">Loading…</div>}
      {error && <div className="error">{error.message}</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>#</th><th>Title</th><th>Type</th><th>Status</th><th>Submitter</th><th>{inbox ? 'Submitted' : 'Updated'}</th></tr>
            </thead>
            <tbody>
              {data.changes.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                  {inbox ? 'No changes are waiting on you. Nice.' : 'No changes match.'}
                </td></tr>
              )}
              {data.changes.map(c => {
                const hint = viewerHint(c);
                return (
                  <tr key={c.id}>
                    <td><Link to={`/changes/${c.id}`}>{c.id}</Link></td>
                    <td><Link to={`/changes/${c.id}`}>{c.title}</Link></td>
                    <td>{c.typeKey}</td>
                    <td>
                      <span className={`badge ${c.status}`}>{statusLabel(c.status)}</span>
                      {hint && <span className={`viewer-hint ${hint.tone}`}>{hint.text}</span>}
                    </td>
                    <td>{c.submitter.displayName || c.submitter.username}</td>
                    <td className="muted">{inbox ? (c.submittedAt ?? c.updatedAt) : c.updatedAt}</td>
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
