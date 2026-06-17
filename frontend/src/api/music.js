import { apiPost, apiDelete } from './client';

// Music quiz host actions. Base: /api/activities
export const lookupTrack = (activityId, spotifyUrl) =>
  apiPost(`/activities/${activityId}/music/lookup`, { spotifyUrl }, { activityId });
// Source playlists remembered on the quiz (import more later, round-robin).
export const addPlaylist = (activityId, playlistUrl) =>
  apiPost(`/activities/${activityId}/music/playlists`, { playlistUrl }, { activityId });
export const removePlaylist = (activityId, playlistId) =>
  apiDelete(`/activities/${activityId}/music/playlists/${playlistId}`, { activityId });
// Import `count` tracks, round-robin across the saved playlists.
export const importPlaylist = (activityId, count) =>
  apiPost(`/activities/${activityId}/music/import`, { count }, { activityId });
export const startTrack = (activityId, questionId) =>
  apiPost(`/activities/${activityId}/music/start/${questionId}`, {}, { activityId });
