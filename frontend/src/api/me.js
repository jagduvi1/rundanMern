import { apiGet, apiPost, apiPut, apiDelete } from './client';

// The logged-in account's own profile, cross-event stats, and friends.
// Base: /api/me (friends share the same base on the backend).
export const getMe = () => apiGet('/me');
export const getMyStats = () => apiGet('/me/stats');
export const updateDisplayName = (displayName) => apiPut('/me/display-name', { displayName });

export const getFriends = () => apiGet('/me/friends');
export const getFriendCode = () => apiGet('/me/friend-code');
export const addFriendByCode = (code) => apiPost('/me/friends/by-code', { code });
export const removeFriend = (id) => apiDelete(`/me/friends/${id}`);
