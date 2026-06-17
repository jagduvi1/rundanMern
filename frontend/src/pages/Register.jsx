// Host/admin account registration. On success the account is logged in and sent
// to the host dashboard.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import Spinner from '../components/Spinner';

export default function Register() {
  useDocumentTitle('Skapa konto · Gamedo');
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ username: '', email: '', password: '', displayName: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await register(
      form.username.trim(),
      form.email.trim(),
      form.password,
      form.displayName.trim() || form.username.trim(),
    );
    setBusy(false);
    if (res.success) navigate('/admin', { replace: true });
    else setError(res.error || 'Registrering misslyckades.');
  };

  const ready = form.username.trim() && form.email.trim() && form.password;

  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Skapa konto</h1>
      <p className="muted">Ett värdkonto låter dig skapa evenemang och aktiviteter.</p>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="reg-username">Användarnamn</label>
          <input id="reg-username" type="text" autoComplete="username" value={form.username} onChange={set('username')} required />
        </div>
        <div className="field">
          <label htmlFor="reg-name">Visningsnamn</label>
          <input id="reg-name" type="text" autoComplete="name" value={form.displayName} onChange={set('displayName')} placeholder="(valfritt)" />
        </div>
        <div className="field">
          <label htmlFor="reg-email">E-post</label>
          <input id="reg-email" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
        </div>
        <div className="field">
          <label htmlFor="reg-password">Lösenord</label>
          <input id="reg-password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button type="submit" className="btn block" disabled={busy || !ready}>
          {busy ? <Spinner /> : 'Skapa konto'}
        </button>
      </form>
      <p className="muted small center">
        Har du redan ett konto? <Link to="/login">Logga in</Link>
      </p>
    </div>
  );
}
