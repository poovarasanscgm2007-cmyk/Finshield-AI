import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { UserRole } from '../auth/permissions.ts';
import { getApiUrl } from '../utils/api.ts';

export interface AuthUser {
  id: number;
  employeeCode: string;
  name: string;
  email: string;
  role: UserRole;
  department: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  apiFetch: <T = unknown>(url: string, options?: RequestInit) => Promise<T>;
}

const TOKEN_STORAGE_KEY = 'finshield_auth_token';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }, []);

  const apiFetch = useCallback(
    async <T = unknown,>(url: string, options: RequestInit = {}): Promise<T> => {
      const headers = new Headers(options.headers || {});
      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json');
      }
      if (options.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }

      const fullUrl = getApiUrl(url);
      const response = await fetch(fullUrl, { ...options, headers });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 401) {
          logout();
        }
        const message =
          (data as { message?: string; error?: string }).message ||
          (data as { error?: string }).error ||
          `Request failed with status ${response.status}`;
        throw new Error(message);
      }

      return data as T;
    },
    [token, logout]
  );

  useEffect(() => {
    let active = true;

    async function verifySession() {
      if (!token) {
        if (active) {
          setUser(null);
          setLoading(false);
        }
        return;
      }

      try {
        const res = await fetch(getApiUrl('/api/auth/me'), {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });

        if (!res.ok) {
          throw new Error('Session expired');
        }

        const data = (await res.json()) as { user: AuthUser };
        if (active) {
          setUser(data.user);
        }
      } catch {
        if (active) {
          logout();
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void verifySession();

    return () => {
      active = false;
    };
  }, [token, logout]);

  const login = useCallback(async (email: string, password: string) => {
    const response = await fetch(getApiUrl('/api/auth/login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        (data as { message?: string; error?: string }).message ||
        'Login failed. Please check your credentials.';
      throw new Error(message);
    }

    const payload = data as { token: string; user: AuthUser };
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, payload.token);
    } catch {
      // Ignore storage errors
    }
    setToken(payload.token);
    setUser(payload.user);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, apiFetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return ctx;
}
