import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { statusLabel, STATUS_LABELS, viewerHint } from '../statuses.js';
import { fmtDuration } from '../duration.js';
import IcalSubscribe from '../components/IcalSubscribe.jsx';

const ALL_STATUSES = Object.keys(STATUS_LABELS);
const DEFAULT_STATUSES = ['submitted', 'approved', 'implemented'];

const HOUR_HEIGHT = 36;       // pixels per hour in the time-grid
const DAY_START_HOUR = 6;     // first hour shown on the time-grid
const DAY_END_HOUR = 24;      // exclusive

function isoDate(d) { return d.toISOString().slice(0, 10); }

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
function startOfDay(d)   { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function endOfDay(d)     { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }

function startOfWeek(d) {
  // Monday-start week.
  const r = startOfDay(d);
  const dow = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - dow);
  return r;
}
function endOfWeek(d) {
  const start = startOfWeek(d);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);
}

function addDays(d, n)   { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function addWeeks(d, n)  { return addDays(d, n * 7); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

function monthGrid(monthStart) {
  const first = startOfMonth(monthStart);
  const last = endOfMonth(monthStart);
  const dayOfWeekMon0 = (first.getDay() + 6) % 7;
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
function fmtDayHeading(d) { return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
function fmtDayShort(d) { return d.toLocaleString(undefined, { weekday: 'short' }); }
function fmtTime(d) { return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }); }

export default function Upcoming() {
  const [view, setView] = useState('month'); // 'month' | 'week' | 'day' | 'list'
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [statuses, setStatuses] = useState(new Set(DEFAULT_STATUSES));

  const range = useMemo(() => {
    if (view === 'month') {
      const days = monthGrid(startOfMonth(anchor));
      return { from: days[0], to: days[days.length - 1] };
    }
    if (view === 'week') {
      return { from: startOfWeek(anchor), to: endOfWeek(anchor) };
    }
    if (view === 'day') {
      return { from: startOfDay(anchor), to: endOfDay(anchor) };
    }
    // List = next 14 days from today
    const from = startOfDay(new Date());
    return { from, to: new Date(from.getTime() + 14 * 24 * 3600 * 1000) };
  }, [view, anchor]);

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

  const toggleStatus = (s) => setStatuses(prev => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s); else next.add(s);
    return next;
  });

  const goPrev = () => {
    if (view === 'month') setAnchor(addMonths(anchor, -1));
    else if (view === 'week') setAnchor(addWeeks(anchor, -1));
    else if (view === 'day') setAnchor(addDays(anchor, -1));
  };
  const goNext = () => {
    if (view === 'month') setAnchor(addMonths(anchor, 1));
    else if (view === 'week') setAnchor(addWeeks(anchor, 1));
    else if (view === 'day') setAnchor(addDays(anchor, 1));
  };
  const goToday = () => setAnchor(startOfDay(new Date()));

  const headerLabel = useMemo(() => {
    if (view === 'month') return fmtMonth(anchor);
    if (view === 'week') {
      const s = startOfWeek(anchor);
      const e = endOfWeek(anchor);
      return `${fmtDayHeading(s)} — ${fmtDayHeading(e)}`;
    }
    if (view === 'day') return fmtDayHeading(anchor);
    return 'Next 14 days';
  }, [view, anchor]);

  return (
    <>
      <div className="row between">
        <h1>Upcoming changes</h1>
        <div className="row" style={{ gap: 8 }}>
          <IcalSubscribe />
          <div className="tabs">
            {['month', 'week', 'day', 'list'].map(v => (
              <button key={v} className={`tab ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
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

      {view !== 'list' && (
        <div className="panel">
          <div className="row between" style={{ marginBottom: 12 }}>
            <button className="secondary" onClick={goPrev}>← Previous</button>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <strong>{headerLabel}</strong>
              <button className="secondary" onClick={goToday}>Today</button>
            </div>
            <button className="secondary" onClick={goNext}>Next →</button>
          </div>

          {view === 'month' && <MonthGrid month={startOfMonth(anchor)} changes={data?.changes ?? []} />}
          {view === 'week' && <TimeGrid days={weekDays(anchor)} changes={data?.changes ?? []} />}
          {view === 'day' && <TimeGrid days={[startOfDay(anchor)]} changes={data?.changes ?? []} />}
        </div>
      )}

      {view === 'list' && (
        <div className="muted" style={{ marginBottom: 8, fontSize: 13 }}>Next 14 days, sorted by scheduled time.</div>
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
                    <td className="muted">
                      {(c.scheduledAt ?? '').replace('T', ' ').slice(0, 16)}
                      {fmtDuration(c.plannedDurationMinutes) && <span className="muted"> · {fmtDuration(c.plannedDurationMinutes)}</span>}
                    </td>
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

function weekDays(anchor) {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function MonthGrid({ month, changes }) {
  const days = monthGrid(month);
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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
        const items = (byDay.get(key) ?? []).slice().sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
        return (
          <div key={i} className={`cal-cell ${inMonth ? '' : 'other-month'} ${key === today ? 'today' : ''}`}>
            <div className="cal-day">{d.getDate()}</div>
            <div className="cal-items">
              {items.slice(0, 3).map(c => {
                const time = (c.scheduledAt ?? '').slice(11, 16);
                const dur = fmtDuration(c.plannedDurationMinutes);
                return (
                  <Link key={c.id} to={`/changes/${c.id}`} className={`cal-chip ${c.status}`} title={`#${c.id} ${c.title}${dur ? ` (${dur})` : ''}`}>
                    {time && <span style={{ opacity: 0.7 }}>{time} </span>}
                    {c.title}
                    {dur && <span style={{ opacity: 0.7 }}> · {dur}</span>}
                  </Link>
                );
              })}
              {items.length > 3 && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>+{items.length - 3} more</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Time-grid: hours as rows, days as columns. Each change is rendered as an
 * absolutely-positioned block sized by its planned duration (default 60min
 * if not set). Overlapping blocks within the same column stack side-by-side.
 */
function TimeGrid({ days, changes }) {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const today = isoDate(new Date());

  // Bucket changes by day (yyyy-mm-dd local — we already store ISO so slice is fine).
  const byDay = new Map();
  for (const d of days) byDay.set(isoDate(d), []);
  for (const c of changes) {
    if (!c.scheduledAt) continue;
    const day = c.scheduledAt.slice(0, 10);
    if (byDay.has(day)) byDay.get(day).push(c);
  }

  return (
    <div className="time-grid" style={{ '--hour-h': `${HOUR_HEIGHT}px`, '--total-h': `${totalHours * HOUR_HEIGHT}px`, gridTemplateColumns: `60px repeat(${days.length}, 1fr)` }}>
      <div className="time-head">&nbsp;</div>
      {days.map(d => (
        <div key={isoDate(d)} className={`time-head ${isoDate(d) === today ? 'today' : ''}`}>
          {fmtDayShort(d)} <span className="muted">{d.getMonth() + 1}/{d.getDate()}</span>
        </div>
      ))}

      <div className="time-hours">
        {Array.from({ length: totalHours }, (_, i) => DAY_START_HOUR + i).map(h => (
          <div key={h} className="time-hour">{String(h).padStart(2, '0')}:00</div>
        ))}
      </div>

      {days.map(d => {
        const items = byDay.get(isoDate(d)) ?? [];
        const placed = layoutDay(items);
        return (
          <div key={isoDate(d)} className="time-day">
            {Array.from({ length: totalHours }, (_, i) => (
              <div key={i} className="time-row" />
            ))}
            {placed.map(({ change, top, height, leftPct, widthPct }) => {
              const time = (change.scheduledAt ?? '').slice(11, 16);
              const dur = fmtDuration(change.plannedDurationMinutes ?? 60);
              return (
                <Link
                  key={change.id}
                  to={`/changes/${change.id}`}
                  className={`time-block ${change.status}`}
                  style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`#${change.id} ${change.title} · ${time}${dur ? ` · ${dur}` : ''}`}
                >
                  <div className="time-block-title">{change.title}</div>
                  <div className="time-block-meta">{time}{dur && ` · ${dur}`}</div>
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Compute pixel positions for a day's worth of changes, including basic
 * left/right splitting for overlaps. Overlapping events stack into columns;
 * each event is given the full width of its column.
 */
function layoutDay(items) {
  const sorted = items.slice().sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
  const placements = [];

  // Greedy column assignment: walk sorted list, drop into the first column
  // whose previous event ended before this one starts.
  const activeColumns = []; // each: { endMin: number }
  for (const c of sorted) {
    const startMin = minutesIntoDay(c.scheduledAt);
    const dur = Math.max(15, Number(c.plannedDurationMinutes ?? 60));
    const endMin = startMin + dur;
    let col = activeColumns.findIndex(a => a.endMin <= startMin);
    if (col === -1) { col = activeColumns.length; activeColumns.push({ endMin }); }
    else activeColumns[col].endMin = endMin;
    placements.push({ change: c, col, startMin, endMin });
  }
  const cols = Math.max(1, activeColumns.length);

  return placements.map(p => {
    const top = ((p.startMin - DAY_START_HOUR * 60) / 60) * HOUR_HEIGHT;
    const clampedTop = Math.max(0, top);
    const fullHeight = ((p.endMin - p.startMin) / 60) * HOUR_HEIGHT;
    const visibleHeight = Math.max(20, fullHeight - (top - clampedTop));
    return {
      change: p.change,
      top: `${clampedTop}px`,
      height: `${visibleHeight}px`,
      leftPct: (p.col / cols) * 100,
      widthPct: (1 / cols) * 100,
    };
  });
}

function minutesIntoDay(iso) {
  // Use the local-time interpretation of the stored ISO so blocks line up
  // with the labels the user is reading.
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}
