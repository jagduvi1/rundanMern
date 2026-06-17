// App shell — the persistent chrome around every page (port of rundan's
// MainLayout). A sticky .app-header with the brand (logo + appName) that links to
// /events (NOT "/", which is just the cold-start launcher that auto-redirects),
// the global AppMenu sheet (the "jump in with a code" + nav), and the routed page
// body inside <main className="container">.
//
// AppMenu is owned by a sibling agent; we render it and own only its open/close
// state. The whole-app access gate is decided one level up (App.jsx) and rendered
// as our children, so the header stays consistent across gate + pages.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBootstrap } from '../contexts/BootstrapContext';
import { getProxy, isProxying, clearProxy } from '../utils/appState';
import AppMenu from './AppMenu';
import VerifyBanner from './VerifyBanner';

// Stop a host proxy ("playing for X"). The proxy is a read-only OVERLAY — the
// proxied tokens live only in the proxy object (never written to the device's own
// session/member keys), so clearing it instantly restores the host's own identity
// with nothing to leak. Hard-reload so every mounted page re-reads tokens.
function stopProxy() {
  clearProxy();
  window.location.reload();
}

export default function Layout({ children }) {
  const { appName } = useBootstrap();
  const [menuOpen, setMenuOpen] = useState(false);
  const proxy = getProxy();

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          type="button"
          className="btn ghost sm"
          aria-label="Meny"
          aria-expanded={menuOpen}
          aria-controls="app-menu-sheet"
          onClick={() => setMenuOpen(true)}
          style={{ minHeight: 38 }}
        >
          ☰
        </button>
        <Link to="/events" className="brand">
          <img
            src="/assets/gamedo-mark.svg"
            alt=""
            width={26}
            height={26}
            style={{ display: 'block' }}
          />
          <span className="wordmark">{appName}</span>
        </Link>
        <span className="grow" />
      </header>

      {isProxying() ? (
        <div
          className="proxy-bar"
          role="status"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            background: 'var(--accent)', color: '#fff', fontSize: '.9rem',
          }}
        >
          <span className="grow">
            Spelar för <b>{proxy?.name}</b> — svar och poäng räknas för dem.
          </span>
          <button type="button" className="btn sm" onClick={stopProxy}>Sluta</button>
        </div>
      ) : null}

      <VerifyBanner />

      <main className="container">{children}</main>

      {/* Rendered at the shell root (outside the header's stacking context) so the
          overlay layers correctly — matches rundan's placement. */}
      <AppMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  );
}
