import { useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Navigate } from 'react-router-dom';

export default function ChangePassword({ forced = false }) {
  const { user, refresh } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);

  // Capture whether we entered in forced mode — the prop flips to false the
  // moment refresh() updates user state, so we hold on to the original.
  const wasForcedRef = useRef(forced);

  // Render-time redirect: as soon as user state catches up to "no longer
  // required", bounce out of the forced flow.
  if (wasForcedRef.current && ok && user && !user.mustChangePassword) {
    return <Navigate to="/changes" replace />;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setErr(null); setOk(false);
    if (next !== confirm) { setErr('Passwords do not match'); return; }
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      await refresh();
      setOk(true);
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={onSubmit}>
        <h1>{forced ? 'Set a new password' : 'Change password'}</h1>
        {forced && <div className="banner">You must change your password before continuing.</div>}
        <label>Current password</label>
        <input type="password" value={current} onChange={e => setCurrent(e.target.value)} required />
        <label>New password</label>
        <input type="password" value={next} onChange={e => setNext(e.target.value)} required />
        <label>Confirm new password</label>
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        {err && <div className="error">{err}</div>}
        {ok && <div style={{ color: 'var(--success)', marginTop: 8 }}>Password updated.</div>}
        <div style={{ marginTop: 16 }}>
          <button type="submit">Update password</button>
        </div>
      </form>
    </div>
  );
}
