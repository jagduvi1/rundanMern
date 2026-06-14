import { apiGet, apiPost, apiPut } from './client';

// Boule bracket. Base: /api/activities
export const getBracket = (activityId) => apiGet(`/activities/${activityId}/bracket`, { activityId });
export const getSeeds = (activityId) => apiGet(`/activities/${activityId}/seeds`, { activityId });
export const setSeeds = (activityId, teamIdsInOrder) =>
  apiPut(`/activities/${activityId}/seeds`, { teamIdsInOrder }, { activityId });
export const drawBracket = (activityId) =>
  apiPost(`/activities/${activityId}/bracket/draw`, {}, { activityId });
export const recordBracketResult = (activityId, matchId, sets) =>
  apiPost(`/activities/${activityId}/bracket/result`, { matchId, sets }, { activityId });
export const resetBracket = (activityId) =>
  apiPost(`/activities/${activityId}/bracket/reset`, {}, { activityId });
