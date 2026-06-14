import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Questions. Base: /api/activities
// Player view (no answer key) — sends the participant token via activityId.
export const getQuestions = (activityId) =>
  apiGet(`/activities/${activityId}/questions`, { activityId });
export const getResults = (activityId) =>
  apiGet(`/activities/${activityId}/results`, { activityId });

// Host/admin views + editing.
export const getAdminQuestions = (activityId, reveal = false) =>
  apiGet(`/activities/${activityId}/questions/admin${reveal ? '?reveal=true' : ''}`, { activityId });
export const createQuestion = (activityId, body) =>
  apiPost(`/activities/${activityId}/questions`, body, { activityId });
export const updateQuestion = (activityId, questionId, body) =>
  apiPut(`/activities/${activityId}/questions/${questionId}`, body, { activityId });
export const deleteQuestion = (activityId, questionId) =>
  apiDelete(`/activities/${activityId}/questions/${questionId}`, { activityId });
export const setQuestionLocation = (activityId, questionId, latitude, longitude, radiusMeters) =>
  apiPut(`/activities/${activityId}/questions/${questionId}/location`,
    { latitude, longitude, radiusMeters }, { activityId });
export const setAnswerKey = (activityId, questionId, body) =>
  apiPut(`/activities/${activityId}/questions/${questionId}/answer-key`, body, { activityId });
export const setStationCount = (activityId, count) =>
  apiPut(`/activities/${activityId}/stations`, { count }, { activityId });
