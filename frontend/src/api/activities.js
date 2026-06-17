import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Activities. Base: /api/activities
export const listActivities = () => apiGet('/activities');
export const createActivity = (body) => apiPost('/activities', body);
export const getActivity = (id) => apiGet(`/activities/${id}`, { activityId: id });
export const getActivityByCode = (code) => apiGet(`/activities/by-code/${code}`);
export const updateActivity = (id, body) => apiPut(`/activities/${id}`, body, { activityId: id });
export const deleteActivity = (id) => apiDelete(`/activities/${id}`, { activityId: id });
// Reusable library. mine = my templates; public = everyone's shared templates.
export const getMyLibrary = () => apiGet('/activities/library/mine');
export const getPublicLibrary = () => apiGet('/activities/library/public');
// Snapshot an activity into my library (returns the new standalone template).
export const addActivityToLibrary = (id) =>
  apiPost(`/activities/${id}/add-to-library`, {}, { activityId: id });
// Share / unshare one of my library templates with all logged-in users.
export const setLibraryVisibility = (id, isPublic) =>
  apiPost(`/activities/${id}/library-visibility`, { isPublic }, { activityId: id });
// Events that contain copies made from this library template → [{ id, name }].
export const getActivityUsedIn = (id) => apiGet(`/activities/${id}/used-in`, { activityId: id });
export const setActivityStatus = (id, status) =>
  apiPut(`/activities/${id}/status`, { status }, { activityId: id });
export const setCourts = (id, label, names) =>
  apiPut(`/activities/${id}/courts`, { label, names }, { activityId: id });
export const getScoreboard = (id) => apiGet(`/activities/${id}/scoreboard`, { activityId: id });
export const getSummary = (id) => apiGet(`/activities/${id}/summary`, { activityId: id });
