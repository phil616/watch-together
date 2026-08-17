import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import type { Identity } from "../types";

type AuthState = {
  identity: Identity | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const Context = createContext<AuthState>({
  identity: null,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
});

/** Loads the current identity and exposes refresh/logout actions to the app. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      setIdentity(await api<Identity>("/api/v1/auth/me"));
    } catch {
      setIdentity(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  const logout = async () => {
    await api("/api/v1/auth/logout", { method: "POST", body: "{}" });
    setIdentity(null);
  };
  return (
    <Context.Provider value={{ identity, loading, refresh, logout }}>
      {children}
    </Context.Provider>
  );
}

/** Hook for consuming the shared authentication context. */
export const useAuth = () => useContext(Context);
