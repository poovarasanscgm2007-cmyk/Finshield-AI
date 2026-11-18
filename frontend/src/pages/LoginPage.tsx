import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, KeyRound, ShieldCheck } from 'lucide-react';
import { SampleDataBanner } from '../components/SampleDataBanner.tsx';
import { useAuth } from '../context/AuthContext.tsx';

interface DemoAccount {
  label: string;
  roleLabel: string;
  email: string;
  password: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    label: 'Aarav Mehta',
    roleLabel: 'AP Employee',
    email: 'ap.employee@abcmfg.sample',
    password: 'SamplePass@101',
  },
  {
    label: 'Employee 102',
    roleLabel: 'Procurement Employee',
    email: 'employee102@abcmfg.sample',
    password: 'SamplePass@102',
  },
  {
    label: 'Rohan Verma',
    roleLabel: 'Warehouse Employee',
    email: 'warehouse@abcmfg.sample',
    password: 'SamplePass@103',
  },
  {
    label: 'Priya Nair',
    roleLabel: 'Finance Manager',
    email: 'finance.manager@abcmfg.sample',
    password: 'SamplePass@104',
  },
  {
    label: 'Vikram Rao',
    roleLabel: 'Admin',
    email: 'admin@abcmfg.sample',
    password: 'SamplePass@105',
  },
];

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fromPath = (location.state as { from?: string } | null)?.from || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) {
    return <Navigate to={fromPath} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email.trim(), password);
      navigate(fromPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  function fillDemoAccount(account: DemoAccount) {
    setEmail(account.email);
    setPassword(account.password);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <SampleDataBanner />

      <div className="mx-auto grid max-w-5xl gap-10 px-6 py-14 lg:grid-cols-12 lg:items-start">
        <div className="rounded-lg border border-slate-200 bg-white p-8 lg:col-span-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                FINSHIELD AI
              </h1>
              <p className="text-xs text-slate-500">
                Beyond Invoice Matching: Catch Financial Risk and GST Loss Before You Pay.
              </p>
            </div>
          </div>

          <h2 className="text-base font-semibold text-slate-900">
            Sign in to your role workspace
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Access is protected by role-based permissions and hash-chained audit logging.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-5 flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                Work Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="employee102@abcmfg.sample"
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>

        <aside className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-6">
          <div className="flex items-center gap-2 border-b border-slate-200 pb-4">
            <KeyRound className="h-4 w-4 text-slate-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">
              Demo logins (sample data)
            </h2>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Select any ABC Manufacturing (sample) role below to populate the sign-in form and test RBAC, maker-checker, and audit logs.
          </p>

          <div className="mt-4 divide-y divide-slate-200 border-t border-slate-200">
            {DEMO_ACCOUNTS.map((acc) => (
              <div
                key={acc.email}
                className="flex items-center justify-between gap-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {acc.label} <span className="text-slate-400">·</span>{' '}
                    <span className="text-slate-600">{acc.roleLabel}</span>
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-slate-500 tabular-nums">
                    {acc.email} / {acc.password}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => fillDemoAccount(acc)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0"
                >
                  Fill Credentials
                </button>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
