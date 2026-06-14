// AccessGate — the full-screen shared-access-code wall shown before the app when
// the deployment requires a code (BootstrapContext.needsAccessGate). The React port
// of rundan's AccessGate.razor. Verifies the code best-effort against
// GET /api/session/verify (with the X-Rundan-Access header, WITHOUT persisting
// first), then on success stores it via saveAccessCode() and reloads so the gate
// re-evaluates and the app mounts.
//
// Props: none — reads appName + saveAccessCode from useBootstrap().
import { useState } from 'react';
import { useBootstrap } from '../contexts/BootstrapContext';
import WelcomeHero from './WelcomeHero';

export default function AccessGate() {
  const { appName, saveAccessCode } = useBootstrap();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    // The field displays uppercase; normalize so codes are case-insensitive.
    const normalized = code.trim().toUpperCase();
    if (normalized.length === 0 || busy) return;

    setBusy(true);
    setError(null);
    try {
      // Verify with the candidate code in the header, without persisting it yet.
      let accepted = true;
      try {
        const res = await fetch('/api/session/verify', {
          headers: { 'X-Rundan-Access': normalized },
          credentials: 'include',
        });
        // Only treat an explicit rejection as a bad code; tolerate other outcomes
        // (endpoint missing/offline) and fall through to save + reload per contract.
        if (res.status === 401 || res.status === 403) accepted = false;
      } catch {
        /* network hiccup — accept and let later calls surface any real problem */
      }

      if (!accepted) {
        setError('Koden fungerade inte. Försök igen.');
        return;
      }

      saveAccessCode(normalized);
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') submit();
  }

  return (
    <>
      <WelcomeHero appName={appName} />

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Ange din åtkomstkod</h2>
        <p className="muted" style={{ margin: 0 }}>
          Skriv in koden som ditt gäng delade med dig för att komma igång med {appName}.
        </p>

        {error ? <div className="error-text">{error}</div> : null}

        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          placeholder="ÅTKOMSTKOD"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          autoFocus
          style={{ textTransform: 'uppercase', letterSpacing: '0.12em', textAlign: 'center', fontWeight: 700 }}
        />

        <button type="button" className="btn block" onClick={submit} disabled={busy}>
          {busy ? 'Kontrollerar…' : 'Fortsätt'}
        </button>
      </div>
    </>
  );
}
