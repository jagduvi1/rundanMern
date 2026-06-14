import { apiPost } from './client';

// Music quiz host actions. Base: /api/activities
export const lookupTrack = (activityId, spotifyUrl) =>
  apiPost(`/activities/${activityId}/music/lookup`, { spotifyUrl }, { activityId });
export const importPlaylist = (activityId, playlistUrl, count) =>
  apiPost(`/activities/${activityId}/music/import`, { playlistUrl, count }, { activityId });
export const startTrack = (activityId, questionId) =>
  apiPost(`/activities/${activityId}/music/start/${questionId}`, {}, { activityId });
