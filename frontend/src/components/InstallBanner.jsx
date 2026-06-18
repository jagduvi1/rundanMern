// "Add to Home Screen" install banner — shown to players who haven't installed the
// PWA yet, so push notifications and the Tipspromenad geofence work properly
// (especially on iOS, where both require a home-screen install, not a browser tab).
//
// One banner, four runtime modes (see `mode` below):
//   • prompt        — Android/Chromium: one-tap install via the captured
//                     beforeinstallprompt (utils/pwa.js).
//   • ios-safari    — real iOS Safari: Share → "Lägg till på hemskärmen" steps.
//   • ios-safari-redirect — iOS Chrome/Firefox/in-app webview (Instagram, Messenger,
//                     …): those can't Add-to-Home-Screen, so tell the user to open in
//                     Safari. Common path when a guest taps an invite link in a social app.
//   • android-manual — non-Chromium Android (e.g. Firefox): browser-menu instructions.
//
// Hidden when already installed (standalone), when there's nothing actionable, or
// when dismissed (snoozed 14 days via a rundan.* localStorage key). Lives in Layout,
// so it never shows on the /cast view.
import { useEffect, useState } from 'react';
import {
  onInstallChange, canPromptInstall, promptInstall,
  isStandalone, isIOS, isAndroid, isChromiumAndroid, iosNeedsSafari,
} from '../utils/pwa';

const DISMISS_KEY = 'rundan.pwa.installdismissed';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // re-offer after two weeks

function recentlyDismissed() {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    if (!v) return false;
    const ts = Number(v);
    if (!ts) return true; // any non-timestamp value → treat as dismissed
    return Date.now() - ts < SNOOZE_MS;
  } catch {
    return false;
  }
}

// Which install affordance (if any) applies to this browser right now.
function installMode(canPrompt) {
  if (canPrompt) return 'prompt';                       // Android/Chromium captured prompt
  if (isIOS()) return iosNeedsSafari() ? 'ios-safari-redirect' : 'ios-safari';
  if (isAndroid() && !isChromiumAndroid()) return 'android-manual'; // e.g. Firefox Android
  return null; // Chromium-on-Android before the prompt fires, desktop Safari, etc.
}

export default function InstallBanner() {
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [dismissed, setDismissed] = useState(recentlyDismissed());
  const [showHelp, setShowHelp] = useState(false);

  // Subscribe to install-availability changes AND re-sync once on commit, so a
  // beforeinstallprompt captured between the initial render and this effect isn't lost.
  useEffect(() => {
    setCanPrompt(canPromptInstall());
    return onInstallChange(() => setCanPrompt(canPromptInstall()));
  }, []);

  if (dismissed || isStandalone()) return null;

  const mode = installMode(canPrompt);
  if (!mode) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
  };

  const install = async () => {
    const outcome = await promptInstall();
    // Accepted → installed; unavailable → nothing more we can do. Either way, stop nagging.
    if (outcome === 'accepted' || outcome === 'unavailable') dismiss();
  };

  const desc = {
    prompt: 'Få push-aviseringar och en bättre upplevelse direkt från hemskärmen.',
    'ios-safari': 'Lägg till på hemskärmen för push-aviseringar och platsstart (tipspromenad).',
    'ios-safari-redirect': 'Öppna gamedo.app i Safari för att kunna lägga till appen på hemskärmen.',
    'android-manual': 'Installera appen för push-aviseringar och en bättre upplevelse.',
  }[mode];

  const steps = {
    'ios-safari': [
      <li key="1">Tryck på <b>Dela</b>-knappen <span aria-hidden="true">⎋</span> längst ner i Safari.</li>,
      <li key="2">Välj <b>Lägg till på hemskärmen</b>.</li>,
      <li key="3">Öppna GameDo från hemskärmen och tryck <b>🔔 Aviseringar</b>.</li>,
    ],
    'ios-safari-redirect': [
      <li key="1">Tryck på <b>⋯</b> eller <b>Dela</b> och välj <b>Öppna i Safari</b>.</li>,
      <li key="2">I Safari: <b>Dela</b> <span aria-hidden="true">⎋</span> → <b>Lägg till på hemskärmen</b>.</li>,
    ],
    'android-manual': [
      <li key="1">Öppna webbläsarens meny <b>⋮</b>.</li>,
      <li key="2">Välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.</li>,
    ],
  }[mode];

  return (
    <div role="region" aria-label="Installera appen" style={bar}>
      <img src="/assets/icon-192.png" alt="" width={34} height={34} style={icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>Installera GameDo</div>
        <div style={{ fontSize: '.85rem', opacity: 0.92 }}>{desc}</div>
        {steps && showHelp ? <ol style={stepList}>{steps}</ol> : null}
      </div>
      {mode === 'prompt' ? (
        <button type="button" style={action} onClick={install}>Installera</button>
      ) : (
        <button type="button" style={action} onClick={() => setShowHelp((v) => !v)}>
          {showHelp ? 'Dölj' : 'Visa hur'}
        </button>
      )}
      <button type="button" onClick={dismiss} aria-label="Stäng" style={closeBtn}>×</button>
    </div>
  );
}

// Solid accent bar with a white action pill — high contrast in both light and dark
// themes (the accent is a saturated blue in both).
const bar = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  background: 'var(--accent)',
  color: '#fff',
  padding: '.6rem .9rem',
  fontSize: '.95rem',
  borderBottom: '1px solid rgba(0,0,0,.18)',
};
const icon = { borderRadius: 8, flexShrink: 0, display: 'block' };
const action = {
  background: '#fff',
  color: 'var(--accent-dark)',
  border: 'none',
  borderRadius: 8,
  padding: '8px 14px',
  fontWeight: 700,
  fontSize: '.9rem',
  minHeight: 36,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const closeBtn = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: '1.35rem',
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 .25rem',
  alignSelf: 'flex-start',
};
const stepList = {
  margin: '.5rem 0 0',
  paddingLeft: '1.1rem',
  fontSize: '.85rem',
  lineHeight: 1.5,
  display: 'grid',
  gap: 2,
};
