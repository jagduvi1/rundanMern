// Host/admin sign-in. On success, returns the host to where they were headed
// (ProtectedRoute stashes it in location.state.from) or the host dashboard.
import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import Spinner from '../components/Spinner';

export default function Login() {
  useDocumentTitle('Logga in · Rundan');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dest = location.state?.from || '/admin';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await login(username.trim(), password);
    setBusy(false);
    if (res.success) navigate(dest, { replace: true });
    else setError(res.error || 'Inloggning misslyckades.');
  };

  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Logga in</h1>
      <p className="muted">Logga in för att skapa och hantera evenemang.</p>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="login-username">Användarnamn</label>
          <input
            id="login-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Lösenord</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button type="submit" className="btn block" disabled={busy || !username.trim() || !password}>
          {busy ? <Spinner /> : 'Logga in'}
        </button>
      </form>
      <p className="muted small center">
        Inget konto? <Link to="/register">Skapa ett</Link>
      </p>
    </div>
  );
}
