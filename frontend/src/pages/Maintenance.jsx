// Maintenance — "/admin/maintenance" — super-admin site maintenance. SAFE tools
// only: reset question-library usage and seed demo data. The destructive
// clean-and-seed (full domain wipe) is intentionally NOT exposed in the UI — it
// stays an admin + SEED_CODE-gated server endpoint for emergency CLI use only.
// The route is requireAdmin; the page also self-gates (defense in depth).
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import AdminNav from '../components/AdminNav';
import Spinner from '../components/Spinner';
import { resetLibraryUsage, seedDemo } from '../api/maintenance';

export default function Maintenance() {
  useDocumentTitle('Underhåll · Gamedo');
  const { isAdmin } = useAuth();
  const [busy, setBusy] = useState(null); // 'usage' | 'seed' | null
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  if (!isAdmin) {
    return (
      <>
        <AdminNav />
        <div className="card"><h2>Underhåll</h2><p className="muted">Endast superadmin har åtkomst.</p></div>
      </>
    );
  }

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      const r = await fn();
      setMsg(okMsg(r));
    } catch (e) {
      setErr(e?.message || 'Åtgärden misslyckades.');
    } finally {
      setBusy(null);
    }
  };

  const doResetUsage = () => run(
    'usage', resetLibraryUsage,
    (r) => `Frågebibliotekets användning återställd (${r?.cleared ?? 0} rader rensade).`,
  );
  const doSeed = () => run(
    'seed', seedDemo,
    (r) => (r?.seeded ? 'Demodata skapad.' : 'Ingen demodata skapades — databasen är inte tom.'),
  );

  return (
    <>
      <AdminNav active="maintenance" />
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Underhåll</h2>
        <p className="muted small" style={{ marginTop: '-.4rem' }}>Superadminverktyg för hela servern.</p>
        {msg ? <p style={{ color: 'var(--ok)', margin: 0 }}>{msg}</p> : null}
        {err ? <p className="error-text" style={{ margin: 0 }}>{err}</p> : null}

        <div className="stack" style={{ gap: 6 }}>
          <b>Frågebibliotek</b>
          <p className="muted small" style={{ margin: 0 }}>
            Nollställ hur ofta bibliotekets frågor använts, så att hela biblioteket kan lottas igen.
          </p>
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={doResetUsage} disabled={busy != null}>
            {busy === 'usage' ? <Spinner /> : 'Återställ biblioteksanvändning'}
          </button>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <b>Demodata</b>
          <p className="muted small" style={{ margin: 0 }}>
            Skapa exempelevenemanget. Gör ingenting om det redan finns data.
          </p>
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={doSeed} disabled={busy != null}>
            {busy === 'seed' ? <Spinner /> : 'Skapa demodata'}
          </button>
        </div>
      </div>
    </>
  );
}
