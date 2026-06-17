// Maintenance — "/admin/maintenance" — super-admin site maintenance. Safe tools
// (reset question-library usage, seed demo data) plus a guarded danger zone:
// clean-and-seed wipes ALL domain data and is gated behind the server SEED_CODE,
// a typed confirmation phrase, AND a final dialog. The server re-checks the code.
// The route is requireAdmin; the page also self-gates (defense in depth).
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import AdminNav from '../components/AdminNav';
import ConfirmDialog from '../components/ConfirmDialog';
import Spinner from '../components/Spinner';
import { resetLibraryUsage, seedDemo, cleanAndSeed } from '../api/maintenance';

// The exact phrase a super-admin must type before the destructive wipe is enabled.
const CONFIRM_PHRASE = 'RADERA ALLT';

export default function Maintenance() {
  useDocumentTitle('Underhåll · Gamedo');
  const { isAdmin } = useAuth();
  const [busy, setBusy] = useState(null); // 'usage' | 'seed' | 'wipe' | null
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  // Danger zone.
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);

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
  const doWipe = async () => {
    setConfirmWipe(false);
    await run('wipe', () => cleanAndSeed(code.trim()), () => 'Allt domändata raderat och demodata återskapad.');
    setCode('');
    setPhrase('');
  };

  const wipeReady = code.trim().length > 0 && phrase.trim() === CONFIRM_PHRASE;

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

      <div className="card stack" style={{ borderColor: 'var(--danger)' }}>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--danger)' }}>⚠ Farlig zon</summary>
          <div className="stack" style={{ marginTop: '.6rem' }}>
            <b>Rensa och seeda om</b>
            <p className="muted small" style={{ margin: 0 }}>
              Raderar <b>allt</b> domändata permanent — alla evenemang, aktiviteter, spelare, poäng,
              chatt och uppladdade bilder — och återskapar demodatan. Konton och inställningar behålls.
              Detta går <b>inte</b> att ångra.
            </p>
            <div className="field">
              <label htmlFor="mt-code">Serverns SEED_CODE</label>
              <input id="mt-code" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Krävs" />
            </div>
            <div className="field">
              <label htmlFor="mt-phrase">Skriv <code>{CONFIRM_PHRASE}</code> för att bekräfta</label>
              <input id="mt-phrase" type="text" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={CONFIRM_PHRASE} />
            </div>
            <button
              type="button"
              className="btn danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setConfirmWipe(true)}
              disabled={busy != null || !wipeReady}
            >
              {busy === 'wipe' ? <Spinner /> : 'Rensa och seeda om'}
            </button>
          </div>
        </details>
      </div>

      <ConfirmDialog
        open={confirmWipe}
        title="Radera allt domändata?"
        message="Alla evenemang, aktiviteter, spelare, poäng, chatt och bilder raderas permanent. Detta går inte att ångra."
        confirmLabel="Radera allt"
        cancelLabel="Avbryt"
        danger
        onConfirm={doWipe}
        onCancel={() => setConfirmWipe(false)}
      />
    </>
  );
}
