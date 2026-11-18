import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Database, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { SampleDataBanner } from './components/SampleDataBanner.tsx';

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

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/health', {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Health endpoint returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as HealthResponse;
      setHealth(data);
    } catch (err) {
      setHealth(null);
      setError(err instanceof Error ? err.message : 'Unable to reach /api/health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
  }, [fetchHealth]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <SampleDataBanner />

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                FINSHIELD AI
              </h1>
              <p className="text-xs text-slate-600">
                Beyond Invoice Matching: Catch Financial Risk and GST Loss Before You Pay.
              </p>
            </div>
          </div>

          <span className="rounded border border-slate-200 bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-700">
            Phase 1
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-5">
            <div className="flex items-center gap-2.5">
              <Activity className="h-5 w-5 text-slate-700" aria-hidden="true" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Backend Health Check
                </h2>
                <p className="text-sm text-slate-500">
                  Live response from <code className="font-mono text-slate-700">GET /api/health</code>
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void fetchHealth()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {loading ? 'Checking...' : 'Check Health'}
            </button>
          </div>

          <div className="mt-5">
            {loading && !health && !error && (
              <p className="text-sm text-slate-600">Querying backend health endpoint...</p>
            )}

            {error && (
              <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
                <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
                <div>
                  <p className="font-semibold">Backend request failed</p>
                  <p className="mt-1 text-rose-800">{error}</p>
                </div>
              </div>
            )}

            {health && (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      API Service
                    </div>
                    <p className="mt-2 font-mono text-sm font-semibold text-slate-900">
                      {health.status.toUpperCase()} — {health.service}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{health.phase}</p>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                      <Database
                        className={`h-4 w-4 ${
                          health.database.connected ? 'text-emerald-600' : 'text-amber-600'
                        }`}
                        aria-hidden="true"
                      />
                      PostgreSQL Status
                    </div>
                    <p className="mt-2 font-mono text-sm font-semibold text-slate-900">
                      {health.database.connected ? 'CONNECTED' : 'NOT CONNECTED'}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{health.database.message}</p>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                    Raw JSON Payload
                  </p>
                  <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-900 p-4 font-mono text-xs text-slate-100">
                    {JSON.stringify(health, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
