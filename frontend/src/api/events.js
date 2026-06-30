import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Events. Base: /api/events
export const listEvents = () => apiGet('/events');
export const listActiveEvents = () => apiGet('/events/active');
export const getEvent = (id) => apiGet(`/events/${id}`, { eventId: id });
export const getEventByCode = (code) => apiGet(`/events/by-code/${code}`);
export const createEvent = (body) => apiPost('/events', body);
export const updateEvent = (id, body) => apiPut(`/events/${id}`, body, { eventId: id });
export const deleteEvent = (id) => apiDelete(`/events/${id}`, { eventId: id });
export const setMembers = (id, userIds, adminUserIds) =>
  apiPut(`/events/${id}/members`, { userIds, adminUserIds }, { eventId: id });
// Add the logged-in host themselves to the roster as an admin player.
export const joinEventSelf = (id) => apiPost(`/events/${id}/join-self`, {}, { eventId: id });
// Link an EXISTING roster player to the logged-in host ("that player is me").
export const linkEventSelf = (id, userId) => apiPost(`/events/${id}/link-self`, { userId }, { eventId: id });
export const addEventAdmin = (id, email) =>
  apiPost(`/events/${id}/admins`, { email }, { eventId: id });
export const removeEventAdmin = (id, accountId) =>
  apiDelete(`/events/${id}/admins/${accountId}`, { eventId: id });
// Leave an event yourself — drops your roster membership and/or co-host grant.
// The owner can't leave (they delete or hand over the event instead).
export const leaveEventSelf = (id) => apiPost(`/events/${id}/leave`, {}, { eventId: id });
// Ensure a roster member by NAME (created in your roster if absent) + added to this
// event, and get { id, name, needsPin, pin } to build a one-scan claim QR/link.
export const rosterClaimLink = (id, name) =>
  apiPost(`/events/${id}/roster-claim-link`, { name }, { eventId: id });
export const setEventCode = (id, code) => apiPut(`/events/${id}/code`, { code }, { eventId: id });
export const reorderActivities = (id, activityIds) =>
  apiPut(`/events/${id}/reorder`, { activityIds }, { eventId: id });
export const setActivitiesStatus = (id, status) =>
  apiPut(`/events/${id}/activities/status`, { status }, { eventId: id });
// Deep-copy a public library activity into this event as a fresh Draft.
export const addActivityFromLibrary = (id, sourceId) =>
  apiPost(`/events/${id}/activities/from-library/${sourceId}`, {}, { eventId: id });
// Restart the whole event: every activity → Draft AND clear all scores; optional chat wipe.
export const restartEvent = (id, clearChat = false) =>
  apiPost(`/events/${id}/reset-results${clearChat ? '?clearChat=true' : ''}`, {}, { eventId: id });
export const getStandings = (id) => apiGet(`/events/${id}/standings`, { eventId: id });
export const getTeams = (id) => apiGet(`/events/${id}/teams`, { eventId: id });
export const reshuffleTeams = (id) => apiPost(`/events/${id}/teams/reshuffle`, {}, { eventId: id });
export const arrive = (id, lat, lng) => apiPost(`/events/${id}/arrive`, { lat, lng }, { eventId: id });

// Set / clear / generate a roster member's claim PIN (manager only).
export const setMemberPin = (id, userId, body) =>
  apiPut(`/events/${id}/members/${userId}/pin`, body, { eventId: id });
// Revoke a member's device token (sign them out; they must re-claim). Manager only.
export const revokeMember = (id, userId) =>
  apiPost(`/events/${id}/members/${userId}/revoke`, {}, { eventId: id });

// Joining an event (by code). join = free-name; claim = pick a roster identity.
export const joinEvent = (code, displayName) =>
  apiPost(`/events/by-code/${code}/join`, { displayName });
// claim a roster identity; `pin` is required for PIN-protected members (admins +
// any the host protected) unless you're claiming your OWN logged-in identity. A
// logged-in caller is bound to this slot FOR THIS EVENT server-side (per-event
// identity, from the JWT) — no link flag needed.
export const claimEvent = (code, userId, pin) =>
  apiPost(`/events/by-code/${code}/claim`, {
    userId, ...(pin ? { pin } : {}),
  });
// "Spela som mig": a logged-in account claims its OWN linked roster identity —
// userId is omitted so the backend resolves it from the account.
export const claimEventAsMe = (code) =>
  apiPost(`/events/by-code/${code}/claim`, {});
