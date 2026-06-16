// Min profil — "/profile" (ProtectedRoute). The logged-in account's home:
//   • Stats   — cross-event totals + a per-event list with rank.
//   • Vänner  — your friends (with remove), your shareable friend code (copy +
//               QR), and an "add a friend by code" box.
//   • Säkra ditt konto — only when the account has no password yet (invited
//               players); set a username + password to keep the account.
//
// Each card loads independently and shows its own loading/empty/error state so a
// single failing call never blanks the whole page.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  getMe, getMyStats, getFriends, getFriendCode, rotateFriendCode, addFriendByCode, removeFriend,
  updateDisplayName,
} from '../api/me';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import { useToast } from '../components/Toast';
import QrShareModal from '../components/QrShareModal';
import Spinner from '../components/Spinner';

export default function Profile() {
  useDocumentTitle('Min profil · Rundan');
  const { user } = useAuth();
  const { toast, show } = useToast();

  // Whole-account profile (for the password gate + a friendly greeting).
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState(null);

  const loadMe = async () => {
    try { setMe(await getMe()); setMeError(null); }
    catch (e) { setMeError(e?.message || 'Kunde inte ladda profilen.'); }
  };

  useEffect(() => { loadMe(); }, []);

  return (
    <>
      {toast}
      <div className="stack" style={{ maxWidth: 560, margin: '0 auto' }}>
        <div className="card stack">
          <h1 style={{ margin: 0 }}>Min profil</h1>
          <p className="muted" style={{ margin: 0 }}>
            Inloggad som <b>{me?.playerName || user?.displayName || user?.username}</b>.
          </p>
          {meError ? <p className="error-text">{meError}</p> : null}
        </div>

        <DisplayNameCard
          currentName={me?.user?.displayName || ''}
          onSaved={async (name) => { show('Visningsnamn uppdaterat!'); await loadMe(); }}
          onError={show}
        />

        {/* Secure your account — invited players who haven't set a password yet. */}
        {me && !me.hasPassword ? (
          <SecureAccountCard
            currentUsername={user?.username}
            onSecured={async () => { show('Konto säkrat!'); await loadMe(); }}
            onError={show}
          />
        ) : null}

        <StatsCard onError={show} />
        <FriendsCard onError={show} />
      </div>
    </>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────────────
function StatsCard({ onError }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getMyStats();
        if (!cancelled) setStats(s);
      } catch (e) {
        if (!cancelled) { setError(e?.message || 'Kunde inte ladda statistiken.'); onError?.(e?.message); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Statistik</h2>
      {loading ? (
        <div className="center muted"><span className="spinner" style={{ margin: '.5rem auto' }} /></div>
      ) : error ? (
        <p className="error-text">{error}</p>
      ) : !stats || !stats.linked ? (
        <p className="muted">Ingen statistik ännu — spela ett evenemang så dyker dina poäng upp här.</p>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 16 }}>
            <Stat label="Poäng totalt" value={stats.totalPoints} />
            <Stat label="Evenemang" value={stats.eventsPlayed} />
            <Stat label="Vinster" value={stats.wins} />
          </div>
          {(stats.events || []).length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>Inga avslutade evenemang ännu.</p>
          ) : (
            <table className="board">
              <thead>
                <tr><th>Evenemang</th><th style={{ textAlign: 'center' }}>Placering</th><th style={{ textAlign: 'right' }}>Poäng</th></tr>
              </thead>
              <tbody>
                {stats.events.map((e) => (
                  <tr key={e.eventId}>
                    <td>
                      <Link to={`/e/${e.eventId}`}><b>{e.eventName}</b></Link>
                      <div className="muted small">{e.activitiesPlayed} aktiviteter</div>
                    </td>
                    <td className="rank" style={{ textAlign: 'center' }}>{e.rank}</td>
                    <td className="pts">{e.totalPoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="center" style={{ minWidth: 84 }}>
      <div style={{ fontSize: '1.6rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

// ── Display name ──────────────────────────────────────────────────────────────
function DisplayNameCard({ currentName, onSaved, onError }) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setName(currentName); }, [currentName]);

  const save = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateDisplayName(trimmed);
      onSaved?.(trimmed);
    } catch (err) {
      setError(err?.message || 'Kunde inte spara visningsnamnet.');
      onError?.(err?.message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = name.trim() !== currentName;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Visningsnamn</h2>
      <p className="muted small" style={{ margin: 0 }}>Det här namnet visas för andra spelare och värdar.</p>
      <form className="stack" onSubmit={save}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="Ditt visningsnamn"
        />
        {error ? <p className="error-text" style={{ margin: 0 }}>{error}</p> : null}
        <button type="submit" className="btn block success" disabled={busy || !name.trim() || !dirty}>
          {busy ? <Spinner /> : 'Spara'}
        </button>
      </form>
    </div>
  );
}

// ── Friends ────────────────────────────────────────────────────────────────────
function FriendsCard({ onError }) {
  const [friends, setFriends] = useState(null);
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null);
  const [codeError, setCodeError] = useState(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  const rotateCode = async () => {
    // eslint-disable-next-line no-alert
    if (rotating || !window.confirm('Generera en ny vänkod? Den gamla slutar fungera direkt.')) return;
    setRotating(true);
    try { const r = await rotateFriendCode(); setCode(r.code); }
    catch (e) { setCodeError(e?.message || 'Kunde inte byta kod.'); }
    finally { setRotating(false); }
  };

  const [addCode, setAddCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addOk, setAddOk] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const loadFriends = async () => {
    try { setFriends(await getFriends()); setError(null); }
    catch (e) { setError(e?.message || 'Kunde inte ladda vänner.'); onError?.(e?.message); }
  };

  useEffect(() => {
    loadFriends();
    getFriendCode()
      .then((r) => setCode(r.code))
      .catch((e) => setCodeError(e?.message || 'Kunde inte hämta din vänkod.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyCode = async () => {
    if (!code) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* code is visible to copy manually */ }
  };

  const add = async () => {
    const c = addCode.trim();
    if (!c || adding) return;
    setAdding(true);
    setAddError(null);
    setAddOk(null);
    try {
      const res = await addFriendByCode(c);
      setAddCode('');
      setAddOk(`${res.friend.name} tillagd!`);
      await loadFriends();
    } catch (e) {
      setAddError(e?.message || 'Kunde inte lägga till vännen.');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id) => {
    setRemovingId(id);
    try {
      await removeFriend(id);
      setFriends((list) => (list || []).filter((f) => f.id !== id));
    } catch (e) {
      onError?.(e?.message || 'Kunde inte ta bort vännen.');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Vänner</h2>

      {/* Your friend code */}
      <div className="stack" style={{ gap: 8 }}>
        <p className="muted small" style={{ margin: 0 }}>
          Dela din vänkod så kan andra lägga till dig. Värdar kan sedan bjuda in dig till evenemang med ett tryck.
        </p>
        {codeError ? <p className="error-text">{codeError}</p> : null}
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="pill accent" style={{ fontWeight: 800, letterSpacing: '0.12em', fontSize: '1.05rem' }}>
            {code || '······'}
          </span>
          <button type="button" className="btn sm soft" onClick={copyCode} disabled={!code}>
            {copied ? 'Kopierad!' : 'Kopiera kod'}
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setQrOpen(true)} disabled={!code}>
            Visa QR
          </button>
          <button type="button" className="btn sm ghost" onClick={rotateCode} disabled={!code || rotating} title="Byt till en ny kod om den gamla läckt">
            {rotating ? '…' : 'Ny kod'}
          </button>
        </div>
      </div>

      {/* Add a friend by code */}
      <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <b>Lägg till en vän</b>
        {addError ? <p className="error-text" style={{ margin: 0 }}>{addError}</p> : null}
        {addOk ? <p className="muted small" style={{ margin: 0, color: 'var(--ok)' }}>{addOk}</p> : null}
        <div className="row">
          <input
            className="grow"
            type="text"
            placeholder="Vänkod"
            maxLength={16}
            value={addCode}
            onChange={(e) => setAddCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}
          />
          <button type="button" className="btn sm" onClick={add} disabled={adding || !addCode.trim()}>
            {adding ? <Spinner /> : 'Lägg till'}
          </button>
        </div>
      </div>

      {/* Friends list */}
      <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        {error ? (
          <p className="error-text">{error}</p>
        ) : friends == null ? (
          <div className="center muted"><span className="spinner" style={{ margin: '.5rem auto' }} /></div>
        ) : friends.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Du har inga vänner ännu — lägg till någon med deras kod ovan.</p>
        ) : (
          friends.map((f) => (
            <div key={f.id} className="row">
              <span className="grow"><b>{f.name}</b></span>
              <button
                type="button"
                className="btn sm ghost danger"
                onClick={() => remove(f.id)}
                disabled={removingId === f.id}
              >
                {removingId === f.id ? '…' : 'Ta bort'}
              </button>
            </div>
          ))
        )}
      </div>

      <QrShareModal open={qrOpen} url={code || ''} title="Min vänkod" onClose={() => setQrOpen(false)} />
    </div>
  );
}

// ── Secure account (set a password) ─────────────────────────────────────────────
function SecureAccountCard({ currentUsername, onSecured, onError }) {
  const { setPassword } = useAuth();
  const [username, setUsername] = useState(currentUsername || '');
  const [password, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    const res = await setPassword(password, username.trim() || undefined);
    setBusy(false);
    if (res.success) {
      setPwd('');
      onSecured?.();
    } else {
      setError(res.error || 'Kunde inte spara lösenordet.');
      onError?.(res.error);
    }
  };

  return (
    <div className="card stack" style={{ borderColor: 'var(--accent)' }}>
      <h2 style={{ margin: 0 }}>Säkra ditt konto</h2>
      <p className="muted" style={{ margin: 0 }}>
        Du loggade in via en länk. Sätt ett användarnamn och lösenord så kan du logga in när som helst.
      </p>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="secure-username">Användarnamn</label>
          <input
            id="secure-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="secure-password">Lösenord</label>
          <input
            id="secure-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPwd(e.target.value)}
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button type="submit" className="btn block success" disabled={busy || !password}>
          {busy ? <Spinner /> : 'Säkra kontot'}
        </button>
      </form>
    </div>
  );
}
