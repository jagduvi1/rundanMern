// Token-aware API client — the React port of rundan's RundanApi. It injects, per
// call, the four credential headers the backend understands:
//   • Authorization: Bearer <jwt>   — host/admin account (from AuthContext)
//   • X-Rundan-Access               — optional shared site code (localStorage)
//   • X-Rundan-Participant          — anonymous per-activity player token
//   • X-Rundan-Member               — per-event roster/co-host token
// Participant + member tokens are kept per id in localStorage (mirroring
// rundan's `rundan.session.{activityId}` / `rundan.membertoken.{eventId}`), so a
// device naturally re-presents the right identity for the right activity/event.

const KEYS = {
  access: 'rundan.access',
  session: (activityId) => `rundan.session.${activityId}`,
  member: (eventId) => `rundan.membertoken.${eventId}`,
  proxy: 'rundan.proxy',
};

// "Play for a player" overlay: when a host is proxying a roster player, that
// player's per-activity tokens + member token (held in the proxy object) take
// precedence — as a READ-ONLY OVERLAY that NEVER overwrites the device's own
// stored session/member keys. So stopping the proxy (clearing rundan.proxy)
// instantly restores the host's own identity with nothing left to leak. Read
// straight from localStorage to avoid importing the appState layer.
function activeProxy() {
  try {
    const raw = localStorage.getItem(KEYS.proxy);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Host-auth hooks, wired by AuthContext so the client can read the live access
// token and trigger a refresh on 401.
const host = { getToken: () => null, refresh: async () => null, onLogout: async () => {} };
// Dedupe concurrent refreshes: many in-flight 401s share ONE refresh so cookie
// rotation doesn't invalidate the others (which would cause a spurious logout).
let refreshing = null;
export function wireHostAuth({ getToken, refresh, onLogout }) {
  if (getToken) host.getToken = getToken;
  if (refresh) host.refresh = refresh;
  if (onLogout) host.onLogout = onLogout;
}

// ── Persisted device credentials ──────────────────────────────────────────────
export const getAccessCode = () => localStorage.getItem(KEYS.access) || '';
export const setAccessCode = (c) =>
  c ? localStorage.setItem(KEYS.access, c) : localStorage.removeItem(KEYS.access);

export const getParticipantToken = (activityId) => {
  if (!activityId) return null;
  const proxy = activeProxy();
  if (proxy && Array.isArray(proxy.slots)) {
    const slot = proxy.slots.find((s) => String(s.activityId) === String(activityId));
    if (slot && slot.token) return slot.token; // overlay wins while proxying
  }
  return localStorage.getItem(KEYS.session(activityId)) || null;
};
export const setParticipantToken = (activityId, token) =>
  token ? localStorage.setItem(KEYS.session(activityId), token)
        : localStorage.removeItem(KEYS.session(activityId));

export const getMemberToken = (eventId) => {
  if (!eventId) return null;
  const proxy = activeProxy();
  if (proxy && proxy.memberToken && String(proxy.eventId) === String(eventId)) {
    return proxy.memberToken; // overlay wins while proxying this event
  }
  return localStorage.getItem(KEYS.member(eventId)) || null;
};
export const setMemberToken = (eventId, token) =>
  token ? localStorage.setItem(KEYS.member(eventId), token)
        : localStorage.removeItem(KEYS.member(eventId));

export const getHostToken = () => host.getToken();

export class ApiError extends Error {
  constructor(message, status) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
  }
}

// opts: { body, activityId, eventId, participantToken, memberToken, isForm }
async function request(method, path, opts = {}, allowRetry = true) {
  const { body, activityId, eventId, participantToken, memberToken, isForm } = opts;
  const headers = {};
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  const token = host.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const access = getAccessCode();
  if (access) headers['X-Rundan-Access'] = access;
  const pt = participantToken !== undefined ? participantToken : getParticipantToken(activityId);
  if (pt) headers['X-Rundan-Participant'] = pt;
  const mt = memberToken !== undefined ? memberToken : getMemberToken(eventId);
  if (mt) headers['X-Rundan-Member'] = mt;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Host access token expired → refresh once (deduped), then retry.
  if (res.status === 401 && allowRetry && token) {
    refreshing = refreshing || host.refresh().finally(() => { refreshing = null; });
    const fresh = await refreshing;
    if (fresh) return request(method, path, opts, false);
  }

  if (!res.ok) {
    let message = res.statusText;
    try { const e = await res.json(); message = e.error || message; } catch { /* non-JSON */ }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const apiGet = (path, opts) => request('GET', path, opts);
export const apiPost = (path, body, opts = {}) => request('POST', path, { ...opts, body });
export const apiPut = (path, body, opts = {}) => request('PUT', path, { ...opts, body });
export const apiDelete = (path, opts) => request('DELETE', path, opts);
export const apiUpload = (path, formData, opts = {}) =>
  request('POST', path, { ...opts, body: formData, isForm: true });
