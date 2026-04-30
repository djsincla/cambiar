import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { statusLabel, STATUS_LABELS, viewerHint } from '../statuses.js';

const ALL_STATUSES = Object.keys(STATUS_LABELS);
const DEFAULT_STATUSES = ['submitted', 'approved', 'implemented'];

function isoDate(d) { return d.toISOString().slice(0, 10); }

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

function monthGrid(monthStart) {
  // Return a flat array of date objects covering full weeks (Mon-Sun rows).
  const first = startOfMonth(monthStart);
  const last = endOfMonth(monthStart);
  const dayOfWeekMon0 = (first.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const start = new Date(first);
  start.setDate(start.getDate() - dayOfWeekMon0);
  const days = [];
  const cursor = new Date(start);
  while (cursor <= last || days.length % 7 !== 0) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (days.length >= 42) break;
  }
  return days;
}

function fmtMonth(d) { return d.toLocaleString(undefined, { month: 'long', year: 'numeric' }); }
function fmtDay(d) { return d.getDate(); }

export default function Upcoming() {
  const [view, setView] = useState('list'); // 'list' | 'calendar'
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [statuses, setStatuses] = useState(new Set(DEFAULT_STATUSES));

  const range = useMemo(() => {
    if (view === 'calendar') {
      const days = monthGrid(month);
      return { from: days[0], to: days[days.length - 1] };
    }
    // List mode: a 14-day rolling window.
    const from = new Date();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    return { from, to };
  }, [view, month]);

  const params = new URLSearchParams();
  params.set('scheduledFrom', range.from.toISOString());
  params.set('scheduledTo', range.to.toISOString());
  if (statuses.size > 0 && statuses.size < ALL_STATUSES.length) {
    params.set('status', [...statuses].join(','));
  }

  const { data, isLoading } = useQuery({
    queryKey: ['upcoming', view, range.from.toISOString(), range.to.toISOString(), [...statuses].sort().join(',')],
    queryFn: () => api.get(`/api/changes?${params}`),
  });

  const toggleStatus = (s) => {
    setStatuses(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  return (
    <>
      <div className="row between">
        <h1>Upcoming changes</h1>
        <div className="tabs">
          <button className={`tab ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>List</button>
          <button className={`tab ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}>Calendar</button>
        </div>
      </div>

      <div className="panel" style={{ padding: '12px 16px' }}>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>Filter status:</span>
          {ALL_STATUSES.map(s => (
            <label key={s} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
              <input type="checkbox" checked={statuses.has(s)} onChange={() => toggleStatus(s)} style={{ width: 'auto' }} />
              <span className={`badge ${s}`} style={{ fontSize: 11 }}>{statusLabel(s)}</span>
            </label>
          ))}
        </div>
      </div>

      {view === 'calendar' && (
        <div className="panel">
          <div className="row between" style={{ marginBottom: 12 }}>
            <button className="secondary" onClick={() => setMonth(m => addMonths(m, -1))}>← Previous</button>
            <strong>{fmtMonth(month)}</strong>
            <button className="secondary" onClick={() => setMonth(m => addMonths(m, 1))}>Next →</button>
          </div>
          <CalendarGrid month={month} changes={data?.changes ?? []} />
        </div>
      )}

      {view === 'list' && (
        <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>
          Next 14 days. Sorted by scheduled time.
        </div>
      )}

      {isLoading && <div className="muted">Loading…</div>}
      {view === 'list' && data && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>#</th><th>Scheduled</th><th>Title</th><th>Type</th><th>Status</th><th>Submitter</th></tr>
            </thead>
            <tbody>
              {data.changes.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                  No upcoming changes match these filters.
                </td></tr>
              )}
              {data.changes.map(c => {
                const hint = viewerHint(c);
                return (
                  <tr key={c.id}>
                    <td><Link to={`/changes/${c.id}`}>{c.id}</Link></td>
                    <td className="muted">{(c.scheduledAt ?? '').replace('T', ' ').slice(0, 16)}</td>
                    <td><Link to={`/changes/${c.id}`}>{c.title}</Link></td>
                    <td>{c.typeKey}</td>
                    <td>
                      <span className={`badge ${c.status}`}>{statusLabel(c.status)}</span>
                      {hint && <span className={`viewer-hint ${hint.tone}`}>{hint.text}</span>}
                    </td>
                    <td>{c.submitter.displayName || c.submitter.username}</td>
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

function CalendarGrid({ month, changes }) {
  const days = monthGrid(month);
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // Bucket changes by yyyy-mm-dd.
  const byDay = new Map();
  for (const c of changes) {
    if (!c.scheduledAt) continue;
    const day = c.scheduledAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  const today = isoDate(new Date());
  return (
    <div className="cal-grid">
      {weekdayLabels.map(l => <div key={l} className="cal-head">{l}</div>)}
      {days.map((d, i) => {
        const key = isoDate(d);
        const inMonth = d.getMonth() === month.getMonth();
        const items = byDay.get(key) ?? [];
        return (
          <div key={i} className={`cal-cell ${inMonth ? '' : 'other-month'} ${key === today ? 'today' : ''}`}>
            <div className="cal-day">{fmtDay(d)}</div>
            <div className="cal-items">
              {items.slice(0, 3).map(c => (
                <Link key={c.id} to={`/changes/${c.id}`} className={`cal-chip ${c.status}`} title={`#${c.id} ${c.title}`}>
                  {c.title}
                </Link>
              ))}
              {items.length > 3 && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>+{items.length - 3} more</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
