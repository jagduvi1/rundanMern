// Email-verification landing — "/verify-email?token=…". The backend's "Confirm
// your email" mail points here; we POST the one-time token to
// /api/auth/verify-email and report the result. A ran-ref guards against React
// StrictMode's double-invoke (the token is single-use).
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiPost } from '../api/client';
import { useDocumentTitle } from '../utils/useDocumentTitle';

export default function VerifyEmail() {
  useDocumentTitle('Verifierar e-post · GameDo');
  const [params] = useSearchParams();
  const token = params.get('token');
  const ranRef = useRef(false);
  const [status, setStatus] = useState('working'); // 'working' | 'ok' | 'error'
  const [error, setError] = useState(null);

  useEffect(() => {
    if (ranRef.current) return; // single-use token — don't double-consume under StrictMode
    ranRef.current = true;
    if (!token) {
      setStatus('error');
      setError('Länken saknar en token. Begär en ny bekräftelselänk.');
      return;
    }
    (async () => {
      try {
        await apiPost('/auth/verify-email', { token });
        setStatus('ok');
      } catch (e) {
        setStatus('error');
        setError(e?.message || 'Länken är ogiltig eller har gått ut.');
      }
    })();
  }, [token]);

  return (
    <div className="card stack center" style={{ maxWidth: 460, margin: '2rem auto' }}>
      {status === 'working' ? (
        <>
          <h1 style={{ margin: 0 }}>Verifierar din e-post…</h1>
          <p className="muted">Ett ögonblick.</p>
        </>
      ) : status === 'ok' ? (
        <>
          <h1 style={{ margin: 0 }}>E-post bekräftad ✓</h1>
          <p className="muted">Tack! Din e-postadress är nu verifierad.</p>
          <Link className="btn block success" to="/admin">Till värdkontrollerna</Link>
        </>
      ) : (
        <>
          <h1 style={{ margin: 0 }}>Kunde inte bekräfta</h1>
          <p className="error" style={{ margin: 0 }}>{error}</p>
          <Link className="btn block" to="/">Till startsidan</Link>
        </>
      )}
    </div>
  );
}
