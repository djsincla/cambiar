import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const BrandingContext = createContext({ appName: 'cambiar.world', logoUrl: null, version: '0.0.0', refresh: () => {} });

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState({ appName: 'cambiar.world', logoUrl: null, version: '0.0.0' });

  const refresh = useCallback(async () => {
    try {
      const b = await api.get('/api/settings/branding');
      setBranding(b);
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Refetch when the tab regains focus so a deployed version bump shows
  // up in the topbar without needing a hard reload.
  useEffect(() => {
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return (
    <BrandingContext.Provider value={{ ...branding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}

export const useBranding = () => useContext(BrandingContext);
