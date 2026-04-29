import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { useBranding } from './branding.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import ChangeList from './pages/ChangeList.jsx';
import ChangeDetail from './pages/ChangeDetail.jsx';
import NewChange from './pages/NewChange.jsx';
import Users from './pages/Users.jsx';
import Groups from './pages/Groups.jsx';
import ChangeTypesAdmin from './pages/ChangeTypesAdmin.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="login-wrap">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Single Routes block keeps ChangePassword mounted across the mustChangePassword
  // transition so its post-submit redirect logic (in useEffect) can fire.
  return (
    <>
      {!user.mustChangePassword && <TopBar />}
      <main>
        <Routes>
          <Route path="/login" element={<Navigate to="/changes" replace />} />
          <Route path="/change-password" element={<ChangePassword forced={user.mustChangePassword} />} />
          <Route path="/" element={<Protected><Navigate to="/changes" replace /></Protected>} />
          <Route path="/changes" element={<Protected><ChangeList /></Protected>} />
          <Route path="/changes/new" element={<Protected><NewChange /></Protected>} />
          <Route path="/changes/:id" element={<Protected><ChangeDetail /></Protected>} />
          <Route path="/admin/users" element={<Protected admin><Users /></Protected>} />
          <Route path="/admin/groups" element={<Protected admin><Groups /></Protected>} />
          <Route path="/admin/change-types" element={<Protected admin><ChangeTypesAdmin /></Protected>} />
          <Route path="/admin/settings" element={<Protected admin><Settings /></Protected>} />
          <Route path="*" element={<Navigate to="/changes" replace />} />
        </Routes>
      </main>
    </>
  );
}

function Protected({ children, admin }) {
  const { user } = useAuth();
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/changes" replace />;
  return children;
}

function TopBar() {
  const { user, logout } = useAuth();
  const { appName, logoUrl } = useBranding();
  const nav = useNavigate();
  return (
    <header className="topbar">
      <div className="brand">
        {logoUrl
          ? <img src={logoUrl} alt={appName} className="brand-logo" />
          : <span className="brand-text">{appName}</span>}
      </div>
      <nav>
        <NavLink to="/changes" className={({ isActive }) => isActive ? 'active' : ''}>Changes</NavLink>
        <NavLink to="/changes/new" className={({ isActive }) => isActive ? 'active' : ''}>New</NavLink>
        {user.role === 'admin' && (
          <>
            <NavLink to="/admin/users" className={({ isActive }) => isActive ? 'active' : ''}>Users</NavLink>
            <NavLink to="/admin/groups" className={({ isActive }) => isActive ? 'active' : ''}>Groups</NavLink>
            <NavLink to="/admin/change-types" className={({ isActive }) => isActive ? 'active' : ''}>Change Types</NavLink>
            <NavLink to="/admin/settings" className={({ isActive }) => isActive ? 'active' : ''}>Settings</NavLink>
          </>
        )}
      </nav>
      <div className="user">
        <span>{user.displayName || user.username}{user.role !== 'submitter' && ` · ${user.role}`}</span>
        <button className="secondary" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
      </div>
    </header>
  );
}
