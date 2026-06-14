import { apiGet, apiPost, apiPut } from './client';

// MapPin / Memory / WordGame play. Base: /api/activities (player token via activityId).
export const getCities = (activityId) => apiGet(`/activities/${activityId}/cities`, { activityId });
export const pinCity = (activityId, cityId, lat, lng) =>
  apiPost(`/activities/${activityId}/pin`, { cityId, lat, lng }, { activityId });

export const getMemoryBoard = (activityId) =>
  apiGet(`/activities/${activityId}/memory`, { activityId });
export const submitMemoryResult = (activityId, body) =>
  apiPost(`/activities/${activityId}/memory/result`, body, { activityId });
// Host authoring of the Memory card labels (each becomes a matching pair).
export const setMemoryCards = (activityId, words) =>
  apiPut(`/activities/${activityId}/memory-cards`, { words }, { activityId });

export const getWordGame = (activityId) =>
  apiGet(`/activities/${activityId}/wordgame`, { activityId });
export const submitWord = (activityId, openedIndices, word) =>
  apiPost(`/activities/${activityId}/wordgame/submit`, { openedIndices, word }, { activityId });
