// AdminNav — the top navigation inside the host/admin area. The React port of
// rundan's AdminNav.razor, adapted to the MERN auth model: instead of "Preview as
// player" (a device flag) the host nav exposes account logout (useAuth) and quick
// links. Tabs highlight the active section.
//
// Props:
//   active : string — "events", "people", "library", "accounts", or "maintenance"
//            (highlights that tab). Optional. The "accounts"/"maintenance" tabs are
//            super-admin only.
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AdminNav({ active = '' }) {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate('/');
  }

  return (
    <div className="card" style={{ padding: 10, marginBottom: 12 }}>
      <div className="row wrap">
        <Link className={`btn sm ${active === 'events' ? '' : 'ghost'}`} to="/admin">Evenemang</Link>
        <Link className={`btn sm ${active === 'people' ? '' : 'ghost'}`} to="/admin/users">Personer</Link>
        <Link className={`btn sm ${active === 'library' ? '' : 'ghost'}`} to="/library">Bibliotek</Link>
        {isAdmin ? (
          <>
            <Link className={`btn sm ${active === 'accounts' ? '' : 'ghost'}`} to="/admin/accounts">Konton</Link>
            <Link className={`btn sm ${active === 'maintenance' ? '' : 'ghost'}`} to="/admin/maintenance">Underhåll</Link>
          </>
        ) : null}
        <Link className="btn sm ghost" to="/events">Spelvyn</Link>
        <span className="grow" />
        {user ? <span className="muted small" style={{ alignSelf: 'center' }}>{user.displayName || user.username}</span> : null}
        <button type="button" className="btn sm ghost" onClick={onLogout}>Logga ut</button>
      </div>
    </div>
  );
}
