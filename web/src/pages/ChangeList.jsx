import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../api.js';

export default function ChangeList() {
  const [filter, setFilter] = useState({ status: '', mine: false });
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.mine) params.set('mine', 'true');
  const qs = params.toString() ? `?${params}` : '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['changes', filter],
    queryFn: () => api.get(`/api/changes${qs}`),
  });

  return (
    <>
      <div className="row between">
        <h1>Changes</h1>
        <Link to="/changes/new"><button>+ New change</button></Link>
      </div>
      <div className="panel">
        <div className="row">
          <div>
            <label>Status</label>
            <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="implemented">Implemented</option>
              <option value="closed">Closed</option>
              <option value="rejected">Rejected</option>
              <option value="rolled_back">Rolled back</option>
            </select>
          </div>
          <div style={{ paddingTop: 28 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" checked={filter.mine} onChange={e => setFilter(f => ({ ...f, mine: e.target.checked }))} style={{ width: 'auto' }} /> My changes only
            </label>
          </div>
        </div>
      </div>

      {isLoading && <div className="muted">Loading…</div>}
      {error && <div className="error">{error.message}</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>#</th><th>Title</th><th>Type</th><th>Status</th><th>Submitter</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {data.changes.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No changes match.</td></tr>}
              {data.changes.map(c => (
                <tr key={c.id}>
                  <td><Link to={`/changes/${c.id}`}>{c.id}</Link></td>
                  <td><Link to={`/changes/${c.id}`}>{c.title}</Link></td>
                  <td>{c.typeKey}</td>
                  <td><span className={`badge ${c.status}`}>{c.status.replace('_', ' ')}</span></td>
                  <td>{c.submitter.displayName || c.submitter.username}</td>
                  <td className="muted">{c.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
