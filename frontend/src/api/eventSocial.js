import { apiGet, apiPost, apiDelete } from './client';

// Event chat / viewers / slap / push. Base: /api/events
export const getChat = (eventId) => apiGet(`/events/${eventId}/chat`, { eventId });
export const postChat = (eventId, author, text) =>
  apiPost(`/events/${eventId}/chat`, { author, text }, { eventId });

export const registerViewer = (eventId, name, token) =>
  apiPost(`/events/${eventId}/viewers`, { name, token }, { eventId });
export const removeViewer = (eventId, token) =>
  apiDelete(`/events/${eventId}/viewers/${token}`, { eventId });

// Note: the slap GET is keyed by ACTIVITY id (resolves its event server-side);
// the mutations are keyed by EVENT id with the activityId in the body.
export const getActivitySlap = (activityId) => apiGet(`/events/${activityId}/slap`);
export const performSlap = (eventId, activityId, slappedUserId, recipientUserId) =>
  apiPost(`/events/${eventId}/slap`, { activityId, slappedUserId, recipientUserId }, { eventId });
export const sendSlapPoints = (eventId, activityId, recipientUserId) =>
  apiPost(`/events/${eventId}/slap/send-points`, { activityId, recipientUserId }, { eventId });
export const skipSlap = (eventId, activityId) =>
  apiPost(`/events/${eventId}/slap/skip`, { activityId }, { eventId });

// Web push.
export const getPushKey = (eventId) => apiGet(`/events/${eventId}/push/key`, { eventId });
export const subscribePush = (eventId, subscription) =>
  apiPost(`/events/${eventId}/push/subscribe`, subscription, { eventId });
