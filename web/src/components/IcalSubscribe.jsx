import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';

export default function IcalSubscribe() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['ical-token'],
    queryFn: () => api.get('/api/auth/me/ical-token'),
    enabled: open,
  });

  const rotate = useMutation({
    mutationFn: () => api.post('/api/auth/me/ical-token/rotate', {}),
    onSuccess: (r) => qc.setQueryData(['ical-token'], r),
  });

  const copy = async () => {
    if (!data?.url) return;
    await navigator.clipboard.writeText(data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)}>Subscribe…</button>
    );
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Calendar feed</h2>
        <button className="secondary" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
        Subscribe to this URL from Google Calendar, Apple Calendar, or any iCal-compatible app to see upcoming cambiar.world changes alongside your other events. The token in the URL is the credential — don't share it widely. Rotate it if it's been exposed.
      </div>
      {isLoading && <div className="muted">Loading…</div>}
      {data && (
        <>
          <label>Subscription URL</label>
          <input
            aria-label="iCal subscription URL"
            readOnly
            value={data.url}
            onFocus={e => e.target.select()}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button onClick={copy}>{copied ? 'Copied!' : 'Copy URL'}</button>
            <button className="secondary" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
              {rotate.isPending ? 'Rotating…' : 'Rotate token'}
            </button>
          </div>
          <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            <strong>Google Calendar:</strong> + → Other calendars → From URL.
            <strong style={{ marginLeft: 12 }}>Apple Calendar:</strong> File → New Calendar Subscription.
          </div>
        </>
      )}
    </div>
  );
}
