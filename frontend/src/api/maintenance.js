import { apiGet, apiPost, apiPut, apiUpload } from './client';

// Admin maintenance. Base: /api/admin
export const uploadImage = (file) => {
  const fd = new FormData();
  fd.append('file', file);
  return apiUpload('/admin/upload', fd); // → { url }
};
export const seedDemo = () => apiPost('/admin/seed', {});
export const cleanAndSeed = (code) => apiPost('/admin/clean-and-seed', { code });
export const verifyAdmin = () => apiGet('/admin/verify');
// Reset question-library usage so the whole library can be drawn again. → { cleared }
export const resetLibraryUsage = () => apiPost('/question-library/reset-usage', {});

// Super-admin account/role administration.
export const listAccounts = () => apiGet('/admin/accounts');
export const setAccountRole = (id, admin) => apiPut(`/admin/accounts/${id}/role`, { admin });
