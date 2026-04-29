import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useNavigate } from 'react-router-dom';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await login(username, password);
      nav('/changes');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={onSubmit}>
        <h1>Sign in to cambiar</h1>
        <label>Username</label>
        <input value={username} onChange={e => setU(e.target.value)} autoFocus required />
        <label>Password</label>
        <input type="password" value={password} onChange={e => setP(e.target.value)} required />
        {err && <div className="error">{err}</div>}
        <div style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}
