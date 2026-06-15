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
export const addEventAdmin = (id, email) =>
  apiPost(`/events/${id}/admins`, { email }, { eventId: id });
export const removeEventAdmin = (id, accountId) =>
  apiDelete(`/events/${id}/admins/${accountId}`, { eventId: id });
export const setEventCode = (id, code) => apiPut(`/events/${id}/code`, { code }, { eventId: id });
export const reorderActivities = (id, activityIds) =>
  apiPut(`/events/${id}/reorder`, { activityIds }, { eventId: id });
export const setActivitiesStatus = (id, status) =>
  apiPut(`/events/${id}/activities/status`, { status }, { eventId: id });
export const getStandings = (id) => apiGet(`/events/${id}/standings`, { eventId: id });
export const getTeams = (id) => apiGet(`/events/${id}/teams`, { eventId: id });
export const reshuffleTeams = (id) => apiPost(`/events/${id}/teams/reshuffle`, {}, { eventId: id });
export const arrive = (id, lat, lng) => apiPost(`/events/${id}/arrive`, { lat, lng }, { eventId: id });

// Joining an event (by code). join = free-name; claim = pick a roster identity.
export const joinEvent = (code, displayName) =>
  apiPost(`/events/by-code/${code}/join`, { displayName });
export const claimEvent = (code, userId) =>
  apiPost(`/events/by-code/${code}/claim`, { userId });
// "Spela som mig": a logged-in account claims its OWN linked roster identity —
// userId is omitted so the backend resolves it from the account.
export const claimEventAsMe = (code) =>
  apiPost(`/events/by-code/${code}/claim`, {});
