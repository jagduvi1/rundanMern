import { apiGet, apiPost, apiDelete } from './client';

// Joining / participants. Base: /api/activities
// joinActivity returns { token, activity, participant } — caller persists the
// token via client.setParticipantToken(activity.id, token).
export const joinActivity = (code, displayName, existingToken) =>
  apiPost(`/activities/by-code/${code}/join`, { displayName, existingToken });
// Join an activity as your already-claimed roster identity (uses the event member
// token the device holds — passed via { eventId }). For activities that opened
// after you claimed the event, so you don't get re-prompted for a name.
export const joinActivityAsMember = (activityId, eventId) =>
  apiPost(`/activities/${activityId}/join-as-member`, {}, { eventId });
export const listParticipants = (activityId) =>
  apiGet(`/activities/${activityId}/participants`, { activityId });
export const kickParticipant = (activityId, participantId) =>
  apiDelete(`/activities/${activityId}/participants/${participantId}`, { activityId });
