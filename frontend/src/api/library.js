import { apiGet, apiPost } from './client';

// Question library. Base: /api
export const getLibraryTags = () => apiGet('/question-library/tags');
export const getLibraryAvailable = (tags = []) =>
  apiGet(`/question-library/available${tags.length ? `?tags=${encodeURIComponent(tags.join(','))}` : ''}`);
// Pull N random unused library questions into an activity.
export const generateFromLibrary = (activityId, count, tags) =>
  apiPost(`/activities/${activityId}/questions/from-library`, { count, tags }, { activityId });
