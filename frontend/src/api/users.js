import { apiGet, apiPost, apiPut, apiDelete } from './client';

// Roster users (host-managed). Base: /api/users
export const listUsers = () => apiGet('/users');
export const createUser = (name) => apiPost('/users', { name });
export const updateUser = (id, name) => apiPut(`/users/${id}`, { name });
export const deleteUser = (id) => apiDelete(`/users/${id}`);
