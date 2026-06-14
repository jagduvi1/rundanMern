// Host-only route guard. Requires a logged-in account (useAuth().user) — the MERN
// port of rundan's admin gate, now backed by real host/admin accounts. While the
// initial token refresh is in flight we show a spinner rather than bouncing a
// returning host to /login. `requireAdmin` additionally demands the admin role.
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { LoadingPage } from './Spinner';

export default function ProtectedRoute({ children, requireAdmin = false }) {
  const { user, isAdmin, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingPage label="Kontrollerar inloggning…" />;

  if (!user) {
    // Remember where they were headed so Login can send them back.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (requireAdmin && !isAdmin) {
    return (
      <div className="card stack">
        <h1>Ingen behörighet</h1>
        <p className="muted">Det här området kräver ett administratörskonto.</p>
      </div>
    );
  }

  return children;
}
