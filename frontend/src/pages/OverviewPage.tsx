import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Database,
  FileText,
  FolderSearch,
  IndianRupee,
  RefreshCw,
  Shield,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ROLE_CAPABILITIES, ROLE_LABELS } from '../auth/permissions.ts';
import { CopilotPanel } from '../components/CopilotPanel.tsx';
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

interface DashboardMetricsResponse {
  cards: {
    totalInvoices: number;
    matchedCount: number;
    mismatchedCount: number;
    possibleDuplicatesCount: number;
    highRiskCount: number;
    pendingInvestigationsCount: number;
    itcAtRiskInr: number;
    eligibleForApprovalCount: number;
    approvedCount: number;
  };
  charts: {
    invoicesByStatus: Array<{ status: string; count: number }>;
    riskLevelDistribution: Array<{ riskLevel: string; count: number }>;
    investigationsByDepartment: Array<{
      department: string;
      openCount: number;
      revalidatedCount: number;
      totalCount: number;
    }>;
  };
  recentAlerts: Array<{
    flagId: number;
    invoiceId: number;
    invoiceNumber: string | null;
    supplierName: string | null;
    ruleCode: string;
    severity: string;
    reason: string;
    score: number;
    invoiceStatus: string;
    riskLevel: string;
    createdAt: string;
  }>;
}

const RISK_BAR_COLORS: Record<string, string> = {
  CRITICAL: '#be123c',
  HIGH: '#e11d48',
  MEDIUM: '#d97706',
  LOW: '#059669',
};

function formatInr(amount: number): string {
  return `Rs ${amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function OverviewPage() {
  const { user, apiFetch } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<DashboardMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverviewData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, dashboardRes] = await Promise.all([
        fetch('/api/health', { headers: { Accept: 'application/json' } }).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as HealthResponse;
        }),
        apiFetch<DashboardMetricsResponse>('/api/dashboard/metrics'),
      ]);
      setHealth(healthRes);
      setMetrics(dashboardRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard metrics');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void fetchOverviewData();
  }, [fetchOverviewData]);

  if (!user) {
    return null;
  }

  const cards = metrics?.cards;

  return (
    <div className="space-y-8">
      {/* 7 Executive KPI Cards (Sample Data) */}
      <section aria-label="Accounts Payable & Risk Summary">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Accounts Payable, Risk &amp; Investigation Overview (Sample Data)
            </h2>
            <p className="text-xs text-slate-500">
              Live PostgreSQL metrics across 3-way matching, duplicate detection, GST/ITC exposure, and active investigations.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to="/investigations"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-950"
            >
              Investigation Center
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <Link
              to="/invoices"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-950"
            >
              Invoices Ledger
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Total Invoices</span>
              <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
              {cards ? cards.totalInvoices : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">Active &amp; historical ledger</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Matched</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
              {cards ? cards.matchedCount : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">3-way PO + GRN + Invoice passed</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Mismatched</span>
              <AlertTriangle className="h-4 w-4 text-rose-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-rose-700 tabular-nums">
              {cards ? cards.mismatchedCount : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">Placed ON_HOLD automatically</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Possible Duplicates</span>
              <Copy className="h-4 w-4 text-orange-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-orange-700 tabular-nums">
              {cards ? cards.possibleDuplicatesCount : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">Flagged for human verification</p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>High-Risk Priority</span>
              <ShieldAlert className="h-4 w-4 text-rose-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-rose-700 tabular-nums">
              {cards ? cards.highRiskCount : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Investigation priority (requires 2 approvers; not proof of fraud)
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Pending Investigations</span>
              <FolderSearch className="h-4 w-4 text-amber-600" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-amber-700 tabular-nums">
              {cards ? cards.pendingInvestigationsCount : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              OPEN / IN_PROGRESS / REOPENED cases blocking payment
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>ITC at Risk (INR)</span>
              <IndianRupee className="h-4 w-4 text-slate-700" aria-hidden="true" />
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
              {cards ? formatInr(cards.itcAtRiskInr) : '—'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              GSTR-2B gaps &amp; GST compliance exposure
            </p>
          </div>
        </div>
      </section>

      {/* 3 Analytics Charts (Recharts) */}
      <section aria-label="Operational Risk Charts" className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">Invoices by Status</h3>
          <p className="mt-0.5 text-xs text-slate-500">Distribution across workflow states</p>
          <div className="mt-4 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={metrics?.charts.invoicesByStatus || []}
                margin={{ top: 8, right: 8, left: -16, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="status"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  interval={0}
                  angle={-20}
                  textAnchor="end"
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#475569' }} />
                <Tooltip />
                <Bar dataKey="count" name="Invoices" fill="#0f172a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Investigation Priority Distribution
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Composite risk tier (investigation priority only)
          </p>
          <div className="mt-4 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={metrics?.charts.riskLevelDistribution || []}
                margin={{ top: 8, right: 8, left: -16, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="riskLevel" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#475569' }} />
                <Tooltip />
                <Bar dataKey="count" name="Invoices" radius={[4, 4, 0, 0]}>
                  {(metrics?.charts.riskLevelDistribution || []).map((entry) => (
                    <Cell
                      key={entry.riskLevel}
                      fill={RISK_BAR_COLORS[entry.riskLevel] || '#334155'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Investigations by Department
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">Open vs Revalidated workload</p>
          <div className="mt-4 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={metrics?.charts.investigationsByDepartment || []}
                margin={{ top: 8, right: 8, left: -16, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="department"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  interval={0}
                  angle={-15}
                  textAnchor="end"
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#475569' }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Bar dataKey="openCount" name="Pending" stackId="dept" fill="#d97706" />
                <Bar
                  dataKey="revalidatedCount"
                  name="Revalidated"
                  stackId="dept"
                  fill="#059669"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* AI Audit Copilot */}
      <CopilotPanel />

      {/* Recent Active Alerts */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Recent Active Alerts &amp; Flags (Sample Data)
            </h2>
            <p className="text-xs text-slate-500">
              Triggered rule flags awaiting investigation or revalidation. Click any alert to inspect the invoice.
            </p>
          </div>
          <Link
            to="/investigations"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Open Investigation Center
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>

        {!metrics || metrics.recentAlerts.length === 0 ? (
          <p className="py-6 text-sm text-slate-500">No active unresolved risk flags found.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-3">Invoice</th>
                  <th className="py-2 pr-3">Supplier</th>
                  <th className="py-2 pr-3">Rule</th>
                  <th className="py-2 pr-3">Priority</th>
                  <th className="py-2 pr-3">Evidence Summary</th>
                  <th className="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {metrics.recentAlerts.map((alert) => (
                  <tr key={alert.flagId} className="hover:bg-slate-50">
                    <td className="py-2.5 pr-3 font-mono font-semibold text-slate-900">
                      <Link to={`/invoices/${alert.invoiceId}`} className="hover:underline">
                        {alert.invoiceNumber || `#${alert.invoiceId}`}
                      </Link>
                      <span className="block text-[11px] font-normal text-slate-500">
                        {alert.invoiceStatus}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-700">
                      {alert.supplierName || 'Unknown'}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-slate-800">{alert.ruleCode}</td>
                    <td className="py-2.5 pr-3 font-mono font-semibold">
                      <span
                        className={
                          alert.severity === 'CRITICAL' || alert.severity === 'HIGH'
                            ? 'text-rose-700'
                            : 'text-amber-700'
                        }
                      >
                        {alert.severity} (+{alert.score})
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-700">{alert.reason}</td>
                    <td className="py-2.5 text-right">
                      <Link
                        to={`/invoices/${alert.invoiceId}`}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                      >
                        Inspect
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Session & Health */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
            <Shield className="mt-0.5 h-5 w-5 text-slate-700" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Active Session &amp; RBAC Permissions
              </h2>
              <p className="mt-1 text-xs text-slate-500">
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
                  System &amp; Database Connectivity
                </h2>
                <p className="text-xs text-slate-500">
                  Live status from <code className="font-mono">GET /api/health</code>
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void fetchOverviewData()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh
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
                <p className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
                  {health.phase} · {new Date(health.timestamp).toLocaleString()}
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
    </div>
  );
}
