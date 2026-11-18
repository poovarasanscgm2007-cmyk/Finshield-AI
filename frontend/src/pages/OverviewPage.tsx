import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Database, RefreshCw, Shield, XCircle } from 'lucide-react';
import { ROLE_CAPABILITIES, ROLE_LABELS } from '../auth/permissions.ts';
import { useAuth } from '../context/AuthContext.tsx';

interface HealthResponse {
  status: string;
  service: string;
  phase: string;
  timestamp: string;
  database: {
    configured: boolean;
    connected: boolean;
    message: string;
  };
}

export function OverviewPage() {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/health', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as HealthResponse;
      setHealth(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach /api/health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
  }, [fetchHealth]);

  if (!user) {
    return null;
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
          <Shield className="mt-0.5 h-5 w-5 text-slate-700" aria-hidden="true" />
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Active Session & RBAC Permissions
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {user.name} · {ROLE_LABELS[user.role]} · {user.department} · {user.email}
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-2 text-sm text-slate-700">
          {ROLE_CAPABILITIES[user.role].map((cap) => (
            <li key={cap} className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              <span>{cap}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-2.5">
            <Activity className="h-5 w-5 text-slate-700" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                System & Database Connectivity
              </h2>
              <p className="text-xs text-slate-500">
                Live status from <code className="font-mono">GET /api/health</code>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void fetchHealth()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh Status
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 text-sm text-rose-700">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {health && (
          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <div className="py-1">
              <p className="text-xs font-medium text-slate-500">API Service</p>
              <p className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                {health.status.toUpperCase()} · {health.service}
              </p>
              <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                {new Date(health.timestamp).toLocaleString()}
              </p>
            </div>

            <div className="py-1">
              <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                <Database className="h-3.5 w-3.5" aria-hidden="true" />
                PostgreSQL Database
              </p>
              <p
                className={`mt-1 font-mono text-sm font-semibold ${
                  health.database.connected ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {health.database.connected ? 'CONNECTED' : 'DISCONNECTED'}
              </p>
              <p className="mt-1 text-xs text-slate-500">{health.database.message}</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
