import { apiGet, apiPost, apiDelete } from './client';

// Imposture (find-the-impostor word game). Base: /api/activities.

// Host: the secret-word list.
export const addImpostureWord = (activityId, word, category) =>
  apiPost(`/activities/${activityId}/imposture/words`, { word, category }, { activityId });
export const removeImpostureWord = (activityId, wordId) =>
  apiDelete(`/activities/${activityId}/imposture/words/${wordId}`, { activityId });
export const addImpostureStarter = (activityId) =>
  apiPost(`/activities/${activityId}/imposture/words/starter`, {}, { activityId });

// Host: round control. The returned DTO reveals the word + impostor(s) (host-only).
export const getImpostureHost = (activityId) =>
  apiGet(`/activities/${activityId}/imposture/host`, { activityId });
export const startImpostureRound = (activityId) =>
  apiPost(`/activities/${activityId}/imposture/round/start`, {}, { activityId });
export const openImpostureVoting = (activityId) =>
  apiPost(`/activities/${activityId}/imposture/round/voting`, {}, { activityId });
export const revealImpostureRound = (activityId) =>
  apiPost(`/activities/${activityId}/imposture/round/reveal`, {}, { activityId });

// Player: role, vote, and a caught impostor's word-guess.
export const getImpostureMe = (activityId) =>
  apiGet(`/activities/${activityId}/imposture/me`, { activityId });
export const castImpostureVote = (activityId, votedParticipantId) =>
  apiPost(`/activities/${activityId}/imposture/vote`, { votedParticipantId }, { activityId });
export const guessImpostureWord = (activityId, guess) =>
  apiPost(`/activities/${activityId}/imposture/round/guess`, { guess }, { activityId });
