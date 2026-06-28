// PWA install + platform helpers.
//
// Two install paths exist, and they are very different:
//   • Android / Chromium fire a `beforeinstallprompt` event we can stash and later
//     replay from a user gesture (a real one-tap install). It can fire BEFORE React
//     mounts, so we attach the listener at module import (main.jsx imports this).
//   • iOS Safari has NO programmatic install — the user must use Share → "Add to
//     Home Screen". There we can only detect the platform and show instructions.
//
// Installing matters here because iOS only allows Web Push + a reliable foreground
// geofence (Tipspromenad) once the app runs as a home-screen PWA, not in a tab.

let deferredPrompt = null; // stashed BeforeInstallPromptEvent (Android/Chromium)
let installed = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

// Subscribe to install-availability changes (prompt captured / app installed).
// Returns an unsubscribe function.
export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// True once Chromium has handed us an installable prompt we can replay.
export function canPromptInstall() {
  return !!deferredPrompt;
}

// Replay the native Android/Chromium install prompt from a user gesture.
// Returns 'accepted' | 'dismissed' | 'unavailable'. The event is single-use.
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  const evt = deferredPrompt;
  deferredPrompt = null; // a captured prompt can only be used once
  notify();
  try {
    evt.prompt();
    const choice = await evt.userChoice;
    return choice?.outcome || 'dismissed';
  } catch {
    return 'dismissed';
  }
}

// Already running as an installed PWA (home-screen / standalone window)?
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true // iOS Safari's non-standard flag
  );
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a Macintosh UA — disambiguate by touch support.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iphone|ipad|ipod/i.test(ua) || iPadOS;
}

export function isAndroid() {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent || '');
}

// On iOS, only *Safari* can "Add to Home Screen". Chrome/Firefox/Edge for iOS
// (CriOS/FxiOS/EdgiOS) and in-app webviews (Instagram, Messenger, etc. — a common
// path when a guest taps an invite link) cannot — the user must reopen in Safari.
// Returns true for those iOS contexts so the banner can say "open in Safari" instead
// of showing Share-sheet steps that don't exist there.
const IOS_NON_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Line\/|GSA\/|Snapchat|Pinterest|Twitter|TikTok|musical_ly|Bytedance/i;
export function iosNeedsSafari() {
  if (!isIOS()) return false;
  return IOS_NON_SAFARI.test(navigator.userAgent || '');
}

// Chromium-based Android browsers (Chrome, Samsung Internet, Edge) — the ones that
// fire `beforeinstallprompt`. Used to avoid showing manual instructions to users who
// will get the one-tap prompt instead.
export function isChromiumAndroid() {
  if (!isAndroid()) return false;
  return /Chrome|Chromium|SamsungBrowser/i.test(navigator.userAgent || '');
}

export function wasInstalledThisSession() {
  return installed;
}

// Register the push/install service worker at startup. Idempotent (registering the
// same scope twice returns the existing registration), so it coexists with the
// lazy registration in utils/push.js. Chromium needs a registered SW before it will
// fire `beforeinstallprompt`. Deferred to `load` so it never competes with paint.
// Secure-context only (HTTPS or localhost); silently no-ops elsewhere.
export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const reg = () => { navigator.serviceWorker.register('/service-worker.js').catch(() => {}); };
  if (document.readyState === 'complete') reg();
  else window.addEventListener('load', reg, { once: true });
}

// Attach the global install listeners exactly once, at import time.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // suppress Chrome's mini-infobar; we drive our own banner
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    notify();
  });
}
