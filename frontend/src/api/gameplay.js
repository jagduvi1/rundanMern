import { apiGet, apiPost, apiDelete, apiUpload } from './client';

// Gameplay. Base: /api/activities. Player actions carry the participant token
// automatically (activityId → x-rundan-participant header).
export const submitAnswer = (activityId, body) =>
  apiPost(`/activities/${activityId}/answers`, body, { activityId });
export const getMyAnswers = (activityId) =>
  apiGet(`/activities/${activityId}/my-answers`, { activityId });

export const recordScore = (activityId, body) =>
  apiPost(`/activities/${activityId}/scores`, body, { activityId });
export const getScores = (activityId) => apiGet(`/activities/${activityId}/scores`, { activityId });
// The persisted partner-mixer teams for ONE activity (TeamDto[]: participantId +
// members[{id,name}]) — drives the host BouleBoard's roster scorekeeping.
export const getActivityTeams = (activityId) =>
  apiGet(`/activities/${activityId}/teams`, { activityId });
export const deleteScore = (activityId, scoreId) =>
  apiDelete(`/activities/${activityId}/scores/${scoreId}`, { activityId });

export const getPhotos = (activityId) => apiGet(`/activities/${activityId}/photos`, { activityId });
export const uploadPhoto = (activityId, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return apiUpload(`/activities/${activityId}/photos`, fd, { activityId });
};
export const deletePhoto = (activityId, photoId) =>
  apiDelete(`/activities/${activityId}/photos/${photoId}`, { activityId });
