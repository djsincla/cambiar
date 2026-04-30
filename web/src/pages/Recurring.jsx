import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Recurring() {
  const { data, isLoading } = useQuery({
    queryKey: ['recurring-parents'],
    queryFn: () => api.get('/api/changes?recurring=parents'),
    refetchInterval: 60_000,
  });

  return (
    <>
      <div className="row between">
        <h1>Recurring changes</h1>
      </div>
      <div className="muted" style={{ marginBottom: 16 }}>
        Changes marked as recurring parents. Each one spawns a child change on its cron schedule. Parents themselves don't run the lifecycle — their children do. Mark any existing change as recurring from its detail page.
      </div>

      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>#</th><th>Title</th><th>Type</th><th>Cron</th><th>Time zone</th><th>Lead</th><th>Auto-submit</th><th>Enabled</th><th>Last fired</th><th>Children</th></tr>
            </thead>
            <tbody>
              {data.recurringParents.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                  No recurring changes yet. Open any change and click <strong>Make recurring</strong>.
                </td></tr>
              )}
              {data.recurringParents.map(p => (
                <tr key={p.id} style={{ opacity: p.recurrenceEnabled ? 1 : 0.5 }}>
                  <td><Link to={`/changes/${p.id}`}>{p.id}</Link></td>
                  <td><Link to={`/changes/${p.id}`}>{p.title}</Link></td>
                  <td>{p.typeKey}</td>
                  <td><code>{p.recurrenceCron}</code></td>
                  <td className="muted">{p.recurrenceTimezone}</td>
                  <td>{p.recurrenceLeadMinutes}m</td>
                  <td>{p.recurrenceAutoSubmit ? 'yes' : 'no'}</td>
                  <td>{p.recurrenceEnabled ? 'yes' : <span style={{ color: 'var(--danger)' }}>no</span>}</td>
                  <td className="muted">{p.recurrenceLastFiredAt ?? '—'}</td>
                  <td>{p.childCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
