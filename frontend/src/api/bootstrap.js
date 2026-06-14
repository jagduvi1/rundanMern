import { apiGet } from './client';

export const getBootstrap = () => apiGet('/bootstrap');
