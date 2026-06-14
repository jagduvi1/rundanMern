// Magic-link landing — "/magic-link?token=…". Consumes a one-time login link
// (passwordless login or an event invite), then lands the player where the link
// pointed: into the event it was for, otherwise the events list. When the
// account still has no password we show a gentle nudge to secure it.
//
// The token is single-use, so we guard against React StrictMode's double-invoke
// of effects with a ran-ref — consuming twice would burn the link and fail.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getMe } from '../api/me';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function MagicLink() {
  useDocumentTitle('Loggar in · Rundan');
  const { consumeMagicLink } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');

  const ranRef = useRef(false);
  const [status, setStatus] = useState('working'); // 'working' | 'ok' | 'error'
  const [error, setError] = useState(null);
  const [needsPassword, setNeedsPassword] = useState(false);

  useEffect(() => {
    if (ranRef.current) return; // StrictMode double-invoke guard — the token is one-shot.
    ranRef.current = true;

    if (!token) {
      setStatus('error');
      setError('Länken saknar en token. Be om en ny inloggningslänk.');
      return;
    }

    (async () => {
      const res = await consumeMagicLink(token);
      if (!res.success) {
        setStatus('error');
        setError(res.error || 'Länken är ogiltig eller har gått ut.');
        return;
      }

      // Logged in. Decide whether to nudge the player to set a password before we
      // bounce them onward — but never block the redirect on this check.
      let hasPassword = true;
      try { hasPassword = (await getMe()).hasPassword; } catch { /* non-blocking */ }

      if (hasPassword) {
        navigate(res.eventId ? `/e/${res.eventId}` : '/events', { replace: true });
        return;
      }

      // Passwordless account — show the nudge here instead of redirecting away.
      setNeedsPassword(true);
      setStatus('ok');
      // Auto-continue after a short beat so the player isn't stuck on this page.
      const dest = res.eventId ? `/e/${res.eventId}` : '/events';
      const t = setTimeout(() => navigate(dest, { replace: true }), 6000);
      // eslint-disable-next-line consistent-return
      return () => clearTimeout(t);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'working') {
    return (
      <div className="card center stack" style={{ maxWidth: 420, margin: '0 auto' }}>
        <span className="spinner" role="status" aria-label="Loggar in" style={{ margin: '1rem auto' }} />
        <p className="muted">Loggar in…</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
        <h1>Länken funkade inte</h1>
        <p className="muted">{error}</p>
        <p className="muted small">Inloggningslänkar gäller en kort stund och kan bara användas en gång.</p>
        <Link className="btn block" to="/login">Till inloggning</Link>
        <p className="muted small center">
          Behöver du en ny? <Link to="/login">Maila mig en ny länk</Link>
        </p>
      </div>
    );
  }

  // status === 'ok' with the password nudge.
  return (
    <div className="card stack center" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Du är inloggad! 🎉</h1>
      {needsPassword ? (
        <>
          <p className="muted">
            Vill du behålla kontot? Sätt ett användarnamn och lösenord så kan du logga in när som helst.
          </p>
          <Link className="btn block" to="/profile">Säkra mitt konto</Link>
          <p className="muted small">Tar dig vidare automatiskt om en stund…</p>
        </>
      ) : (
        <p className="muted">Tar dig vidare…</p>
      )}
    </div>
  );
}
