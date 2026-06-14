// Web Push helpers — the React port of rundan's wwwroot/push-interop.js.
// Registers the push-only service worker (served at the site root as
// /service-worker.js), asks permission, and subscribes with the server's VAPID
// public key. All standard browser APIs; runs only over HTTPS (or localhost).
import { getPushKey, subscribePush } from '../api/eventSocial';

export function isPushSupported() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// Subscribe this device to push for `eventId`: fetch the VAPID key, register the
// SW, (re)use a push subscription, and POST it to the backend. Returns the
// subscription DTO on success. Throws if unsupported or permission is denied.
export async function subscribeToPush(eventId) {
  if (!isPushSupported()) {
    throw new Error('Push stöds inte i den här webbläsaren.');
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error('Aviseringar nekades.');
  }

  const keyDto = await getPushKey(eventId);
  const vapidPublicKey = keyDto?.publicKey || keyDto?.key || keyDto?.vapidPublicKey;
  if (!vapidPublicKey) {
    throw new Error('Servern saknar en VAPID-nyckel för push.');
  }

  const reg = await navigator.serviceWorker.register('/service-worker.js');
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const json = sub.toJSON();
  const payload = {
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  };
  await subscribePush(eventId, payload);
  return payload;
}

// Tear down the local push subscription (best-effort; server prunes dead
// endpoints on send).
export async function unsubscribeFromPush() {
  if (!isPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    }
  } catch {
    /* ignore — already gone */
  }
}

// VAPID keys arrive base64url-encoded; the PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
