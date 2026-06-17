// Invite landing — "/invite/:token". Shows the event context, then either:
//   • already logged in as the invited email  → auto-joins, redirects to /e/:id
//   • logged in as someone else                → asks you to log out
//   • not logged in, email has an account       → log in (then auto-joins)
//   • not logged in, no account                 → register (joins on success)
// The invite is locked to the email it was sent to (enforced server-side too).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiGet, apiPost } from '../api/client';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import Spinner from '../components/Spinner';

function Card({ children }) {
  return <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>{children}</div>;
}

export default function InviteAccept() {
  useDocumentTitle('Inbjudan · GameDo');
  const { token } = useParams();
  const navigate = useNavigate();
  const { user, login, register, logout } = useAuth();

  const [ctx, setCtx] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [freshName, setFreshName] = useState(''); // name an already-logged-in invitee picks

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await apiGet(`/invites/${token}`);
        if (alive) {
          setCtx(data);
          // Prefill the display name with any name the host suggested for this invite.
          setForm((f) => ({ ...f, displayName: f.displayName || data.suggestedName || '' }));
        }
      } catch (e) {
        if (alive) setLoadErr(e?.message || 'Inbjudan är ogiltig eller har gått ut.');
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const sameEmail = user && ctx && (user.email || '').toLowerCase() === ctx.email.toLowerCase();
  // An invitee who's logged in but isn't tied to an existing roster person (no
  // designation, no account↔roster link yet) gets a FRESH roster identity — so let
  // them choose the name they'll appear as instead of silently using their handle.
  const willCreateFreshIdentity = !!(sameEmail && ctx && !ctx.designatedName && user && !user.userId);

  // Seed the name picker with the account's display name or the host's suggestion.
  useEffect(() => {
    if (willCreateFreshIdentity) {
      setFreshName((n) => n || user?.displayName || ctx?.suggestedName || '');
    }
  }, [willCreateFreshIdentity, user, ctx]);

  // Auto-accept once we're logged in as the invited email — unless we still need a
  // name (the fresh-identity case shows a name picker instead).
  useEffect(() => {
    if (!sameEmail || willCreateFreshIdentity) return undefined;
    let alive = true;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await apiPost(`/invites/${token}/accept`, {});
        if (alive) navigate(`/e/${res.eventId}`, { replace: true });
      } catch (e) {
        if (alive) { setError(e?.message || 'Kunde inte gå med i evenemanget.'); setBusy(false); }
      }
    })();
    return () => { alive = false; };
  }, [sameEmail, willCreateFreshIdentity, token, navigate]);

  // Join with the name the (already logged-in) invitee chose.
  const doJoinWithName = async (e) => {
    e.preventDefault();
    if (busy || !freshName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost(`/invites/${token}/accept`, { name: freshName.trim() });
      navigate(`/e/${res.eventId}`, { replace: true });
    } catch (err) {
      setError(err?.message || 'Kunde inte gå med i evenemanget.');
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const doLogin = async (e) => {
    e.preventDefault();
    if (busy || !form.password) return;
    setBusy(true);
    setError(null);
    const res = await login(ctx.email, form.password); // login accepts email
    if (!res.success) { setError(res.error || 'Inloggning misslyckades.'); setBusy(false); }
    // on success the sameEmail effect auto-accepts + redirects
  };

  const doRegister = async (e) => {
    e.preventDefault();
    if (busy || !form.username.trim() || !form.password) return;
    setBusy(true);
    setError(null);
    const res = await register(
      form.username.trim(), ctx.email, form.password,
      form.displayName.trim() || form.username.trim(), token,
    );
    if (!res.success) { setError(res.error || 'Registrering misslyckades.'); setBusy(false); return; }
    navigate(`/e/${res.eventId || ctx.eventId}`, { replace: true });
  };

  if (loadErr) {
    return (
      <Card>
        <h1>Inbjudan</h1>
        <p className="error-text">{loadErr}</p>
        <Link className="btn block" to="/">Till startsidan</Link>
      </Card>
    );
  }
  if (!ctx) return <Card><div className="center"><Spinner /></div></Card>;

  if (user && !sameEmail) {
    return (
      <Card>
        <h1>Inbjudan till {ctx.eventName}</h1>
        <p className="muted">
          Den här inbjudan är till <b>{ctx.email}</b>, men du är inloggad som <b>{user.email}</b>.
        </p>
        <button type="button" className="btn block" onClick={() => logout()}>Logga ut</button>
      </Card>
    );
  }

  if (sameEmail) {
    // Fresh identity: let the invitee pick the name others will see before joining.
    if (willCreateFreshIdentity) {
      return (
        <Card>
          <h1>Gå med i {ctx.eventName}</h1>
          <p className="muted">Vilket namn ska de andra spelarna se?</p>
          <form className="stack" onSubmit={doJoinWithName}>
            <div className="field">
              <label htmlFor="ia-fresh">Ditt namn</label>
              <input
                id="ia-fresh" type="text" autoFocus maxLength={60}
                autoComplete="name" placeholder="Ditt namn"
                value={freshName} onChange={(e) => setFreshName(e.target.value)}
              />
            </div>
            {error ? <p className="error-text">{error}</p> : null}
            <button type="submit" className="btn block" disabled={busy || !freshName.trim()}>
              {busy ? <Spinner /> : 'Gå med'}
            </button>
          </form>
        </Card>
      );
    }
    return (
      <Card>
        <h1>Går med i {ctx.eventName}…</h1>
        {error ? <p className="error-text">{error}</p> : <div className="center"><Spinner /></div>}
      </Card>
    );
  }

  // Not logged in.
  return (
    <Card>
      <h1>Du är inbjuden!</h1>
      <p className="muted">
        {ctx.invitedByName ? `${ctx.invitedByName} har bjudit in dig` : 'Du har blivit inbjuden'} till{' '}
        <b>{ctx.eventName}</b>
        {ctx.designatedName ? <> som <b>{ctx.designatedName}</b></> : null}.
      </p>
      {ctx.hasAccount ? (
        <form className="stack" onSubmit={doLogin}>
          <p className="muted small" style={{ margin: 0 }}>Du har redan ett konto — logga in för att gå med.</p>
          <div className="field"><label htmlFor="ia-email">E-post</label><input id="ia-email" type="email" value={ctx.email} disabled /></div>
          <div className="field">
            <label htmlFor="ia-pass">Lösenord</label>
            <input id="ia-pass" type="password" autoComplete="current-password" value={form.password} onChange={set('password')} required />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="btn block" disabled={busy || !form.password}>
            {busy ? <Spinner /> : 'Logga in och gå med'}
          </button>
          <p className="muted small center" style={{ margin: 0 }}><Link to="/forgot-password">Glömt lösenord?</Link></p>
        </form>
      ) : (
        <form className="stack" onSubmit={doRegister}>
          <p className="muted small" style={{ margin: 0 }}>Skapa ett konto för att gå med.</p>
          <div className="field"><label htmlFor="ia-email2">E-post</label><input id="ia-email2" type="email" value={ctx.email} disabled /></div>
          <div className="field">
            <label htmlFor="ia-user">Användarnamn</label>
            <input id="ia-user" type="text" autoComplete="username" value={form.username} onChange={set('username')} required />
          </div>
          <div className="field">
            <label htmlFor="ia-name">{ctx.designatedName ? 'Visningsnamn' : 'Ditt namn (visas i spelet)'}</label>
            <input
              id="ia-name" type="text" autoComplete="name"
              value={form.displayName} onChange={set('displayName')}
              placeholder={ctx.designatedName ? '(valfritt)' : 'Ditt namn'}
            />
          </div>
          <div className="field">
            <label htmlFor="ia-pass2">Lösenord</label>
            <input id="ia-pass2" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={10} />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="btn block" disabled={busy || !form.username.trim() || !form.password}>
            {busy ? <Spinner /> : 'Skapa konto och gå med'}
          </button>
        </form>
      )}
    </Card>
  );
}
