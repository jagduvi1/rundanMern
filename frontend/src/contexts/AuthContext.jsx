import { createContext, useState, useContext, useEffect, useRef, useCallback } from 'react';
import { wireHostAuth } from '../api/client';

// Host/admin account auth — the Glosan pattern: access token in memory, refresh
// token in an httpOnly cookie. Players never use this (they use anonymous
// participant tokens). Anonymous visitors simply have user = null.
const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  const tokenRef = useRef(null);
  useEffect(() => { tokenRef.current = token; }, [token]);

  const storeToken = (t) => { setToken(t); tokenRef.current = t; };
  const clearToken = () => { setToken(null); tokenRef.current = null; };

  const handleRefresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      storeToken(data.token);
      return data.token;
    } catch {
      return null;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
      });
    } catch { /* best effort */ }
    clearToken();
    setUser(null);
  }, []);

  // Let the API client read the live token + refresh on 401.
  useEffect(() => {
    wireHostAuth({ getToken: () => tokenRef.current, refresh: handleRefresh, onLogout: logout });
  }, [handleRefresh, logout]);

  const fetchProfile = useCallback(async (authToken) => {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${authToken}` },
        credentials: 'include',
      });
      if (res.ok) setUser((await res.json()).user);
      else { clearToken(); setUser(null); }
    } catch {
      clearToken(); setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const t = await handleRefresh();
      if (t) await fetchProfile(t);
      else setLoading(false);
    })();
  }, [handleRefresh, fetchProfile]);

  const register = async (username, email, password, displayName) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, email, password, displayName }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Registrering misslyckades' };
      storeToken(data.token);
      setUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const login = async (username, password) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Inloggning misslyckades' };
      storeToken(data.token);
      setUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const isAdmin = !!user?.roles?.includes('admin');
  const value = { user, token, loading, isAdmin, register, login, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
