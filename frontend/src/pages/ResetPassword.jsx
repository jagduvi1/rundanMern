// Password-reset landing — "/reset-password?token=…". The backend's reset mail
// points here; we take a new password and POST {token, password} to
// /api/auth/reset-password, then send the host to log in with it.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiPost } from '../api/client';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function ResetPassword() {
  useDocumentTitle('Återställ lösenord · Gamedo');
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err?.message || 'Kunde inte återställa lösenordet. Länken kan ha gått ut.');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="card stack center" style={{ maxWidth: 420, margin: '2rem auto' }}>
        <h1 style={{ margin: 0 }}>Ogiltig länk</h1>
        <p className="error" style={{ margin: 0 }}>Länken saknar en token.</p>
        <Link className="btn block" to="/login">Till inloggning</Link>
      </div>
    );
  }
  if (done) {
    return (
      <div className="card stack center" style={{ maxWidth: 420, margin: '2rem auto' }}>
        <h1 style={{ margin: 0 }}>Lösenordet är uppdaterat ✓</h1>
        <p className="muted">Logga in med ditt nya lösenord.</p>
        <Link className="btn block success" to="/login">Till inloggning</Link>
      </div>
    );
  }
  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '2rem auto' }}>
      <h1 style={{ margin: 0 }}>Välj ett nytt lösenord</h1>
      <p className="muted" style={{ marginTop: '-.4rem' }}>
        Minst 10 tecken med stor och liten bokstav samt en siffra.
      </p>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="rp-pass">Nytt lösenord</label>
          <input
            id="rp-pass"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={10}
          />
        </div>
        {error ? <p className="error" style={{ margin: 0 }}>{error}</p> : null}
        <button className="btn block success" type="submit" disabled={busy || !password}>
          {busy ? 'Sparar…' : 'Spara nytt lösenord'}
        </button>
      </form>
    </div>
  );
}
