// Forgot-password request — "/forgot-password". Posts the email to
// /api/auth/forgot-password, which mails a /reset-password link. The backend
// always acks the same way (anti-enumeration), so we show the ack on submit
// regardless of whether the address exists.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../api/client';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import Spinner from '../components/Spinner';

export default function ForgotPassword() {
  useDocumentTitle('Glömt lösenord · GameDo');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    try {
      await apiPost('/auth/forgot-password', { email: email.trim() });
    } catch {
      /* always ack — never reveal whether the account exists */
    }
    setBusy(false);
    setSent(true);
  };

  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Glömt lösenord</h1>
      {sent ? (
        <>
          <p className="muted">
            Om det finns ett konto med den adressen är en återställningslänk på väg. Kolla din mejl.
          </p>
          <Link className="btn block" to="/login">Till inloggning</Link>
        </>
      ) : (
        <>
          <p className="muted">
            Ange din e-postadress så mailar vi en länk för att välja ett nytt lösenord.
          </p>
          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label htmlFor="fp-email">E-post</label>
              <input
                id="fp-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn block" disabled={busy || !email.trim()}>
              {busy ? <Spinner /> : 'Maila återställningslänk'}
            </button>
          </form>
          <p className="muted small center" style={{ margin: 0 }}>
            <Link to="/login">Tillbaka till inloggning</Link>
          </p>
        </>
      )}
    </div>
  );
}
