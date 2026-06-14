import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Spotify connections (host-only). Base: /api/spotify
export const setClientId = (clientId) => apiPut('/spotify/client-id', { clientId });
export const connectSpotify = (code, codeVerifier, redirectUri) =>
  apiPost('/spotify/connect', { code, codeVerifier, redirectUri });
export const listConnections = () => apiGet('/spotify/connections');
export const validateConnection = (id) => apiPost(`/spotify/connections/${id}/validate`, {});
export const deleteConnection = (id) => apiDelete(`/spotify/connections/${id}`);
// Short-lived access token for the host's Web Playback SDK.
export const getPlaybackToken = (id) => apiGet(`/spotify/connections/${id}/token`);
