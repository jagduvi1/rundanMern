import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiGet, getAccessCode, setAccessCode } from '../api/client';

// Public app config fetched before the access gate — the port of rundan's
// BootstrapDto. Tells the SPA the app name, whether a shared access code is
// required, and the public Spotify client id.
const BootstrapContext = createContext(null);

export function useBootstrap() {
  const ctx = useContext(BootstrapContext);
  if (!ctx) throw new Error('useBootstrap must be used within BootstrapProvider');
  return ctx;
}

export function BootstrapProvider({ children }) {
  const [bootstrap, setBootstrap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessCode, setAccessCodeState] = useState(getAccessCode());

  const load = useCallback(async () => {
    try {
      setBootstrap(await apiGet('/bootstrap'));
    } catch {
      setBootstrap(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveAccessCode = useCallback((code) => {
    setAccessCode(code);
    setAccessCodeState(code || '');
  }, []);

  const requiresAccessCode = !!bootstrap?.requiresAccessCode;
  const value = {
    bootstrap,
    loading,
    appName: bootstrap?.appName || 'Rundan',
    requiresAccessCode,
    spotifyClientId: bootstrap?.spotifyClientId || '',
    hasWebPush: !!bootstrap?.hasWebPush,
    accessCode,
    saveAccessCode,
    // True when a shared code is required but the device has not stored one yet.
    needsAccessGate: requiresAccessCode && !accessCode,
    reload: load,
  };
  return <BootstrapContext.Provider value={value}>{children}</BootstrapContext.Provider>;
}
