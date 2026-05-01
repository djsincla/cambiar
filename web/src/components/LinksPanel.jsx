import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { statusLabel } from '../statuses.js';

const KIND_LABEL = {
  depends_on: 'Depends on',
  relates_to: 'Related to',
};

export default function LinksPanel({ change, links, onChanged, setErr }) {
  const { user } = useAuth();
  const canManage = change.submitter.id === user.id || user.role === 'admin';
  const [adding, setAdding] = useState(false);
  const [toChangeId, setToChangeId] = useState('');
  const [kind, setKind] = useState('depends_on');

  const add = useMutation({
    mutationFn: () => api.post(`/api/changes/${change.id}/links`, {
      toChangeId: Number(toChangeId),
      kind,
    }),
    onSuccess: () => { setAdding(false); setToChangeId(''); onChanged(); setErr(null); },
    onError: (e) => setErr(e.message),
  });

  const remove = useMutation({
    mutationFn: (linkId) => api.delete(`/api/changes/${change.id}/links/${linkId}`),
    onSuccess: () => onChanged(),
    onError: (e) => setErr(e.message),
  });

  const dependsOn = links?.dependsOn ?? [];
  const blocks = links?.blocks ?? [];
  const relatedTo = links?.relatedTo ?? [];
  const blockedBy = links?.blockedBy ?? [];

  const isEmpty = dependsOn.length === 0 && blocks.length === 0 && relatedTo.length === 0;
  if (!canManage && isEmpty) return null;

  return (
    <div className="panel">
      <div className="row between">
        <h2>Linked changes</h2>
        {canManage && !adding && (
          <button className="secondary" onClick={() => { setAdding(true); setErr(null); }}>+ Link a change</button>
        )}
      </div>

      {blockedBy.length > 0 && (
        <div className="banner" style={{ marginBottom: 12 }}>
          Blocked by {blockedBy.length} unfinished prerequisite{blockedBy.length > 1 ? 's' : ''} — Start and Implement won't run until those are implemented or closed.
        </div>
      )}

      {adding && (
        <div style={{ marginBottom: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel-2)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 auto' }}>
              <label style={{ marginBottom: 4 }}>Relationship</label>
              <select aria-label="Link kind" value={kind} onChange={e => setKind(e.target.value)}>
                <option value="depends_on">Depends on (gates start/implement)</option>
                <option value="relates_to">Related to (informational)</option>
              </select>
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <label style={{ marginBottom: 4 }}>Other change ID</label>
              <input
                aria-label="Other change ID"
                type="number" min={1}
                value={toChangeId}
                onChange={e => setToChangeId(e.target.value)}
                placeholder="e.g. 42"
              />
            </div>
            <button onClick={() => add.mutate()} disabled={!toChangeId || add.isPending}>
              {add.isPending ? 'Linking…' : 'Add link'}
            </button>
            <button className="secondary" onClick={() => { setAdding(false); setToChangeId(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {isEmpty && !adding && <div className="muted">No links yet.</div>}

      {dependsOn.length > 0 && (
        <LinkList title="Depends on" items={dependsOn} canManage={canManage} onRemove={(id) => remove.mutate(id)} highlightBlocking />
      )}
      {blocks.length > 0 && (
        <LinkList title="Blocks" items={blocks} canManage={false} subtitle="These changes depend on this one." />
      )}
      {relatedTo.length > 0 && (
        <LinkList title="Related to" items={relatedTo} canManage={canManage} onRemove={(id) => remove.mutate(id)} />
      )}
    </div>
  );
}

function LinkList({ title, items, canManage, onRemove, highlightBlocking, subtitle }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{title}</div>
      {subtitle && <div className="muted" style={{ marginBottom: 6 }}>{subtitle}</div>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map(it => {
          const isBlocking = highlightBlocking && !['implemented', 'closed'].includes(it.status);
          return (
            <li key={it.linkId} className="row" style={{ gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span className={`badge ${it.status}`}>{statusLabel(it.status)}</span>
              <Link to={`/changes/${it.id}`} style={{ flex: 1 }}>#{it.id} · {it.title}</Link>
              {isBlocking && <span className="muted" style={{ fontSize: 12 }}>(not yet implemented)</span>}
              {canManage && onRemove && (
                <button className="secondary" onClick={() => onRemove(it.linkId)} style={{ padding: '2px 8px' }}>Remove</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
