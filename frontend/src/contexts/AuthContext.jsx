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

  const register = async (username, email, password, displayName, inviteToken) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, email, password, displayName, inviteToken }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Registrering misslyckades' };
      storeToken(data.token);
      setUser(data.user);
      return { success: true, eventId: data.eventId || null };
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

  // Magic-link login: consume a one-time token, store the access token + user just
  // like login/register, and surface the eventId the link was for (when invited).
  const consumeMagicLink = async (linkToken) => {
    try {
      const res = await fetch('/api/auth/magic-link/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: linkToken }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Länken är ogiltig eller har gått ut.' };
      storeToken(data.token);
      setUser(data.user);
      return { success: true, eventId: data.eventId || null };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // Set (or change) the password on the current account — turns a passwordless
  // invited account into a normal one. Requires the access token (auth route).
  const setPassword = async (password, username) => {
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ password, username }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Kunde inte spara lösenordet.' };
      if (data.user) setUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // Request a passwordless login link by email. Always succeeds (anti-enumeration).
  const requestMagicLink = async (email) => {
    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      return { success: true, message: data.message };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // Merge a partial update into the current user (e.g. after the host saves their
  // own Spotify Client ID) without a full /me round-trip.
  const patchUser = useCallback((partial) => {
    setUser((u) => (u ? { ...u, ...partial } : u));
  }, []);

  const isAdmin = !!user?.roles?.includes('admin');
  const value = {
    user, token, loading, isAdmin, register, login, logout,
    consumeMagicLink, setPassword, requestMagicLink, patchUser,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
