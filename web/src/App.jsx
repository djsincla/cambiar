import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { useAuth } from './auth.jsx';
import { useBranding } from './branding.jsx';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import ChangeList from './pages/ChangeList.jsx';
import ChangeDetail from './pages/ChangeDetail.jsx';
import NewChange from './pages/NewChange.jsx';
import Users from './pages/Users.jsx';
import Groups from './pages/Groups.jsx';
import ChangeTypesAdmin from './pages/ChangeTypesAdmin.jsx';
import Settings from './pages/Settings.jsx';
import ReleaseNotes from './pages/ReleaseNotes.jsx';
import Upcoming from './pages/Upcoming.jsx';
import Digests from './pages/Digests.jsx';
import ChangeTemplates from './pages/ChangeTemplates.jsx';
import EmailIngestion from './pages/EmailIngestion.jsx';
import Recurring from './pages/Recurring.jsx';
import Alerts from './pages/Alerts.jsx';
import { useTheme } from './theme.jsx';

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
          <Route path="/upcoming" element={<Protected><Upcoming /></Protected>} />
          <Route path="/admin/users" element={<Protected admin><Users /></Protected>} />
          <Route path="/admin/groups" element={<Protected admin><Groups /></Protected>} />
          <Route path="/admin/change-types" element={<Protected admin><ChangeTypesAdmin /></Protected>} />
          <Route path="/admin/settings" element={<Protected admin><Settings /></Protected>} />
          <Route path="/admin/digests" element={<Protected admin><Digests /></Protected>} />
          <Route path="/admin/email" element={<Protected admin><EmailIngestion /></Protected>} />
          <Route path="/admin/alerts" element={<Protected admin><Alerts /></Protected>} />
          <Route path="/templates" element={<Protected><ChangeTemplates /></Protected>} />
          <Route path="/recurring" element={<Protected><Recurring /></Protected>} />
          <Route path="/release-notes" element={<Protected><ReleaseNotes /></Protected>} />
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
  const { appName, logoUrl, version } = useBranding();
  const { theme, toggle: toggleTheme } = useTheme();
  const nav = useNavigate();

  // Poll every 60s for "awaiting my approval" count. Refetch on every mount
  // (the default staleTime: 0) so a fresh login picks up the right count
  // immediately rather than seeing the previous user's cached result.
  // Key includes user.id so different users get separate caches.
  const { data: awaiting } = useQuery({
    queryKey: ['awaiting-my-approval', user.id],
    queryFn: () => api.get('/api/changes?awaitingMyApproval=true'),
    refetchInterval: 60_000,
  });
  const awaitingCount = awaiting?.changes?.length ?? 0;

  // Active-alert count for the topbar (admin-visible button). Same poll
  // cadence as approvals.
  const { data: alertsCount } = useQuery({
    queryKey: ['alerts-count', user.id],
    queryFn: () => api.get('/api/alerts/count'),
    refetchInterval: 60_000,
    enabled: user.role === 'admin',
  });
  const activeAlerts = alertsCount?.active ?? 0;

  return (
    <header className="topbar">
      <div className="brand">
        {logoUrl
          ? <img src={logoUrl} alt={appName} className="brand-logo" />
          : <span className="brand-text">{appName}</span>}
      </div>
      <nav>
        <NavLink to="/changes" end className={({ isActive }) => isActive ? 'active' : ''}>Changes</NavLink>
        <NavLink to="/changes?awaiting=true" className="approvals-link">
          Approvals
          {awaitingCount > 0 && <span className="nav-badge" data-testid="awaiting-badge">{awaitingCount}</span>}
        </NavLink>
        <NavLink to="/upcoming" className={({ isActive }) => isActive ? 'active' : ''}>Upcoming</NavLink>
        <NavLink to="/templates" className={({ isActive }) => isActive ? 'active' : ''}>Templates</NavLink>
        <NavLink to="/recurring" className={({ isActive }) => isActive ? 'active' : ''}>Recurring</NavLink>
        <NavLink to="/changes/new" className={({ isActive }) => isActive ? 'active' : ''}>New</NavLink>
        {user.role === 'admin' && (
          <>
            {/* Alerts stays top-level so the badge nags ops without a click. */}
            <NavLink to="/admin/alerts" className="alerts-link">
              Alerts
              {activeAlerts > 0 && <span className="nav-badge" data-testid="alerts-badge">{activeAlerts}</span>}
            </NavLink>
            <AdminMenu />
          </>
        )}
      </nav>
      <div className="user">
        <button
          className="icon-button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          data-testid="theme-toggle"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <span>{user.displayName || user.username}{user.role !== 'submitter' && ` · ${user.role}`}</span>
        <NavLink to="/release-notes" className="version-link" data-testid="version-link" title="Release notes">
          v{version}
        </NavLink>
        <button className="secondary" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
      </div>
    </header>
  );
}

const ADMIN_LINKS = [
  { to: '/admin/users',        label: 'Users' },
  { to: '/admin/groups',       label: 'Groups' },
  { to: '/admin/change-types', label: 'Change types' },
  { to: '/admin/digests',      label: 'Digests' },
  { to: '/admin/email',        label: 'Email rules' },
  { to: '/admin/settings',     label: 'Settings' },
];

function AdminMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const location = useLocation();
  const onAdminPage = ADMIN_LINKS.some(l => location.pathname.startsWith(l.to));

  // Close on outside click + ESC.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Close when navigating from inside the menu.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  return (
    <div className="admin-menu" ref={ref}>
      <button
        type="button"
        className={`admin-menu-toggle ${onAdminPage ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(s => !s)}
      >
        Admin <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="admin-menu-panel" role="menu">
          {ADMIN_LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => `admin-menu-item ${isActive ? 'active' : ''}`}
              role="menuitem"
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
