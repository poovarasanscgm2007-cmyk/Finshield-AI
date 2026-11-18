import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderSearch,
  GitCompare,
  PauseCircle,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { CopilotPanel } from '../components/CopilotPanel.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { InvestigationStatusTag } from './InvestigationsPage.tsx';
import { MatchAndStatusBadges } from './InvoicesPage.tsx';

interface FieldConfidenceDetail {
  value: unknown;
  confidence: number;
  missing: boolean;
  lowConfidence: boolean;
  optional?: boolean;
  status: 'OK' | 'LOW_CONFIDENCE' | 'MISSING';
}

interface InvoiceDetail {
  id: number;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  irn: string | null;
  supplier_name: string | null;
  supplier_name_extracted: string | null;
  supplier_gstin_extracted: string | null;
  po_number: string | null;
  po_reference_extracted: string | null;
  bank_identifier_extracted: string | null;
  invoice_date: string | null;
  subtotal: string | null;
  cgst: string | null;
  sgst: string | null;
  igst: string | null;
  total: string | null;
  status: string;
  extraction_source: string | null;
  extraction_method: string | null;
  raw_extracted_text: string | null;
  extraction_confidence: {
    threshold?: number;
    ocrConfidence?: number;
    extractionMethod?: string;
    extractionSource?: string;
    fields?: Record<string, FieldConfidenceDetail>;
    missingFields?: string[];
    lowConfidenceFields?: string[];
  } | null;
  original_extracted_data: Record<string, unknown> | null;
  verified_data: Record<string, unknown> | null;
  verified_by_name: string | null;
  verified_at: string | null;
  mime_type: string | null;
  original_filename: string | null;
  is_historical: boolean;
  is_sample_data: boolean;
  risk_score?: string;
  risk_level?: string;
  itc_at_risk?: string;
  level1_approved_by?: number | null;
  level1_approved_by_name?: string | null;
  level1_approved_at?: string | null;
  payment_approved_by?: number | null;
  payment_approved_by_name?: string | null;
  payment_approved_at?: string | null;
}

interface InvoiceLineRow {
  id?: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  lineTotal: string;
}

interface InvoiceDetailResponse {
  invoice: InvoiceDetail;
  lines: Array<{
    id: number;
    description: string;
    quantity: string;
    unit: string;
    unit_price: string;
    line_total: string;
  }>;
  hasFile: boolean;
  fileUrl: string | null;
}

interface ThreeWayComparisonCell {
  field: 'product' | 'quantity' | 'unit_price' | 'tax' | 'total';
  label: string;
  poValue: string;
  grnValue: string;
  invoiceValue: string;
  mismatch: boolean;
  reason: string | null;
}

interface MatchResultPayload {
  id: number;
  invoice_id: number;
  status: 'MATCHED' | 'MISMATCH' | 'HOLD';
  reasons: string[];
  qty_tolerance_percent: string;
  price_tolerance_percent: string;
  evaluated_at: string;
  compared_values: {
    poNumber: string | null;
    poStatus: string | null;
    grnCount: number;
    grns: Array<{
      grnNumber: string;
      receivedAt: string;
      quantityReceived: number;
      unit: string;
    }>;
    mismatchedFields: string[];
    cells: ThreeWayComparisonCell[];
  };
}

interface DuplicateDetectionResponse {
  invoiceId: number;
  invoiceNumber: string | null;
  normalizedInvoiceNumber: string | null;
  threshold: number;
  hasPossibleDuplicates: boolean;
  highestScore: number;
  possibleDuplicates: Array<{
    candidateInvoiceId: number;
    candidateInvoiceNumber: string | null;
    candidateNormalizedNumber: string | null;
    candidateSupplierName: string | null;
    candidateInvoiceDate: string | null;
    candidateTotal: number | null;
    candidateStatus: string;
    isHistorical: boolean;
    similarityScore: number;
    isPossibleDuplicate: boolean;
    reasons: string[];
  }>;
}

interface InvoiceRiskFlag {
  id: number;
  rule_code: string;
  severity: string;
  reason: string;
  score: string;
  created_at: string;
}

interface InvoiceInvestigationSummary {
  id: number;
  issue_type: string;
  department: string;
  status: string;
  severity: string;
  title: string | null;
  description: string | null;
  assigned_to_name: string | null;
  revalidation_summary?: { outcome?: string; reason?: string };
}

interface InvoiceInvestigationsResponse {
  invoiceId: number;
  riskSummary: {
    riskScore: number;
    riskLevel: string;
    itcAtRisk: number;
    flags: InvoiceRiskFlag[];
  };
  investigations: InvoiceInvestigationSummary[];
}

function normalizePreview(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-_]+/g, '') || '—';
}

function ConfidenceHint({ detail }: { detail?: FieldConfidenceDetail }) {
  if (!detail) {
    return <span className="font-mono text-xs text-slate-400">No score</span>;
  }
  const pct = Math.round((detail.confidence ?? 0) * 100);
  if (detail.missing || detail.status === 'MISSING') {
    return (
      <span className="font-mono text-xs font-semibold text-rose-700">
        MISSING · 0%
      </span>
    );
  }
  if (detail.lowConfidence || detail.status === 'LOW_CONFIDENCE') {
    return (
      <span className="font-mono text-xs font-semibold text-amber-700 tabular-nums">
        {pct}% · Low Confidence
      </span>
    );
  }
  return (
    <span className="font-mono text-xs font-medium text-emerald-700 tabular-nums">
      {pct}%
    </span>
  );
}

function getFieldInputBorderClass(detail?: FieldConfidenceDetail): string {
  if (!detail) return 'border-slate-300 bg-white';
  if (detail.missing || detail.status === 'MISSING') {
    return 'border-rose-300 bg-rose-50/40 focus:border-rose-500';
  }
  if (detail.lowConfidence || detail.status === 'LOW_CONFIDENCE') {
    return 'border-amber-300 bg-amber-50/40 focus:border-amber-500';
  }
  return 'border-slate-300 bg-white focus:border-slate-900';
}

export function InvoiceVerifyPage() {
  const { id } = useParams<{ id: string }>();
  const { user, token, apiFetch } = useAuth();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [hasFile, setHasFile] = useState<boolean>(false);
  const [fileBlobUrl, setFileBlobUrl] = useState<string | null>(null);

  const [matchResult, setMatchResult] = useState<MatchResultPayload | null>(null);
  const [runningMatch, setRunningMatch] = useState<boolean>(false);
  const [matchMessage, setMatchMessage] = useState<string | null>(null);

  const [duplicates, setDuplicates] = useState<DuplicateDetectionResponse | null>(null);
  const [issuesData, setIssuesData] = useState<InvoiceInvestigationsResponse | null>(null);
  const [activeTab, setActiveTab] = useState<'comparison' | 'issues'>('comparison');
  const [runningPipeline, setRunningPipeline] = useState<boolean>(false);
  const [approvalRemarks, setApprovalRemarks] = useState<string>('');
  const [approvingPayment, setApprovingPayment] = useState<boolean>(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);

  // Editable form fields
  const [supplierName, setSupplierName] = useState<string>('');
  const [supplierGstin, setSupplierGstin] = useState<string>('');
  const [invoiceNumber, setInvoiceNumber] = useState<string>('');
  const [invoiceDate, setInvoiceDate] = useState<string>('');
  const [poReference, setPoReference] = useState<string>('');
  const [irn, setIrn] = useState<string>('');
  const [bankIdentifier, setBankIdentifier] = useState<string>('');
  const [subtotal, setSubtotal] = useState<string>('');
  const [cgst, setCgst] = useState<string>('0');
  const [sgst, setSgst] = useState<string>('0');
  const [igst, setIgst] = useState<string>('0');
  const [total, setTotal] = useState<string>('');
  const [lines, setLines] = useState<InvoiceLineRow[]>([]);

  const [saving, setSaving] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveDiffCount, setSaveDiffCount] = useState<number | null>(null);

  const canVerify = user?.role === 'AP_EMPLOYEE';
  const canRunMatch = user?.role === 'AP_EMPLOYEE' || user?.role === 'FINANCE_MANAGER';
  const isFinanceManager = user?.role === 'FINANCE_MANAGER';

  const hydrateForm = useCallback((res: InvoiceDetailResponse) => {
    const inv = res.invoice;
    setInvoice(inv);
    setHasFile(res.hasFile);

    setSupplierName(inv.supplier_name_extracted || inv.supplier_name || '');
    setSupplierGstin(inv.supplier_gstin_extracted || '');
    setInvoiceNumber(inv.invoice_number || '');
    setInvoiceDate(inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '');
    setPoReference(inv.po_reference_extracted || inv.po_number || '');
    setIrn(inv.irn || '');
    setBankIdentifier(inv.bank_identifier_extracted || '');
    setSubtotal(inv.subtotal !== null ? String(inv.subtotal) : '');
    setCgst(inv.cgst !== null ? String(inv.cgst) : '0');
    setSgst(inv.sgst !== null ? String(inv.sgst) : '0');
    setIgst(inv.igst !== null ? String(inv.igst) : '0');
    setTotal(inv.total !== null ? String(inv.total) : '');
    setLines(
      res.lines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: String(l.quantity),
        unit: l.unit,
        unitPrice: String(l.unit_price),
        lineTotal: String(l.line_total),
      }))
    );
  }, []);

  const loadDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, matchRes, dupRes, invRes] = await Promise.all([
        apiFetch<InvoiceDetailResponse>(`/api/invoices/${id}`),
        apiFetch<{ hasMatchResult: boolean; matchResult: MatchResultPayload | null }>(
          `/api/invoices/${id}/match-result`
        ),
        apiFetch<DuplicateDetectionResponse>(`/api/invoices/${id}/duplicates`),
        apiFetch<InvoiceInvestigationsResponse>(`/api/invoices/${id}/investigations`),
      ]);
      hydrateForm(detailRes);
      setMatchResult(matchRes.matchResult);
      setDuplicates(dupRes);
      setIssuesData(invRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoice.');
    } finally {
      setLoading(false);
    }
  }, [id, apiFetch, hydrateForm]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    if (!id || !hasFile || !token) {
      setFileBlobUrl(null);
      return;
    }

    let active = true;
    let createdUrl: string | null = null;

    async function fetchPreview() {
      try {
        const res = await fetch(`/api/invoices/${id}/file`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const blob = await res.blob();
        createdUrl = URL.createObjectURL(blob);
        if (active) {
          setFileBlobUrl(createdUrl);
        } else {
          URL.revokeObjectURL(createdUrl);
        }
      } catch {
        // Ignore preview errors
      }
    }

    void fetchPreview();

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [id, hasFile, token]);

  const fieldConfidenceMap = useMemo(
    () => invoice?.extraction_confidence?.fields || {},
    [invoice]
  );

  async function handleRunMatch() {
    if (!id || !canRunMatch) return;
    setRunningMatch(true);
    setError(null);
    setMatchMessage(null);
    try {
      const res = await apiFetch<{
        message: string;
        matchResult: MatchResultPayload;
        invoiceStatus: string;
      }>(`/api/invoices/${id}/match`, { method: 'POST' });
      setMatchResult(res.matchResult);
      setMatchMessage(res.message);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run 3-way matching.');
    } finally {
      setRunningMatch(false);
    }
  }

  async function handleRunPipeline() {
    if (!id || !canRunMatch) return;
    setRunningPipeline(true);
    setError(null);
    setMatchMessage(null);
    try {
      const res = await apiFetch<{ message: string }>(`/api/invoices/${id}/run-pipeline`, {
        method: 'POST',
      });
      setMatchMessage(res.message);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute full risk pipeline.');
    } finally {
      setRunningPipeline(false);
    }
  }

  async function handleApprovePayment(level: 1 | 2) {
    if (!id) return;
    setApprovingPayment(true);
    setError(null);
    setPaymentMessage(null);
    try {
      const res = await apiFetch<{ message: string }>(`/api/invoices/${id}/approve-payment`, {
        method: 'POST',
        body: JSON.stringify({
          level,
          remarks: approvalRemarks.trim() || undefined,
        }),
      });
      setPaymentMessage(res.message);
      setApprovalRemarks('');
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment approval blocked.');
    } finally {
      setApprovingPayment(false);
    }
  }

  async function handleConfirmVerify(e: FormEvent) {
    e.preventDefault();
    if (!id || !canVerify) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    setSaveDiffCount(null);

    try {
      const toNumOrNull = (v: string): number | null => {
        const trimmed = v.trim();
        if (!trimmed) return null;
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : null;
      };

      const res = await apiFetch<{
        message: string;
        invoice: InvoiceDetail;
        lines: InvoiceDetailResponse['lines'];
        diff: Record<string, { before: unknown; after: unknown }>;
        matchResult: MatchResultPayload;
      }>(`/api/invoices/${id}/verify`, {
        method: 'PUT',
        body: JSON.stringify({
          supplierName: supplierName.trim() || null,
          supplierGstin: supplierGstin.trim().toUpperCase() || null,
          invoiceNumber: invoiceNumber.trim() || null,
          invoiceDate: invoiceDate.trim() || null,
          poReference: poReference.trim() || null,
          irn: irn.trim() || null,
          bankIdentifier: bankIdentifier.trim() || null,
          subtotal: toNumOrNull(subtotal),
          cgst: toNumOrNull(cgst) ?? 0,
          sgst: toNumOrNull(sgst) ?? 0,
          igst: toNumOrNull(igst) ?? 0,
          total: toNumOrNull(total),
          lineItems: lines.map((l) => {
            const qty = Number(l.quantity) || 0;
            const rate = Number(l.unitPrice) || 0;
            const amt = l.lineTotal.trim() ? Number(l.lineTotal) : Number((qty * rate).toFixed(2));
            return {
              description: l.description.trim() || 'Item',
              quantity: qty,
              unit: l.unit.trim() || 'kg',
              unitPrice: rate,
              lineTotal: Number.isFinite(amt) ? amt : 0,
            };
          }),
        }),
      });

      setSaveMessage(res.message);
      setSaveDiffCount(Object.keys(res.diff || {}).length);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify invoice.');
    } finally {
      setSaving(false);
    }
  }

  function updateLine(idx: number, patch: Partial<InvoiceLineRow>) {
    setLines((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const next = { ...row, ...patch };
        if (patch.quantity !== undefined || patch.unitPrice !== undefined) {
          const q = Number(next.quantity);
          const p = Number(next.unitPrice);
          if (Number.isFinite(q) && Number.isFinite(p)) {
            next.lineTotal = (q * p).toFixed(2);
          }
        }
        return next;
      })
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-sm text-slate-600">
        Loading invoice detail, 3-way matching &amp; duplicate analysis...
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="space-y-4">
        <Link
          to="/invoices"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Invoices
        </Link>
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {error || 'Invoice not found.'}
        </div>
      </div>
    );
  }

  const thresholdPct = Math.round((invoice.extraction_confidence?.threshold ?? 0.8) * 100);
  const ocrPct =
    invoice.extraction_confidence?.ocrConfidence !== undefined
      ? Math.round(invoice.extraction_confidence.ocrConfidence * 100)
      : null;

  const isPdf =
    invoice.mime_type === 'application/pdf' ||
    (invoice.original_filename || '').toLowerCase().endsWith('.pdf');

  const cells = matchResult?.compared_values?.cells || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            to="/invoices"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            All Invoices
          </Link>
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {invoice.invoice_number || `Invoice #${invoice.id}`}
              <span className="ml-2 font-mono text-xs font-normal text-slate-500">
                (Sample Data)
              </span>
            </h2>
            <p className="text-xs text-slate-500">
              Invoice Status: <span className="font-mono font-semibold text-slate-800">{invoice.status}</span>
              {invoice.verified_by_name && ` · Verified by ${invoice.verified_by_name}`}
            </p>
          </div>
          <MatchAndStatusBadges
            invoiceStatus={invoice.status}
            matchStatus={matchResult?.status}
            possibleDuplicate={duplicates?.hasPossibleDuplicates}
            duplicateScore={duplicates?.highestScore}
          />
        </div>

        <div className="flex items-center gap-3">
          {canRunMatch && (
            <button
              type="button"
              onClick={() => void handleRunMatch()}
              disabled={runningMatch}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {runningMatch ? 'Matching...' : 'Run 3-Way Match'}
            </button>
          )}
          {fileBlobUrl && (
            <a
              href={fileBlobUrl}
              download={invoice.original_filename || `invoice-${invoice.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download Original
            </a>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {matchMessage && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900"
        >
          <GitCompare className="mt-0.5 h-4 w-4 shrink-0 text-slate-700" aria-hidden="true" />
          <span>{matchMessage}</span>
        </div>
      )}

      {paymentMessage && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>{paymentMessage}</span>
        </div>
      )}

      {saveMessage && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>
            {saveMessage}
            {saveDiffCount !== null
              ? ` (${saveDiffCount} field change${saveDiffCount === 1 ? '' : 's'} logged to audit trail)`
              : ''}
          </span>
        </div>
      )}

      {/* Payment Gate & Multi-Level Human Approval Banner */}
      {(() => {
        const riskLevel = issuesData?.riskSummary.riskLevel || invoice.risk_level || 'LOW';
        const riskScore = issuesData?.riskSummary.riskScore ?? Number(invoice.risk_score || 0);
        const itcRisk = issuesData?.riskSummary.itcAtRisk ?? Number(invoice.itc_at_risk || 0);
        const invList = issuesData?.investigations || [];
        const pendingInvs = invList.filter((i) => i.status !== 'REVALIDATED');
        const isHighRisk = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';
        const isFinalApproved = invoice.status === 'APPROVED' || invoice.status === 'PAID';
        const isEligible = invoice.status === 'ELIGIBLE_FOR_APPROVAL';

        return (
          <section
            aria-label="Payment Gate and Investigation Priority"
            className="rounded-lg border border-slate-200 bg-white p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold text-slate-900">
                    <ShieldCheck className="h-4 w-4 text-slate-700" aria-hidden="true" />
                    Payment Gate Status: {invoice.status}
                  </span>
                  <span
                    className={`font-mono text-xs font-semibold ${
                      isHighRisk ? 'text-rose-700' : 'text-slate-700'
                    }`}
                  >
                    Investigation Priority: {riskLevel} ({riskScore}/100)
                  </span>
                  <span className="font-mono text-xs font-semibold text-slate-800 tabular-nums">
                    ITC at Risk: Rs {itcRisk.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Risk scores reflect investigation priority only (not proof of fraud). Payment approval is strictly a human decision after every investigation is REVALIDATED.
                </p>
              </div>

              {canRunMatch && (
                <button
                  type="button"
                  onClick={() => void handleRunPipeline()}
                  disabled={runningPipeline}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  {runningPipeline ? 'Running Pipeline...' : 'Run Full Pipeline'}
                </button>
              )}
            </div>

            {isFinalApproved ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
                <span className="font-semibold">
                  Human Payment Approved{invoice.payment_approved_by_name ? ` by ${invoice.payment_approved_by_name}` : ''}
                </span>
                {invoice.level1_approved_by_name && (
                  <span className="ml-2">
                    · Level 1 sign-off by {invoice.level1_approved_by_name}
                  </span>
                )}
              </div>
            ) : pendingInvs.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-900">
                <span>
                  Payment blocked: {pendingInvs.length} investigation(s) must reach REVALIDATED before this invoice becomes ELIGIBLE_FOR_APPROVAL.
                </span>
                <button
                  type="button"
                  onClick={() => setActiveTab('issues')}
                  className="font-semibold underline hover:text-rose-950"
                >
                  Inspect {pendingInvs.length} Issue(s)
                </button>
              </div>
            ) : isEligible ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50/70 p-4 space-y-3">
                <div className="text-xs text-emerald-950">
                  <p className="font-semibold">
                    Invoice is ELIGIBLE_FOR_APPROVAL (all investigations revalidated &amp; 3-way match passed).
                  </p>
                  {isHighRisk && (
                    <p className="mt-1">
                      Multi-level approval active ({riskLevel} priority): requires 2 different human approvers (Level 1 reviewer + Finance Manager final approval).
                      {invoice.level1_approved_by_name && (
                        <strong className="ml-1">
                          Level 1 completed by {invoice.level1_approved_by_name}.
                        </strong>
                      )}
                    </p>
                  )}
                </div>

                {user?.role !== 'ADMIN' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="text"
                      value={approvalRemarks}
                      onChange={(e) => setApprovalRemarks(e.target.value)}
                      placeholder="Approval remarks (optional)..."
                      className="min-w-[220px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                    />
                    {isHighRisk && !invoice.level1_approved_by && (
                      <button
                        type="button"
                        disabled={approvingPayment}
                        onClick={() => void handleApprovePayment(1)}
                        className="rounded-lg border border-slate-900 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap"
                      >
                        {approvingPayment ? 'Submitting...' : 'Level 1 Risk Sign-Off'}
                      </button>
                    )}
                    {isFinanceManager && (!isHighRisk || Boolean(invoice.level1_approved_by)) && (
                      <button
                        type="button"
                        disabled={approvingPayment}
                        onClick={() => void handleApprovePayment(2)}
                        className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
                      >
                        {approvingPayment ? 'Approving...' : 'Approve Final Payment (Finance Manager)'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </section>
        );
      })()}

      {/* Section Tabs: Comparison & Verification vs Issues */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setActiveTab('comparison')}
          className={`border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
            activeTab === 'comparison'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          3-Way Match &amp; Document Verification
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('issues')}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
            activeTab === 'issues'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <FolderSearch className="h-4 w-4" aria-hidden="true" />
          Issues &amp; Risk Flags ({issuesData?.investigations.length || 0})
        </button>
      </div>

      {activeTab === 'issues' ? (
        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Linked Investigations ({issuesData?.investigations.length || 0})
                </h3>
                <p className="text-xs text-slate-500">
                  Auto-routed by department rule. Resolve and revalidate each issue in Investigation Center.
                </p>
              </div>
              <Link
                to="/investigations"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Open Investigation Center
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>

            {!issuesData || issuesData.investigations.length === 0 ? (
              <p className="py-4 text-sm text-slate-600">
                No investigations have been created for this invoice.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-3">ID</th>
                      <th className="py-2 pr-3">Issue Type</th>
                      <th className="py-2 pr-3">Department</th>
                      <th className="py-2 pr-3">Assignee</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Summary</th>
                      <th className="py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {issuesData.investigations.map((invItem) => (
                      <tr key={invItem.id} className="hover:bg-slate-50">
                        <td className="py-3 pr-3 font-mono font-semibold text-slate-900">
                          #{invItem.id}
                        </td>
                        <td className="py-3 pr-3 font-mono font-semibold text-slate-800">
                          {invItem.issue_type}
                        </td>
                        <td className="py-3 pr-3 text-slate-700">{invItem.department}</td>
                        <td className="py-3 pr-3 text-slate-700">
                          {invItem.assigned_to_name || 'Unassigned'}
                        </td>
                        <td className="py-3 pr-3">
                          <InvestigationStatusTag status={invItem.status} />
                        </td>
                        <td className="py-3 pr-3 text-slate-700">{invItem.description}</td>
                        <td className="py-3 text-right">
                          <Link
                            to={`/investigations?id=${invItem.id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                          >
                            Investigate
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Explainable Risk Flags ({issuesData?.riskSummary.flags.length || 0})
              </h3>
              <p className="text-xs text-slate-500">
                Deterministic rule-weighted signals contributing to investigation priority ({issuesData?.riskSummary.riskScore ?? 0}/100).
              </p>
            </div>
            {!issuesData || issuesData.riskSummary.flags.length === 0 ? (
              <p className="text-sm text-slate-600">No active unresolved risk flags.</p>
            ) : (
              <ul className="space-y-2">
                {issuesData.riskSummary.flags.map((flag) => (
                  <li
                    key={flag.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs"
                  >
                    <div>
                      <span className="font-mono font-semibold text-slate-900">
                        {flag.rule_code}
                      </span>
                      <span className="ml-2 font-mono text-slate-600">
                        ({flag.severity} · +{flag.score} pts)
                      </span>
                      <p className="mt-1 text-slate-700">{flag.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <>

      {/* 3-Way Matching Panel: PO vs GRN vs Invoice Side-by-Side */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-2.5">
            <GitCompare className="h-5 w-5 text-slate-700" aria-hidden="true" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                3-Way Matching Comparison (PO vs GRN vs Invoice)
              </h3>
              <p className="text-xs text-slate-500">
                {matchResult
                  ? `Tolerance: ±${matchResult.qty_tolerance_percent}% qty · ±${matchResult.price_tolerance_percent}% price · Evaluated ${new Date(
                      matchResult.evaluated_at
                    ).toLocaleString()}`
                  : 'Run 3-way matching to compare PO, summed GRNs, and Invoice values.'}
              </p>
            </div>
          </div>

          {matchResult && (
            <div className="flex items-center gap-3">
              {matchResult.status === 'MATCHED' ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  MATCHED
                </span>
              ) : matchResult.status === 'MISMATCH' ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-800">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  MISMATCH · ON_HOLD
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                  <PauseCircle className="h-4 w-4" aria-hidden="true" />
                  HOLD · ON_HOLD
                </span>
              )}
            </div>
          )}
        </div>

        {!matchResult ? (
          <div className="py-6 text-sm text-slate-600">
            No 3-way match evaluation has been stored for this invoice yet.
            {canRunMatch && ' Click "Run 3-Way Match" above or verify the extracted invoice fields to run automatically.'}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 pr-4">Field</th>
                    <th className="py-2.5 px-3">
                      Purchase Order ({matchResult.compared_values.poNumber || 'None'})
                    </th>
                    <th className="py-2.5 px-3">
                      Goods Receipt ({matchResult.compared_values.grnCount} GRN
                      {matchResult.compared_values.grnCount === 1 ? '' : 's'})
                    </th>
                    <th className="py-2.5 pl-3">
                      Invoice ({invoice.invoice_number || `#${invoice.id}`})
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {cells.map((cell) => {
                    const cellHighlight = cell.mismatch
                      ? 'bg-rose-50 text-rose-900 font-semibold border border-rose-200'
                      : 'text-slate-800';

                    return (
                      <tr key={cell.field}>
                        <td className="py-3 pr-4 text-xs font-semibold text-slate-700">
                          {cell.label}
                        </td>
                        <td className={`py-3 px-3 font-mono text-xs tabular-nums ${cell.mismatch ? 'bg-rose-50/70 text-rose-900' : 'text-slate-700'}`}>
                          {cell.poValue}
                        </td>
                        <td className={`py-3 px-3 font-mono text-xs tabular-nums ${cell.mismatch && cell.field === 'quantity' ? 'bg-rose-50 text-rose-900 font-semibold' : 'text-slate-700'}`}>
                          {cell.grnValue}
                        </td>
                        <td className={`py-3 pl-3 font-mono text-xs tabular-nums ${cellHighlight}`}>
                          {cell.invoiceValue}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {matchResult.compared_values.grns && matchResult.compared_values.grns.length > 0 && (
              <div className="text-xs text-slate-600">
                <span className="font-semibold text-slate-700">GRN Receipts Aggregated: </span>
                {matchResult.compared_values.grns
                  .map(
                    (g) =>
                      `${g.grnNumber} (${g.quantityReceived} ${g.unit} on ${new Date(
                        g.receivedAt
                      ).toLocaleDateString()})`
                  )
                  .join(' + ')}
              </div>
            )}

            {/* Exact match / mismatch reasons below */}
            <div
              className={`rounded-md border px-4 py-3 text-sm ${
                matchResult.status === 'MATCHED'
                  ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900'
                  : matchResult.status === 'MISMATCH'
                  ? 'border-rose-200 bg-rose-50/80 text-rose-900'
                  : 'border-amber-200 bg-amber-50/80 text-amber-900'
              }`}
            >
              <p className="text-xs font-semibold">
                {matchResult.status === 'MATCHED'
                  ? '3-Way Match Result: MATCHED (Human payment approval still required separately)'
                  : `3-Way Match Reasons (${matchResult.status} — Invoice placed ON_HOLD; payment never auto-released):`}
              </p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs">
                {matchResult.reasons.map((r, idx) => (
                  <li key={idx}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      {/* Duplicate Detection Panel */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-2.5">
            <Copy className="h-5 w-5 text-slate-700" aria-hidden="true" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Duplicate Invoice Detection
              </h3>
              <p className="text-xs text-slate-500">
                Normalized Number:{' '}
                <span className="font-mono font-semibold text-slate-700">
                  {duplicates?.normalizedInvoiceNumber || invoice.normalized_invoice_number || '—'}
                </span>{' '}
                · Threshold:{' '}
                <span className="font-mono tabular-nums">
                  {duplicates ? `${Math.round(duplicates.threshold * 100)}%` : '65%'}
                </span>{' '}
                · Never auto-rejects (human decision required)
              </p>
            </div>
          </div>

          {duplicates?.hasPossibleDuplicates ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-orange-300 bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-800">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              POSSIBLE DUPLICATE · {Math.round(duplicates.highestScore * 100)}% Similarity
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              No High-Similarity Duplicates Found
            </span>
          )}
        </div>

        {!duplicates || !duplicates.hasPossibleDuplicates ? (
          <p className="pt-4 text-sm text-slate-600">
            No existing invoices exceeded the duplicate similarity threshold across normalized invoice number, supplier, date, amount, line items, and IRN.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-3">Candidate Invoice</th>
                  <th className="py-2 pr-3">Supplier</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3 text-right">Total</th>
                  <th className="py-2 pr-3 text-right">Similarity</th>
                  <th className="py-2 pr-3">Reasons</th>
                  <th className="py-2 text-right">Compare</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {duplicates.possibleDuplicates.map((cand) => (
                  <tr key={cand.candidateInvoiceId}>
                    <td className="py-3 pr-3 font-mono font-semibold text-slate-900">
                      {cand.candidateInvoiceNumber || `#${cand.candidateInvoiceId}`}
                      <span className="block font-sans text-xs font-normal text-slate-500">
                        Normalized: {cand.candidateNormalizedNumber || '—'}
                      </span>
                    </td>
                    <td className="py-3 pr-3 text-slate-700">
                      {cand.candidateSupplierName || 'Unknown'}
                    </td>
                    <td className="py-3 pr-3 font-mono text-slate-600 tabular-nums">
                      {cand.candidateInvoiceDate || '—'}
                    </td>
                    <td className="py-3 pr-3 text-right font-mono font-medium text-slate-900 tabular-nums">
                      {cand.candidateTotal !== null ? `Rs ${cand.candidateTotal.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-3 pr-3 text-right font-mono font-bold text-orange-700 tabular-nums">
                      {Math.round(cand.similarityScore * 100)}%
                    </td>
                    <td className="py-3 pr-3 text-slate-700">
                      <ul className="list-disc space-y-0.5 pl-4">
                        {cand.reasons.map((reason, idx) => (
                          <li key={idx}>{reason}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="py-3 text-right">
                      <Link
                        to={`/invoices/${cand.candidateInvoiceId}`}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                      >
                        View #{cand.candidateInvoiceId}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Split View: Original Document Preview + Extracted Fields Verification */}
      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col rounded-lg border border-slate-200 bg-white lg:col-span-5">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-slate-600" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-900">
                Original Document Preview
              </h3>
            </div>
            <span className="max-w-[180px] truncate font-mono text-xs text-slate-500">
              {invoice.original_filename || (invoice.is_historical ? 'Seeded sample record' : 'Document')}
            </span>
          </div>

          <div className="flex-1 p-4">
            {fileBlobUrl ? (
              isPdf ? (
                <iframe
                  title="Invoice PDF preview"
                  src={fileBlobUrl}
                  className="h-[640px] w-full rounded-md border border-slate-200 bg-slate-100"
                />
              ) : (
                <div className="flex max-h-[640px] items-start justify-center overflow-auto rounded-md border border-slate-200 bg-slate-100 p-2">
                  <img
                    src={fileBlobUrl}
                    alt={invoice.original_filename || 'Uploaded invoice preview'}
                    className="max-w-full rounded-xs object-contain"
                  />
                </div>
              )
            ) : (
              <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-6 text-center">
                <FileText className="h-7 w-7 text-slate-400" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-slate-700">
                  No uploaded binary preview available
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Seeded sample records do not include a separate uploaded PDF on disk.
                  Upload a PDF, PNG, or JPG from the Invoices page to view OCR side-by-side.
                </p>
              </div>
            )}

            {invoice.raw_extracted_text && (
              <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                  View Raw OCR / PDF Extracted Text
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-600">
                  {invoice.raw_extracted_text}
                </pre>
              </details>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white lg:col-span-7">
          <div className="border-b border-slate-200 bg-amber-50/70 px-5 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-amber-900">
                <Sparkles className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <span className="text-sm font-semibold">
                  AI-extracted, please verify
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-xs text-amber-900 tabular-nums">
                <span>Source: {invoice.extraction_source || 'SEED'}</span>
                <span>Method: {invoice.extraction_method || 'DB'}</span>
                {ocrPct !== null && <span>OCR: {ocrPct}%</span>}
                <span>Threshold: {thresholdPct}%</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-amber-800">
              Confirming verification saves corrected fields and automatically runs 3-way matching against PO &amp; GRNs.
            </p>
          </div>

          <form onSubmit={(e) => void handleConfirmVerify(e)} className="space-y-6 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="supplierName" className="text-xs font-medium text-slate-700">
                    Supplier Name
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.supplier_name} />
                </div>
                <input
                  id="supplierName"
                  type="text"
                  disabled={!canVerify}
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  className={`mt-1.5 block w-full rounded-lg border px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.supplier_name
                  )}`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="supplierGstin" className="text-xs font-medium text-slate-700">
                    Supplier GSTIN
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.supplier_gstin} />
                </div>
                <input
                  id="supplierGstin"
                  type="text"
                  disabled={!canVerify}
                  value={supplierGstin}
                  onChange={(e) => setSupplierGstin(e.target.value)}
                  placeholder="15-character GSTIN"
                  className={`mt-1.5 block w-full rounded-lg border px-3 py-2 font-mono text-sm uppercase text-slate-900 disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.supplier_gstin
                  )}`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="invoiceNumber" className="text-xs font-medium text-slate-700">
                    Invoice Number
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.invoice_number} />
                </div>
                <input
                  id="invoiceNumber"
                  type="text"
                  disabled={!canVerify}
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className={`mt-1.5 block w-full rounded-lg border px-3 py-2 font-mono text-sm text-slate-900 disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.invoice_number
                  )}`}
                />
                <p className="mt-1 font-mono text-xs text-slate-500">
                  Normalized: {normalizePreview(invoiceNumber)}
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="invoiceDate" className="text-xs font-medium text-slate-700">
                    Invoice Date (YYYY-MM-DD)
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.invoice_date} />
                </div>
                <input
                  id="invoiceDate"
                  type="date"
                  disabled={!canVerify}
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className={`mt-1.5 block w-full rounded-lg border px-3 py-2 font-mono text-sm text-slate-900 disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.invoice_date
                  )}`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="poReference" className="text-xs font-medium text-slate-700">
                    PO Reference
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.po_reference} />
                </div>
                <input
                  id="poReference"
                  type="text"
                  disabled={!canVerify}
                  value={poReference}
                  onChange={(e) => setPoReference(e.target.value)}
                  className={`mt-1.5 block w-full rounded-lg border px-3 py-2 font-mono text-sm text-slate-900 disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.po_reference
                  )}`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="irn" className="text-xs font-medium text-slate-700">
                    e-Invoice IRN (Optional)
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.irn} />
                </div>
                <input
                  id="irn"
                  type="text"
                  disabled={!canVerify}
                  value={irn}
                  onChange={(e) => setIrn(e.target.value)}
                  placeholder="Optional IRN"
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 disabled:bg-slate-50"
                />
              </div>

              <div className="sm:col-span-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="bankIdentifier" className="text-xs font-medium text-slate-700">
                    Bank Identifier (Optional)
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.bank_identifier} />
                </div>
                <input
                  id="bankIdentifier"
                  type="text"
                  disabled={!canVerify}
                  value={bankIdentifier}
                  onChange={(e) => setBankIdentifier(e.target.value)}
                  placeholder="IFSC / Bank account identifier if present"
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 disabled:bg-slate-50"
                />
              </div>
            </div>

            {/* Line Items Table */}
            <div className="border-t border-slate-200 pt-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">Line Items</h3>
                  <ConfidenceHint detail={fieldConfidenceMap.line_items} />
                </div>
                {canVerify && (
                  <button
                    type="button"
                    onClick={() =>
                      setLines((prev) => [
                        ...prev,
                        {
                          description: '',
                          quantity: '1',
                          unit: 'kg',
                          unitPrice: '0',
                          lineTotal: '0.00',
                        },
                      ])
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add Line
                  </button>
                )}
              </div>

              {lines.length === 0 ? (
                <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  No line items were extracted. Add line items manually before confirming verification.
                </p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2 pr-2">Description</th>
                        <th className="w-20 py-2 pr-2">Qty</th>
                        <th className="w-20 py-2 pr-2">Unit</th>
                        <th className="w-28 py-2 pr-2">Unit Price</th>
                        <th className="w-28 py-2 pr-2">Line Total</th>
                        {canVerify && <th className="w-8 py-2" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {lines.map((row, idx) => (
                        <tr key={idx}>
                          <td className="py-2 pr-2">
                            <input
                              type="text"
                              disabled={!canVerify}
                              value={row.description}
                              onChange={(e) => updateLine(idx, { description: e.target.value })}
                              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 disabled:bg-slate-50"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <input
                              type="number"
                              step="0.01"
                              disabled={!canVerify}
                              value={row.quantity}
                              onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-900 tabular-nums disabled:bg-slate-50"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <input
                              type="text"
                              disabled={!canVerify}
                              value={row.unit}
                              onChange={(e) => updateLine(idx, { unit: e.target.value })}
                              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 disabled:bg-slate-50"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <input
                              type="number"
                              step="0.01"
                              disabled={!canVerify}
                              value={row.unitPrice}
                              onChange={(e) => updateLine(idx, { unitPrice: e.target.value })}
                              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-900 tabular-nums disabled:bg-slate-50"
                            />
                          </td>
                          <td className="py-2 pr-2">
                            <input
                              type="number"
                              step="0.01"
                              disabled={!canVerify}
                              value={row.lineTotal}
                              onChange={(e) => updateLine(idx, { lineTotal: e.target.value })}
                              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-900 tabular-nums disabled:bg-slate-50"
                            />
                          </td>
                          {canVerify && (
                            <td className="py-2 text-right">
                              <button
                                type="button"
                                aria-label="Remove line item"
                                onClick={() =>
                                  setLines((prev) => prev.filter((_, i) => i !== idx))
                                }
                                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Totals & Taxes */}
            <div className="grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label htmlFor="subtotal" className="text-xs font-medium text-slate-700">
                    Subtotal
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.subtotal} />
                </div>
                <input
                  id="subtotal"
                  type="number"
                  step="0.01"
                  disabled={!canVerify}
                  value={subtotal}
                  onChange={(e) => setSubtotal(e.target.value)}
                  className={`mt-1.5 block w-full rounded-lg border px-2.5 py-2 font-mono text-sm text-slate-900 tabular-nums disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.subtotal
                  )}`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-1">
                  <label htmlFor="cgst" className="text-xs font-medium text-slate-700">
                    CGST
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.cgst} />
                </div>
                <input
                  id="cgst"
                  type="number"
                  step="0.01"
                  disabled={!canVerify}
                  value={cgst}
                  onChange={(e) => setCgst(e.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 font-mono text-sm text-slate-900 tabular-nums disabled:bg-slate-50"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-1">
                  <label htmlFor="sgst" className="text-xs font-medium text-slate-700">
                    SGST
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.sgst} />
                </div>
                <input
                  id="sgst"
                  type="number"
                  step="0.01"
                  disabled={!canVerify}
                  value={sgst}
                  onChange={(e) => setSgst(e.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 font-mono text-sm text-slate-900 tabular-nums disabled:bg-slate-50"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-1">
                  <label htmlFor="igst" className="text-xs font-medium text-slate-700">
                    IGST
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.igst} />
                </div>
                <input
                  id="igst"
                  type="number"
                  step="0.01"
                  disabled={!canVerify}
                  value={igst}
                  onChange={(e) => setIgst(e.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 font-mono text-sm text-slate-900 tabular-nums disabled:bg-slate-50"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-1">
                  <label htmlFor="total" className="text-xs font-medium text-slate-700">
                    Total
                  </label>
                  <ConfidenceHint detail={fieldConfidenceMap.total} />
                </div>
                <input
                  id="total"
                  type="number"
                  step="0.01"
                  disabled={!canVerify}
                  value={total}
                  onChange={(e) => setTotal(e.target.value)}
                  className={`mt-1.5 block w-full rounded-lg border px-2.5 py-2 font-mono text-sm font-semibold text-slate-900 tabular-nums disabled:bg-slate-50 ${getFieldInputBorderClass(
                    fieldConfidenceMap.total
                  )}`}
                />
              </div>
            </div>

            {invoice.original_extracted_data && (
              <details className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                  Original Extracted Snapshot (Preserved for Audit Diff)
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-600">
                  {JSON.stringify(invoice.original_extracted_data, null, 2)}
                </pre>
              </details>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-4">
              {!canVerify ? (
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
                  <span>View-only verification form: only AP Employee can confirm extracted fields.</span>
                </div>
              ) : (
                <span className="text-xs text-slate-500">
                  Confirming saves corrected fields, logs the diff, and auto-runs 3-way matching.
                </span>
              )}

              {canVerify && (
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  {saving ? 'Verifying & Matching...' : 'Confirm, Verify & Match'}
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
        </>
      )}

      {/* AI Audit Copilot scoped to this invoice */}
      <CopilotPanel invoiceId={invoice.id} invoiceNumber={invoice.invoice_number} />
    </div>
  );
}
