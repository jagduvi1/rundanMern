// Device session store — the React port of rundan's AppState localStorage layer.
// Holds per-device, per-event/activity identity so a phone re-presents the right
// player/viewer/host identity after a reload (flaky mobile is the whole reason
// rundan persists this). All access is best-effort: private mode / quota can throw,
// and the UI must keep working from whatever the caller already has in memory.
//
// The participant + member token keys are owned by src/api/client.js
// (getParticipantToken/setParticipantToken, getMemberToken/setMemberToken); this
// module covers the *other* keys the pages need (names, claimed user, viewer,
// proxy, last event, preview). Keys mirror rundan's exactly so a half-migrated
// device still resolves.

const KEYS = {
  lastEvent: 'rundan.lastevent',
  preview: 'rundan.preview',
  proxy: 'rundan.proxy',
  eventName: (id) => `rundan.eventname.${id}`,
  eventUser: (id) => `rundan.eventuser.${id}`,
  viewer: (id) => `rundan.viewer.${id}`,
  viewerName: (id) => `rundan.viewername.${id}`,
  viewerToken: (id) => `rundan.viewertoken.${id}`,
};

// ── Tiny safe localStorage wrappers ───────────────────────────────────────────
const read = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k, v) => {
  try {
    if (v === null || v === undefined || v === '') localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch { /* private mode / quota — in-memory state still drives the UI */ }
};
const readJson = (k) => {
  const raw = read(k);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

// ── Last opened event (Home redirect) ─────────────────────────────────────────
export const getLastEventId = () => read(KEYS.lastEvent);
export const saveLastEventId = (id) => write(KEYS.lastEvent, id ? String(id) : null);

// ── Name this device joined an event under ────────────────────────────────────
export const getEventName = (eventId) => read(KEYS.eventName(eventId));
export const saveEventName = (eventId, name) => write(KEYS.eventName(eventId), name || null);

// ── Claimed roster user id for an event ───────────────────────────────────────
export const getEventUserId = (eventId) => read(KEYS.eventUser(eventId));
export const saveEventUserId = (eventId, userId) =>
  write(KEYS.eventUser(eventId), userId ? String(userId) : null);

// Per-activity play-session meta ({ id, participantId, displayName }) — the same
// key Activity.jsx readSession reads (`rundan.psession.<activityId>`). A roster
// claim writes this per slot so the "me" highlight + team name work when the player
// opens the activity, and clears it when switching identity on a shared device.
export const saveActivitySession = (activityId, meta) =>
  write(`rundan.psession.${activityId}`, meta ? JSON.stringify(meta) : null);

// ── Spectator (viewer) role/name/token ────────────────────────────────────────
export const isViewer = (eventId) => read(KEYS.viewer(eventId)) === '1';
export const getViewerName = (eventId) => read(KEYS.viewerName(eventId));
export const getViewerToken = (eventId) => read(KEYS.viewerToken(eventId));
export function setViewer(eventId, on, name, token) {
  if (on) {
    write(KEYS.viewer(eventId), '1');
    if (name) write(KEYS.viewerName(eventId), name);
    if (token) write(KEYS.viewerToken(eventId), token);
  } else {
    write(KEYS.viewer(eventId), null);
    write(KEYS.viewerName(eventId), null);
    write(KEYS.viewerToken(eventId), null);
  }
}

// ── Proxy ("host playing as a roster player") ─────────────────────────────────
// Shape: { eventId, userId, name, memberToken }. The per-activity sessions are
// stored as ordinary participant tokens (client.setParticipantToken), so the
// device naturally re-presents the proxied player's token per activity.
export const getProxy = () => readJson(KEYS.proxy);
export const isProxying = () => !!getProxy();
export const setProxy = (proxy) => write(KEYS.proxy, proxy ? JSON.stringify(proxy) : null);
export const clearProxy = () => write(KEYS.proxy, null);

// ── "Preview as player" device mode ───────────────────────────────────────────
export const isPreview = () => read(KEYS.preview) === '1';
export const setPreview = (on) => write(KEYS.preview, on ? '1' : null);
