import { apiGet, apiPost, apiDelete } from './client';

// Joining / participants. Base: /api/activities
// joinActivity returns { token, activity, participant } — caller persists the
// token via client.setParticipantToken(activity.id, token).
export const joinActivity = (code, displayName, existingToken) =>
  apiPost(`/activities/by-code/${code}/join`, { displayName, existingToken });
export const listParticipants = (activityId) =>
  apiGet(`/activities/${activityId}/participants`, { activityId });
export const kickParticipant = (activityId, participantId) =>
  apiDelete(`/activities/${activityId}/participants/${participantId}`, { activityId });
