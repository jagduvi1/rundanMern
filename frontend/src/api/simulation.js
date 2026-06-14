import { apiPost } from './client';

// Simulation (host testing). Base: /api/activities
export const simulate = (activityId) =>
  apiPost(`/activities/${activityId}/simulate`, {}, { activityId });
export const resetResults = (activityId) =>
  apiPost(`/activities/${activityId}/reset-results`, {}, { activityId });
