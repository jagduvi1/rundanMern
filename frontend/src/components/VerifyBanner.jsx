// Shown on every page when a logged-in host account hasn't verified its email
// yet. Offers a one-click resend of the verification mail. Dismissable for the
// session. Anonymous players (no `user`) and verified accounts see nothing.
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiPost } from '../api/client';

export default function VerifyBanner() {
  const { user } = useAuth();
  const [state, setState] = useState('idle'); // idle | sending | sent | error
  const [dismissed, setDismissed] = useState(false);

  if (!user || user.emailVerified || dismissed) return null;

  const resend = async () => {
    setState('sending');
    try {
      await apiPost('/auth/resend-verification', {});
      setState('sent');
    } catch {
      setState('error');
    }
  };

  const msg = state === 'sent'
    ? 'Ett nytt verifieringsmejl är skickat — kolla din inkorg (och skräpposten).'
    : state === 'error'
      ? 'Kunde inte skicka mejlet just nu. Försök igen om en stund.'
      : 'Ditt konto är inte verifierat. Bekräfta din e-postadress via länken i mejlet.';

  return (
    <div role="status" style={bar}>
      <span style={{ flex: 1, minWidth: 0 }}>⚠️ {msg}</span>
      {state !== 'sent' ? (
        <button
          type="button"
          className="btn sm"
          onClick={resend}
          disabled={state === 'sending'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {state === 'sending' ? 'Skickar…' : 'Skicka nytt mejl'}
        </button>
      ) : null}
      <button type="button" onClick={() => setDismissed(true)} aria-label="Stäng" style={closeBtn}>×</button>
    </div>
  );
}

const bar = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  background: '#a16207', // amber-700
  color: '#fffbeb',
  padding: '.55rem .9rem',
  fontSize: '.9rem',
  borderBottom: '1px solid rgba(0,0,0,.25)',
};
const closeBtn = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: '1.25rem',
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 .25rem',
};
