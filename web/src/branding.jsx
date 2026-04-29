import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const BrandingContext = createContext({ appName: 'cambiar', logoUrl: null, refresh: () => {} });

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState({ appName: 'cambiar', logoUrl: null });

  const refresh = useCallback(async () => {
    try {
      const b = await api.get('/api/settings/branding');
      setBranding(b);
    } catch {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <BrandingContext.Provider value={{ ...branding, refresh }}>
      {children}
    </BrandingContext.Provider>
  );
}

export const useBranding = () => useContext(BrandingContext);
