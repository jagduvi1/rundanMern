// AppMenu — the global slide-in menu sheet (the React port of rundan's
// AppMenu.razor). "Got a code?" jumps straight into an event OR an activity (tries
// /events/by-code then /activities/by-code), plus quick nav and host login/logout.
// Rendered via a portal to <body> so the fixed backdrop/sheet paint above the
// frosted header's stacking context. Closes on backdrop click or Escape; focus
// moves into the sheet on open.
//
// Props:
//   open    : bool — whether the sheet is shown.
//   onClose : () => void — close handler (Layout owns the open state).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useBootstrap } from '../contexts/BootstrapContext';
import { getEventByCode } from '../api/events';
import { getActivityByCode } from '../api/activities';
import { ApiError } from '../api/client';

export default function AppMenu({ open, onClose }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { appName } = useBootstrap();
  const sheetRef = useRef(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Move focus into the sheet on open; reset the field when it closes.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => { try { sheetRef.current?.focus(); } catch { /* gone */ } }, 0);
      return () => clearTimeout(t);
    }
    setCode('');
    setError(null);
    return undefined;
  }, [open]);

  // Escape closes (bound only while open).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function go() {
    const normalized = code.trim().toUpperCase();
    if (normalized.length === 0) {
      setError('Skriv en kod först.');
      return;
    }
    setBusy(true);
    setError(null);

    // A code can be an event (a whole day) or a single activity — try event first.
    const tryByCode = async (fn) => {
      try {
        return await fn(normalized);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    };

    try {
      const ev = await tryByCode(getEventByCode);
      if (ev) {
        onClose?.();
        navigate(`/e/${ev.id}`);
        return;
      }
      const activity = await tryByCode(getActivityByCode);
      if (activity) {
        onClose?.();
        navigate(`/a/${activity.id}`);
        return;
      }
      setError('Inget evenemang eller aktivitet med den koden.');
    } catch (e) {
      setError(e?.message || 'Något gick fel. Försök igen.');
    } finally {
      setBusy(false);
    }
  }

  function onCodeKeyDown(e) {
    if (e.key === 'Enter') go();
  }

  async function onLogout() {
    await logout();
    onClose?.();
    navigate('/');
  }

  return createPortal(
    <>
      <div style={backdropStyle} onClick={onClose} role="presentation" />
      <div
        id="app-menu-sheet"
        ref={sheetRef}
        className="stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-menu-title"
        tabIndex={-1}
        style={sheetStyle}
      >
        <div className="row">
          <h3 id="app-menu-title" className="grow" style={{ margin: 0 }}>{appName}</h3>
          <button type="button" className="btn ghost sm" aria-label="Stäng" onClick={onClose}>✕</button>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <b>Har du en kod?</b>
          <p className="muted small" style={{ margin: 0 }}>Skriv koden som värden delade för att hoppa rakt in.</p>

          {error ? <div className="error-text">{error}</div> : null}

          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            maxLength={16}
            placeholder="KOD"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={onCodeKeyDown}
            style={{ textTransform: 'uppercase', letterSpacing: '0.1em', textAlign: 'center', fontWeight: 700 }}
          />

          <button type="button" className="btn block" onClick={go} disabled={busy}>
            {busy ? 'Letar…' : 'Nu kör vi'}
          </button>
        </div>

        <nav className="stack" style={{ gap: 4, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <Link to="/events" onClick={onClose} style={linkStyle}>Alla evenemang</Link>
          {user ? (
            <>
              <Link to="/create" onClick={onClose} style={{ ...linkStyle, color: 'var(--accent-dark)' }}>+ Skapa evenemang</Link>
              <Link to="/profile" onClick={onClose} style={linkStyle}>Min profil</Link>
              <Link to="/admin" onClick={onClose} style={linkStyle}>Värdinställningar</Link>
              <Link to="/admin/users" onClick={onClose} style={linkStyle}>Personer</Link>
              <button type="button" onClick={onLogout} style={{ ...linkStyle, background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
                Logga ut
              </button>
            </>
          ) : (
            <Link to="/login" onClick={onClose} style={linkStyle}>Logga in som värd</Link>
          )}
        </nav>
      </div>
    </>,
    document.body,
  );
}

const backdropStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(10, 15, 30, 0.5)',
  zIndex: 300,
};
const sheetStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  bottom: 0,
  width: 'min(340px, 86vw)',
  background: 'var(--surface, #fff)',
  boxShadow: '4px 0 30px rgba(20, 30, 60, 0.2)',
  padding: 16,
  zIndex: 301,
  overflowY: 'auto',
  outline: 'none',
};
const linkStyle = {
  display: 'block',
  padding: '10px 8px',
  borderRadius: 8,
  color: 'var(--text)',
  textDecoration: 'none',
  fontWeight: 600,
};
