import { apiGet, apiPost } from './client';

export const getHitsterState = (activityId) =>
  apiGet(`/activities/${activityId}/hitster`, { activityId });

export const startHitster = (activityId) =>
  apiPost(`/activities/${activityId}/hitster/start`, {}, { activityId });

export const drawHitsterCard = (activityId) =>
  apiPost(`/activities/${activityId}/hitster/draw`, {}, { activityId });

export const placeHitsterCard = (activityId, position) =>
  apiPost(`/activities/${activityId}/hitster/place`, { position }, { activityId });

export const submitHitsterBonus = (activityId, title, artist) =>
  apiPost(`/activities/${activityId}/hitster/bonus`, { title, artist }, { activityId });
