import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Activities. Base: /api/activities
export const createActivity = (body) => apiPost('/activities', body);
export const getActivity = (id) => apiGet(`/activities/${id}`, { activityId: id });
export const getActivityByCode = (code) => apiGet(`/activities/by-code/${code}`);
export const updateActivity = (id, body) => apiPut(`/activities/${id}`, body, { activityId: id });
export const deleteActivity = (id) => apiDelete(`/activities/${id}`, { activityId: id });
export const setActivityStatus = (id, status) =>
  apiPut(`/activities/${id}/status`, { status }, { activityId: id });
export const setCourts = (id, label, names) =>
  apiPut(`/activities/${id}/courts`, { label, names }, { activityId: id });
export const getScoreboard = (id) => apiGet(`/activities/${id}/scoreboard`, { activityId: id });
export const getSummary = (id) => apiGet(`/activities/${id}/summary`, { activityId: id });
