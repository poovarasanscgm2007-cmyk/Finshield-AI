import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  FileText,
  Info,
  Landmark,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '../context/AuthContext.tsx';

interface SupplierScorecardMetric {
  key: string;
  label: string;
  score: number;
  weight: number;
  weightedContribution: number;
  formula: string;
  inputs: Record<string, unknown>;
  unit: string;
}

interface SupplierScorecard {
  supplierId: number;
  supplierCode: string;
  name: string;
  gstin: string;
  pan: string;
  stateCode: string;
  gstFilingStatus: string;
  maskedBankIdentifier: string;
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  label: string;
  disclaimer: string;
  metrics: SupplierScorecardMetric[];
  summary: {
    totalInvoices: number;
    matchedInvoices: number;
    poOrderedQty: number;
    grnReceivedQty: number;
    repeatedExtraChargeInvoices: number;
    discrepantInvoices: number;
    openInvestigations: number;
    resolvedInvestigations: number;
    avgResolutionHours: number;
    gstr2bMissingCount: number;
  };
  linkedInvoices: Array<{
    id: number;
    invoiceNumber: string;
    invoiceDate: string | null;
    total: number;
    status: string;
    riskLevel: string;
    riskScore: number;
    extraCharges: number;
    isHistorical: boolean;
  }>;
  linkedInvestigations: Array<{
    id: number;
    invoiceId: number | null;
    invoiceNumber: string | null;
    issueType: string;
    department: string;
    status: string;
    severity: string;
    description: string | null;
  }>;
  pendingBankChanges: Array<{
    approvalId: number;
    oldBankMasked: string;
    newBankMasked: string;
    requestedByName: string;
    status: string;
    createdAt: string;
  }>;
  isSampleData: boolean;
}

function gradeBadgeClasses(grade: string): string {
  switch (grade) {
    case 'A':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    case 'B':
      return 'border-sky-200 bg-sky-50 text-sky-800';
    case 'C':
      return 'border-amber-200 bg-amber-50 text-amber-800';
    default:
      return 'border-rose-200 bg-rose-50 text-rose-800';
  }
}

function metricBarColor(score: number): string {
  if (score >= 80) return '#059669';
  if (score >= 55) return '#d97706';
  return '#e11d48';
}

function statusBadgeClass(status: string): string {
  if (['MATCHED', 'APPROVED', 'PAID', 'REVALIDATED'].includes(status)) {
    return 'text-emerald-700';
  }
  if (['ON_HOLD', 'MISMATCH', 'REOPENED', 'OPEN'].includes(status)) {
    return 'text-rose-700';
  }
  return 'text-amber-700';
}

export function SuppliersPage() {
  const { user, apiFetch } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [scorecards, setScorecards] = useState<SupplierScorecard[]>([]);
  const [disclaimer, setDisclaimer] = useState<string>(
    'Operational performance score derived from matching, delivery, and GST compliance metrics — not a fraud verdict.'
  );
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const raw = searchParams.get('supplierId');
    return raw && !Number.isNaN(Number(raw)) ? Number(raw) : null;
  });
  const [selectedDetail, setSelectedDetail] = useState<SupplierScorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bank identifier verification change form
  const [newBankId, setNewBankId] = useState('');
  const [bankReason, setBankReason] = useState('');
  const [bankSubmitting, setBankSubmitting] = useState(false);
  const [bankFeedback, setBankFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  const loadAllScorecards = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        disclaimer: string;
        scorecards: SupplierScorecard[];
      }>('/api/suppliers/scorecards');
      setDisclaimer(data.disclaimer);
      setScorecards(data.scorecards);

      if (data.scorecards.length > 0) {
        setSelectedId((prev) => {
          if (prev && data.scorecards.some((s) => s.supplierId === prev)) {
            return prev;
          }
          return data.scorecards[0].supplierId;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier scorecards.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  const loadDetail = useCallback(
    async (supplierId: number) => {
      setDetailLoading(true);
      try {
        const detail = await apiFetch<SupplierScorecard>(
          `/api/suppliers/${supplierId}/scorecard`
        );
        setSelectedDetail(detail);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load supplier scorecard detail.');
      } finally {
        setDetailLoading(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    void loadAllScorecards();
  }, [loadAllScorecards]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    }
  }, [selectedId, loadDetail]);

  function handleSelectSupplier(supplierId: number) {
    setSelectedId(supplierId);
    setBankFeedback(null);
    setNewBankId('');
    setBankReason('');
    setSearchParams({ supplierId: String(supplierId) });
  }

  async function handleBankChangeSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedDetail) return;
    setBankSubmitting(true);
    setBankFeedback(null);
    try {
      const res = await apiFetch<{ message: string }>(
        `/api/suppliers/${selectedDetail.supplierId}/bank`,
        {
          method: 'PUT',
          body: JSON.stringify({
            newBankIdentifier: newBankId.trim(),
            reason: bankReason.trim() || undefined,
          }),
        }
      );
      setBankFeedback({ type: 'ok', text: res.message });
      setNewBankId('');
      setBankReason('');
      await Promise.all([loadAllScorecards(), loadDetail(selectedDetail.supplierId)]);
    } catch (err) {
      setBankFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Unable to submit bank identifier change.',
      });
    } finally {
      setBankSubmitting(false);
    }
  }

  const canRequestBankChange =
    user &&
    ['PROCUREMENT_EMPLOYEE', 'AP_EMPLOYEE', 'FINANCE_MANAGER'].includes(user.role);

  const active = selectedDetail || scorecards.find((s) => s.supplierId === selectedId) || null;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-900">
                Supplier Performance Scorecards (Sample Data)
              </h2>
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                Sample data
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">{disclaimer}</p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/supplier-graph"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              Supplier Relationship Graph
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={() => void loadAllScorecards()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <p className="py-8 text-sm text-slate-500">Computing supplier performance scores...</p>
        ) : scorecards.length === 0 ? (
          <p className="py-8 text-sm text-slate-500">No supplier records available.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2.5 pr-3">Supplier</th>
                  <th className="py-2.5 pr-3">GSTIN &amp; Filing</th>
                  <th className="py-2.5 pr-3">Bank ID (Masked)</th>
                  <th className="py-2.5 pr-3">Matched / Total</th>
                  <th className="py-2.5 pr-3">Open Cases</th>
                  <th className="py-2.5 pr-3">Performance Score</th>
                  <th className="py-2.5 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {scorecards.map((sc) => {
                  const isSelected = active?.supplierId === sc.supplierId;
                  return (
                    <tr
                      key={sc.supplierId}
                      onClick={() => handleSelectSupplier(sc.supplierId)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-slate-100/80' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-3 pr-3">
                        <p className="font-semibold text-slate-900">{sc.name}</p>
                        <p className="font-mono text-[11px] text-slate-500">{sc.supplierCode}</p>
                      </td>
                      <td className="py-3 pr-3 font-mono text-slate-700">
                        <p>{sc.gstin}</p>
                        <p className="text-[11px] text-slate-500">{sc.gstFilingStatus}</p>
                      </td>
                      <td className="py-3 pr-3 font-mono text-slate-800">
                        {sc.maskedBankIdentifier}
                      </td>
                      <td className="py-3 pr-3 font-mono tabular-nums text-slate-800">
                        {sc.summary.matchedInvoices} / {sc.summary.totalInvoices}
                      </td>
                      <td className="py-3 pr-3 font-mono tabular-nums">
                        <span
                          className={
                            sc.summary.openInvestigations > 0
                              ? 'font-semibold text-rose-700'
                              : 'text-emerald-700'
                          }
                        >
                          {sc.summary.openInvestigations}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-xs font-semibold tabular-nums ${gradeBadgeClasses(
                            sc.grade
                          )}`}
                        >
                          {sc.overallScore.toFixed(1)} / 100 · Grade {sc.grade}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectSupplier(sc.supplierId);
                          }}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {active && (
        <div className="space-y-6">
          {/* Header + Chart */}
          <div className="grid gap-6 lg:grid-cols-3">
            <section className="rounded-lg border border-slate-200 bg-white p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Building2 className="h-5 w-5 text-slate-700" aria-hidden="true" />
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">{active.name}</h3>
                    <p className="font-mono text-xs text-slate-500">
                      {active.supplierCode} · State {active.stateCode} · PAN {active.pan}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Operational Performance Score (Sample Data)
                </p>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="font-mono text-3xl font-bold text-slate-900 tabular-nums">
                    {active.overallScore.toFixed(1)}
                  </span>
                  <span className="text-sm text-slate-500">/ 100</span>
                  <span
                    className={`ml-auto rounded border px-2.5 py-0.5 font-mono text-xs font-semibold ${gradeBadgeClasses(
                      active.grade
                    )}`}
                  >
                    Grade {active.grade}
                  </span>
                </div>
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-600">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                  <span>{active.disclaimer}</span>
                </p>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded border border-slate-200 p-2.5">
                  <dt className="text-slate-500">PO Ordered vs GRN</dt>
                  <dd className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                    {active.summary.grnReceivedQty} / {active.summary.poOrderedQty} kg
                  </dd>
                </div>
                <div className="rounded border border-slate-200 p-2.5">
                  <dt className="text-slate-500">Extra-Charge Bills</dt>
                  <dd className="mt-0.5 font-mono font-semibold text-amber-700 tabular-nums">
                    {active.summary.repeatedExtraChargeInvoices} of {active.summary.totalInvoices}
                  </dd>
                </div>
                <div className="rounded border border-slate-200 p-2.5">
                  <dt className="text-slate-500">GSTR-2B Missing</dt>
                  <dd className="mt-0.5 font-mono font-semibold text-rose-700 tabular-nums">
                    {active.summary.gstr2bMissingCount} invoice(s)
                  </dd>
                </div>
                <div className="rounded border border-slate-200 p-2.5">
                  <dt className="text-slate-500">Avg Resolution</dt>
                  <dd className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                    {active.summary.avgResolutionHours.toFixed(1)} hrs
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-2">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Metric Breakdown (0–100 Performance Score)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Computed from real PostgreSQL matching, GRN, GST, and investigation records.
                  </p>
                </div>
                {detailLoading && (
                  <span className="text-xs text-slate-400">Refreshing detail...</span>
                )}
              </div>

              <div className="mt-4 h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={active.metrics.map((m) => ({
                      name: m.label.replace('Responsiveness', 'Resp.').replace('Compliance', 'Comp.'),
                      score: m.score,
                      weightPct: Math.round(m.weight * 100),
                    }))}
                    margin={{ top: 8, right: 16, left: -12, bottom: 28 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10, fill: '#475569' }}
                      interval={0}
                      angle={-15}
                      textAnchor="end"
                    />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#475569' }} />
                    <Tooltip />
                    <Bar dataKey="score" name="Score (0-100)" radius={[4, 4, 0, 0]}>
                      {active.metrics.map((m) => (
                        <Cell key={m.key} fill={metricBarColor(m.score)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Transparent Formulas & Inputs */}
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-slate-900">
              Transparent Performance Score Formula &amp; Inputs
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Every metric exposes its exact formula, real database inputs, and weight — performance score only, never a fraud verdict.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3">Metric</th>
                    <th className="py-2 pr-3">Weight</th>
                    <th className="py-2 pr-3">Score</th>
                    <th className="py-2 pr-3">Weighted Pts</th>
                    <th className="py-2 pr-3">Formula</th>
                    <th className="py-2">Database Inputs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {active.metrics.map((m) => (
                    <tr key={m.key}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900">{m.label}</td>
                      <td className="py-2.5 pr-3 font-mono text-slate-700 tabular-nums">
                        {Math.round(m.weight * 100)}%
                      </td>
                      <td className="py-2.5 pr-3 font-mono font-semibold text-slate-900 tabular-nums">
                        {m.score.toFixed(1)}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-slate-700 tabular-nums">
                        {m.weightedContribution.toFixed(2)}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-600">
                        {m.formula}
                      </td>
                      <td className="py-2.5 font-mono text-[11px] text-slate-700">
                        {Object.entries(m.inputs)
                          .map(([k, v]) => `${k}=${String(v)}`)
                          .join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Linked Invoices Evidence + Bank Verification */}
          <div className="grid gap-6 lg:grid-cols-3">
            <section className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-2">
              <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                <FileText className="h-4 w-4 text-slate-700" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Linked Invoice Evidence ({active.linkedInvoices.length})
                </h3>
              </div>

              {active.linkedInvoices.length === 0 ? (
                <p className="py-6 text-xs text-slate-500">No invoices recorded for this supplier.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2 pr-3">Invoice</th>
                        <th className="py-2 pr-3">Date</th>
                        <th className="py-2 pr-3">Total (INR)</th>
                        <th className="py-2 pr-3">Extra Charges</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Investigation Priority</th>
                        <th className="py-2 text-right">View</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {active.linkedInvoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-slate-50">
                          <td className="py-2.5 pr-3 font-mono font-semibold text-slate-900">
                            {inv.invoiceNumber}
                            {inv.isHistorical && (
                              <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-600">
                                Historical
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-slate-600">
                            {inv.invoiceDate ? inv.invoiceDate.slice(0, 10) : '—'}
                          </td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-900">
                            Rs {inv.total.toLocaleString('en-IN')}
                          </td>
                          <td className="py-2.5 pr-3 font-mono tabular-nums text-amber-800">
                            {inv.extraCharges > 0 ? `Rs ${inv.extraCharges.toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td className={`py-2.5 pr-3 font-mono font-semibold ${statusBadgeClass(inv.status)}`}>
                            {inv.status}
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-slate-700">
                            {inv.riskLevel} ({inv.riskScore})
                          </td>
                          <td className="py-2.5 text-right">
                            <Link
                              to={`/invoices/${inv.id}`}
                              className="inline-flex items-center rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                            >
                              Open
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Bank Identifier Change Verification */}
            <section className="rounded-lg border border-slate-200 bg-white p-6">
              <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
                <Landmark className="h-4 w-4 text-slate-700" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Bank Change Verification
                </h3>
              </div>
              <p className="mt-2 text-xs text-slate-600">
                Current bank ID (masked):{' '}
                <span className="font-mono font-semibold text-slate-900">
                  {active.maskedBankIdentifier}
                </span>
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Any bank change requires maker-checker approval by a different Finance Manager before taking effect and is logged in the audit chain.
              </p>

              {active.pendingBankChanges.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-700" aria-hidden="true" />
                    Pending Bank Change Requests
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {active.pendingBankChanges.map((pb) => (
                      <li key={pb.approvalId} className="font-mono text-[11px]">
                        #{pb.approvalId}: {pb.oldBankMasked} → {pb.newBankMasked} (by{' '}
                        {pb.requestedByName})
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/approvals"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold underline"
                  >
                    Review in Approvals &amp; Guard
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              )}

              {bankFeedback && (
                <div
                  role="status"
                  className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                    bankFeedback.type === 'ok'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                      : 'border-rose-200 bg-rose-50 text-rose-900'
                  }`}
                >
                  {bankFeedback.type === 'ok' ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" aria-hidden="true" />
                  ) : (
                    <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-700" aria-hidden="true" />
                  )}
                  <span>{bankFeedback.text}</span>
                </div>
              )}

              {canRequestBankChange ? (
                <form onSubmit={(e) => void handleBankChangeSubmit(e)} className="mt-4 space-y-3">
                  <div>
                    <label
                      htmlFor="newBankIdentifier"
                      className="block text-xs font-medium text-slate-700"
                    >
                      New Bank Identifier
                    </label>
                    <input
                      id="newBankIdentifier"
                      type="text"
                      required
                      minLength={6}
                      placeholder="e.g. HDFC0009911-4455"
                      value={newBankId}
                      onChange={(e) => setNewBankId(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="bankChangeReason"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Verification Reason
                    </label>
                    <input
                      id="bankChangeReason"
                      type="text"
                      placeholder="Cancelled cheque verified by supplier onboarding"
                      value={bankReason}
                      onChange={(e) => setBankReason(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={bankSubmitting}
                    className="w-full rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                  >
                    {bankSubmitting ? 'Submitting Request...' : 'Request Bank Change Verification'}
                  </button>
                </form>
              ) : (
                <p className="mt-4 text-xs text-slate-500">
                  Only AP Employee, Procurement Employee, or Finance Manager can submit supplier bank change verification requests.
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
