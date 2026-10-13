'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type ApiError, type SessionInfo } from './api';

interface SessionContextValue {
  session: SessionInfo | null;
  error: ApiError | null;
  isAccount: boolean;
  refresh: () => Promise<SessionInfo>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Loads GET /v1/session once and shares the principal kind with the UI. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const off = api.onSession((s) => {
      setSession(s);
      setError(null);
    });
    api.getSession().catch((err: ApiError) => setError(err));
    return () => {
      off();
    };
  }, []);

  const refresh = useCallback(() => api.refreshSession(), []);
  const value = useMemo<SessionContextValue>(
    () => ({ session, error, isAccount: session?.principal.kind === 'account', refresh }),
    [session, error, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
