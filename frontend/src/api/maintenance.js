import { apiGet, apiPost, apiUpload } from './client';

// Admin maintenance. Base: /api/admin
export const uploadImage = (file) => {
  const fd = new FormData();
  fd.append('file', file);
  return apiUpload('/admin/upload', fd); // → { url }
};
export const seedDemo = () => apiPost('/admin/seed', {});
export const cleanAndSeed = (code) => apiPost('/admin/clean-and-seed', { code });
export const verifyAdmin = () => apiGet('/admin/verify');
