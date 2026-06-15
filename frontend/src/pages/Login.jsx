// Host/admin sign-in. On success, returns the host to where they were headed
// (ProtectedRoute stashes it in location.state.from) or the host dashboard.
import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import Spinner from '../components/Spinner';

export default function Login() {
  useDocumentTitle('Logga in · Rundan');
  const { login, requestMagicLink } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dest = location.state?.from || '/admin';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Passwordless: email a one-time login link (always acks, anti-enumeration).
  const [linkEmail, setLinkEmail] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

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

  const sendLink = async (e) => {
    e.preventDefault();
    if (linkBusy || !linkEmail.trim()) return;
    setLinkBusy(true);
    await requestMagicLink(linkEmail.trim());
    setLinkBusy(false);
    setLinkSent(true);
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
      <p className="muted small center" style={{ margin: 0 }}>
        <Link to="/forgot-password">Glömt lösenord?</Link>
      </p>
      <p className="muted small center">
        Inget konto? <Link to="/register">Skapa ett</Link>
      </p>

      <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14, gap: 8 }}>
        <b>Inget lösenord?</b>
        <p className="muted small" style={{ margin: 0 }}>Maila mig en inloggningslänk istället.</p>
        {linkSent ? (
          <p className="muted small" style={{ margin: 0 }}>
            Om det finns ett konto med den adressen är en inloggningslänk på väg. Kolla din mejl.
          </p>
        ) : (
          <form className="row" onSubmit={sendLink}>
            <input
              className="grow"
              type="email"
              autoComplete="email"
              placeholder="din@epost.se"
              value={linkEmail}
              onChange={(e) => setLinkEmail(e.target.value)}
            />
            <button type="submit" className="btn sm ghost" disabled={linkBusy || !linkEmail.trim()}>
              {linkBusy ? <Spinner /> : 'Maila länk'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
