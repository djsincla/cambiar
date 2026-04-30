import { useState } from 'react';
import { useBranding } from '../branding.jsx';
import { api } from '../api.js';

export default function Settings() {
  const { appName, logoUrl, refresh } = useBranding();
  const [file, setFile] = useState(null);
  const [name, setName] = useState(appName);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState(null);

  const onUpload = async (e) => {
    e.preventDefault();
    if (!file) return;
    setErr(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const res = await fetch('/api/settings/branding/logo', { method: 'POST', credentials: 'include', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      await refresh();
      setFile(null);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const onClearLogo = async () => {
    setBusy(true); setErr(null);
    try {
      await api.delete('/api/settings/branding/logo');
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const onSaveName = async () => {
    setBusy(true); setErr(null);
    try {
      await api.request ? null : null;
      const res = await fetch('/api/settings/branding', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName: name }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      await refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const sendTest = async (e) => {
    e.preventDefault();
    setTestResult(null); setBusy(true);
    try {
      const r = await api.post('/api/settings/email/test', { to: testTo });
      setTestResult({ ok: true, message: `Sent. Check ${testTo}.` });
    } catch (e) {
      setTestResult({ ok: false, message: e.data?.error || e.message });
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Settings</h1>
      {err && <div className="error">{err}</div>}

      <div className="panel">
        <h2>Email</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          Send a real test email through your configured SMTP transport. Use this to verify <code>config/notifications.json</code> and the <code>SMTP_PASSWORD</code> env var are correct before relying on workflow emails or scheduled digests.
        </div>
        <form onSubmit={sendTest} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label>Send a test email to</label>
            <input aria-label="Test recipient" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="you@your-workshop.com" required />
          </div>
          <button type="submit" disabled={busy || !testTo}>Send test email</button>
        </form>
        {testResult && (
          <div style={{ marginTop: 8, color: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
            {testResult.message}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Branding</h2>
        <label>Application name</label>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={64} />
        <div style={{ marginTop: 8 }}>
          <button onClick={onSaveName} disabled={busy || name === appName}>Save name</button>
        </div>

        <h2>Logo</h2>
        <div className="muted" style={{ marginBottom: 8 }}>PNG, SVG, JPEG, or WebP. Max 1 MB. Shown top-left for everyone (including the login screen).</div>
        {logoUrl ? (
          <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <img src={logoUrl} alt="current logo" style={{ maxHeight: 60, maxWidth: 240, background: '#fff', padding: 8, borderRadius: 4 }} />
            <button className="danger" onClick={onClearLogo} disabled={busy}>Remove logo</button>
          </div>
        ) : (
          <div className="muted" style={{ marginBottom: 12 }}>No logo uploaded — text mark is shown.</div>
        )}

        <form onSubmit={onUpload}>
          <input type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <div style={{ marginTop: 8 }}>
            <button type="submit" disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload logo'}</button>
          </div>
        </form>
      </div>
    </>
  );
}
