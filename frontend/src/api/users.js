import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Roster users (host-managed) — scoped to your own people. Base: /api/users
// Pass an eventId to also include people already on that event's roster (so the
// event picker keeps members added/invited by co-hosts selectable).
export const listUsers = (eventId) => apiGet(`/users${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ''}`);
export const createUser = (name) => apiPost('/users', { name });
export const updateUser = (id, name) => apiPut(`/users/${id}`, { name });
export const deleteUser = (id) => apiDelete(`/users/${id}`);
