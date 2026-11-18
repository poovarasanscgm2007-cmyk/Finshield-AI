import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileText,
  FolderSearch,
  MessageSquare,
  Paperclip,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import { UserRole } from '../auth/permissions.ts';
import { useAuth } from '../context/AuthContext.tsx';

interface InvestigationItem {
  id: number;
  invoice_id: number | null;
  invoice_number?: string | null;
  invoice_status?: string | null;
  invoice_risk_level?: string | null;
  invoice_itc_at_risk?: string | null;
  supplier_id: number | null;
  supplier_name?: string | null;
  issue_type: string;
  department: string;
  allowed_departments: string[];
  assigned_to: number | null;
  assigned_to_name?: string | null;
  assigned_to_role?: string | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'REVALIDATED' | 'REOPENED' | 'CLOSED';
  severity: string;
  title: string | null;
  description: string | null;
  evidence: Record<string, unknown>;
  resolution_notes: string | null;
  revalidation_summary: {
    outcome?: string;
    checkedAt?: string;
    reason?: string;
    remainingIssues?: string[];
  };
  last_revalidated_at: string | null;
  resolved_by_name?: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentItem {
  id: number;
  author_name?: string | null;
  author_role?: string | null;
  comment: string;
  status_from: string | null;
  status_to: string | null;
  created_at: string;
}

interface EvidenceItem {
  id: number;
  added_by_name?: string | null;
  evidence_type: 'NOTE' | 'FILE' | 'RECORD_LINK';
  note: string | null;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  created_at: string;
}

interface AssignableUser {
  id: number;
  name: string;
  role: UserRole;
  department: string;
}

interface DetailResponse {
  investigation: InvestigationItem;
  comments: CommentItem[];
  evidenceItems: EvidenceItem[];
  assignableUsers: AssignableUser[];
}

function getRoleDeptKeys(role: UserRole): string[] {
  switch (role) {
    case 'WAREHOUSE_EMPLOYEE':
      return ['WAREHOUSE'];
    case 'PROCUREMENT_EMPLOYEE':
      return ['PROCUREMENT'];
    case 'AP_EMPLOYEE':
      return ['AP'];
    case 'FINANCE_MANAGER':
      return ['FINANCE', 'COMPLIANCE'];
    default:
      return [];
  }
}

function canMutateClientCheck(
  userId: number,
  role: UserRole,
  inv: InvestigationItem | null
): boolean {
  if (!inv || role === 'ADMIN') return false;
  const keys = getRoleDeptKeys(role);
  const allowed = Array.isArray(inv.allowed_departments)
    ? inv.allowed_departments.map((d) => String(d).toUpperCase())
    : [];
  if (keys.some((k) => allowed.includes(k))) return true;
  const deptUpper = (inv.department || '').toUpperCase();
  if (keys.some((k) => deptUpper.includes(k))) return true;
  return inv.assigned_to !== null && Number(inv.assigned_to) === Number(userId);
}

export function InvestigationStatusTag({ status }: { status: string }) {
  const styles: Record<string, string> = {
    OPEN: 'border-amber-300 bg-amber-50 text-amber-900',
    IN_PROGRESS: 'border-sky-300 bg-sky-50 text-sky-900',
    RESOLVED: 'border-indigo-300 bg-indigo-50 text-indigo-900',
    REVALIDATED: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    REOPENED: 'border-rose-300 bg-rose-50 text-rose-900',
    CLOSED: 'border-slate-300 bg-slate-100 text-slate-700',
  };
  const cls = styles[status] || 'border-slate-300 bg-slate-50 text-slate-700';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs font-semibold whitespace-nowrap ${cls}`}
    >
      {status === 'REVALIDATED' ? (
        <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : status === 'REOPENED' ? (
        <RotateCcw className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : status === 'IN_PROGRESS' ? (
        <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      {status}
    </span>
  );
}

export function InvestigationsPage() {
  const { user, token, apiFetch } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [items, setItems] = useState<InvestigationItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [deptFilter, setDeptFilter] = useState<string>('ALL');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('ALL');

  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const q = searchParams.get('id');
    return q && Number(q) > 0 ? Number(q) : null;
  });
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [revalidationBanner, setRevalidationBanner] = useState<{
    outcome: 'REVALIDATED' | 'REOPENED' | null;
    reason: string | null;
    invoiceStatus: string | null;
  } | null>(null);

  // Forms
  const [statusComment, setStatusComment] = useState('');
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const [plainComment, setPlainComment] = useState('');
  const [postingComment, setPostingComment] = useState(false);

  const [evidenceNote, setEvidenceNote] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [attachingEvidence, setAttachingEvidence] = useState(false);

  const [reassignUserId, setReassignUserId] = useState<string>('');
  const [reassigning, setReassigning] = useState(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== 'ALL') qs.set('status', statusFilter);
      if (deptFilter !== 'ALL') qs.set('department', deptFilter);
      if (assigneeFilter !== 'ALL') qs.set('assignee', assigneeFilter);
      const queryStr = qs.toString();
      const res = await apiFetch<{ items: InvestigationItem[] }>(
        `/api/investigations${queryStr ? `?${queryStr}` : ''}`
      );
      setItems(res.items);

      if (res.items.length > 0) {
        const paramId = searchParams.get('id');
        const requested = paramId ? Number(paramId) : null;
        if (requested && res.items.some((i) => i.id === requested)) {
          setSelectedId(requested);
        } else if (!selectedId || !res.items.some((i) => i.id === selectedId)) {
          setSelectedId(res.items[0].id);
        }
      } else {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load investigations.');
    } finally {
      setLoadingList(false);
    }
  }, [apiFetch, statusFilter, deptFilter, assigneeFilter, searchParams, selectedId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(
    async (invId: number) => {
      setLoadingDetail(true);
      try {
        const res = await apiFetch<DetailResponse>(`/api/investigations/${invId}`);
        setDetail(res);
        setReassignUserId(
          res.investigation.assigned_to ? String(res.investigation.assigned_to) : ''
        );
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to load investigation detail.');
      } finally {
        setLoadingDetail(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    if (selectedId) {
      setActionError(null);
      setActionSuccess(null);
      setRevalidationBanner(null);
      void loadDetail(selectedId);
    }
  }, [selectedId, loadDetail]);

  function handleSelectInvestigation(invId: number) {
    setSelectedId(invId);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('id', String(invId));
      return next;
    });
  }

  async function handleStatusTransition(targetStatus: 'IN_PROGRESS' | 'RESOLVED') {
    if (!detail) return;
    setActionError(null);
    setActionSuccess(null);
    setRevalidationBanner(null);

    if (!statusComment.trim()) {
      setActionError('A comment is required before updating investigation status.');
      return;
    }

    setUpdatingStatus(true);
    try {
      const res = await apiFetch<{
        message: string;
        investigation: InvestigationItem;
        revalidation: {
          ran: boolean;
          outcome: 'REVALIDATED' | 'REOPENED' | null;
          reason: string | null;
          remainingIssues: string[];
        };
        invoiceStatus: string | null;
      }>(`/api/investigations/${detail.investigation.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({
          status: targetStatus,
          comment: statusComment.trim(),
        }),
      });

      setStatusComment('');
      setActionSuccess(res.message);
      if (res.revalidation.ran) {
        setRevalidationBanner({
          outcome: res.revalidation.outcome,
          reason: res.revalidation.reason,
          invoiceStatus: res.invoiceStatus,
        });
      }
      await Promise.all([loadList(), loadDetail(detail.investigation.id)]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update status.');
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleAddComment(e: FormEvent) {
    e.preventDefault();
    if (!detail || !plainComment.trim()) return;
    setActionError(null);
    setPostingComment(true);
    try {
      await apiFetch(`/api/investigations/${detail.investigation.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ comment: plainComment.trim() }),
      });
      setPlainComment('');
      await loadDetail(detail.investigation.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add comment.');
    } finally {
      setPostingComment(false);
    }
  }

  async function handleAttachEvidence(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    if (!evidenceFile && !evidenceNote.trim()) {
      setActionError('Provide a note or choose a file to attach as evidence.');
      return;
    }

    setActionError(null);
    setActionSuccess(null);
    setAttachingEvidence(true);

    try {
      if (evidenceFile) {
        const form = new FormData();
        form.append('file', evidenceFile);
        if (evidenceNote.trim()) {
          form.append('note', evidenceNote.trim());
        }
        const res = await fetch(`/api/investigations/${detail.investigation.id}/evidence`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (!res.ok) {
          throw new Error(data.error || data.message || `HTTP ${res.status}`);
        }
      } else {
        await apiFetch(`/api/investigations/${detail.investigation.id}/evidence`, {
          method: 'POST',
          body: JSON.stringify({ note: evidenceNote.trim() }),
        });
      }

      setEvidenceNote('');
      setEvidenceFile(null);
      setActionSuccess('Evidence attached and written to audit log.');
      await loadDetail(detail.investigation.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to attach evidence.');
    } finally {
      setAttachingEvidence(false);
    }
  }

  async function handleReassign(e: FormEvent) {
    e.preventDefault();
    if (!detail || !reassignUserId) return;
    setActionError(null);
    setActionSuccess(null);
    setReassigning(true);
    try {
      const res = await apiFetch<{ message: string }>(
        `/api/investigations/${detail.investigation.id}/assign`,
        {
          method: 'PUT',
          body: JSON.stringify({ assignedTo: Number(reassignUserId) }),
        }
      );
      setActionSuccess(res.message);
      await Promise.all([loadList(), loadDetail(detail.investigation.id)]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reassign investigation.');
    } finally {
      setReassigning(false);
    }
  }

  async function handleDownloadEvidence(ev: EvidenceItem) {
    if (!detail || !token) return;
    try {
      const res = await fetch(
        `/api/investigations/${detail.investigation.id}/evidence/${ev.id}/file`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = ev.original_filename || `evidence-${ev.id}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to download evidence file.');
    }
  }

  const uniqueAssignees = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of items) {
      if (item.assigned_to && item.assigned_to_name) {
        map.set(item.assigned_to, item.assigned_to_name);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [items]);

  if (!user) return null;

  const activeInv = detail?.investigation || null;
  const canMutate = canMutateClientCheck(user.id, user.role, activeInv);
  const canCommentOrEvidence =
    user.role === 'FINANCE_MANAGER' || canMutateClientCheck(user.id, user.role, activeInv);
  const poNumberFromEvidence =
    activeInv?.evidence && typeof activeInv.evidence.poNumber === 'string'
      ? activeInv.evidence.poNumber
      : '';

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div className="flex items-start gap-3">
            <FolderSearch className="mt-0.5 h-5 w-5 text-slate-700" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Investigation &amp; Resolution Center (Sample Data)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Every pipeline flag auto-assigns an investigation to the responsible department. Marking RESOLVED triggers full pipeline revalidation before an invoice can reach ELIGIBLE_FOR_APPROVAL.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadList()}
            disabled={loadingList}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        </div>

        {/* Filters */}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="statusFilter" className="block text-xs font-medium text-slate-600">
              Status Filter
            </label>
            <select
              id="statusFilter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="ALL">All Statuses</option>
              <option value="OPEN">OPEN</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="REOPENED">REOPENED</option>
              <option value="RESOLVED">RESOLVED</option>
              <option value="REVALIDATED">REVALIDATED</option>
            </select>
          </div>

          <div>
            <label htmlFor="deptFilter" className="block text-xs font-medium text-slate-600">
              Department Filter
            </label>
            <select
              id="deptFilter"
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="ALL">All Departments</option>
              <option value="WAREHOUSE">Warehouse</option>
              <option value="PROCUREMENT">Procurement</option>
              <option value="AP">AP</option>
              <option value="FINANCE">Finance</option>
              <option value="COMPLIANCE">Compliance</option>
            </select>
          </div>

          <div>
            <label htmlFor="assigneeFilter" className="block text-xs font-medium text-slate-600">
              Assignee Filter
            </label>
            <select
              id="assigneeFilter"
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="ALL">All Assignees</option>
              {uniqueAssignees.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {listError && (
          <div
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
          >
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
            <span>{listError}</span>
          </div>
        )}
      </section>

      {/* Master-Detail Grid */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left List */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 lg:col-span-5">
          <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2.5">
            <h3 className="text-sm font-semibold text-slate-900">
              Investigations ({items.length})
            </h3>
            <span className="text-xs text-slate-500">Click row to inspect</span>
          </div>

          {loadingList ? (
            <p className="py-6 text-sm text-slate-500">Loading investigations...</p>
          ) : items.length === 0 ? (
            <p className="py-6 text-sm text-slate-500">No investigations match these filters.</p>
          ) : (
            <div className="divide-y divide-slate-200">
              {items.map((inv) => {
                const isSelected = inv.id === selectedId;
                return (
                  <button
                    key={inv.id}
                    type="button"
                    onClick={() => handleSelectInvestigation(inv.id)}
                    className={`w-full px-3 py-3 text-left transition-colors ${
                      isSelected ? 'bg-slate-900/5 ring-1 ring-inset ring-slate-300' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-900">
                        #{inv.id} · {inv.issue_type}
                      </span>
                      <InvestigationStatusTag status={inv.status} />
                    </div>
                    <p className="mt-1 text-xs font-medium text-slate-700">
                      {inv.invoice_number || `Invoice #${inv.invoice_id}`} · {inv.department}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                      {inv.description || inv.title}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                      <span>Assignee: {inv.assigned_to_name || 'Unassigned'}</span>
                      <span className="font-mono font-semibold text-slate-700">
                        Priority: {inv.severity}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Right Detail Panel */}
        <section className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-7">
          {!selectedId ? (
            <p className="py-8 text-sm text-slate-500">
              Select an investigation from the list to view evidence, comments, and resolution actions.
            </p>
          ) : loadingDetail && !detail ? (
            <p className="py-8 text-sm text-slate-500">Loading investigation detail...</p>
          ) : activeInv ? (
            <div className="space-y-6">
              {/* Header */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-mono text-xs font-bold text-slate-900">
                      INV-CASE #{activeInv.id}
                    </span>
                    <InvestigationStatusTag status={activeInv.status} />
                    <span className="font-mono text-xs font-semibold text-slate-600">
                      Investigation Priority: {activeInv.severity}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-base font-semibold text-slate-900">
                    {activeInv.title || activeInv.issue_type}
                  </h3>
                  <p className="mt-1 text-sm text-slate-700">{activeInv.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>
                      Department:{' '}
                      <strong className="font-semibold text-slate-800">{activeInv.department}</strong>
                    </span>
                    <span>
                      Assignee:{' '}
                      <strong className="font-semibold text-slate-800">
                        {activeInv.assigned_to_name || 'Unassigned'}
                      </strong>
                    </span>
                    {activeInv.invoice_id && (
                      <Link
                        to={`/invoices/${activeInv.invoice_id}`}
                        className="inline-flex items-center gap-1 font-semibold text-slate-900 hover:underline"
                      >
                        Inspect {activeInv.invoice_number || `Invoice #${activeInv.invoice_id}`}
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                </div>
              </div>

              {actionError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
                  <span>{actionError}</span>
                </div>
              )}

              {actionSuccess && (
                <div
                  role="status"
                  className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                  <span>{actionSuccess}</span>
                </div>
              )}

              {/* Revalidation Result Banner */}
              {(revalidationBanner || activeInv.revalidation_summary?.outcome) && (
                <div
                  className={`rounded-lg border px-4 py-3 text-xs ${
                    (revalidationBanner?.outcome || activeInv.revalidation_summary?.outcome) ===
                    'REVALIDATED'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                      : 'border-rose-200 bg-rose-50 text-rose-900'
                  }`}
                >
                  <p className="font-semibold">
                    Pipeline Revalidation Outcome:{' '}
                    {revalidationBanner?.outcome || activeInv.revalidation_summary?.outcome}
                  </p>
                  <p className="mt-1">
                    {revalidationBanner?.reason || activeInv.revalidation_summary?.reason}
                  </p>
                  {revalidationBanner?.invoiceStatus && (
                    <p className="mt-1 font-mono font-semibold">
                      Updated Invoice Status: {revalidationBanner.invoiceStatus}
                    </p>
                  )}
                </div>
              )}

              {/* Quick Warehouse GRN Shortcut for Quantity Mismatch */}
              {activeInv.issue_type === 'QUANTITY_MISMATCH' &&
                activeInv.status !== 'REVALIDATED' &&
                user.role === 'WAREHOUSE_EMPLOYEE' && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="text-xs text-slate-700">
                      <p className="font-semibold text-slate-900">
                        Warehouse Quantity Verification Action
                      </p>
                      <p className="mt-0.5">
                        If missing goods have arrived or GRN quantity was under-recorded, submit a partial or corrected GRN before marking RESOLVED.
                      </p>
                    </div>
                    <Link
                      to={poNumberFromEvidence ? `/grns?poNumber=${encodeURIComponent(poNumberFromEvidence)}` : '/grns'}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
                    >
                      Open GRN Entry
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                )}

              {/* Finance Manager Reassignment */}
              {user.role === 'FINANCE_MANAGER' && (
                <form
                  onSubmit={(e) => void handleReassign(e)}
                  className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="min-w-[220px] flex-1">
                    <label
                      htmlFor="reassignSelect"
                      className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"
                    >
                      <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      Reassign Investigation (Finance Manager Only)
                    </label>
                    <select
                      id="reassignSelect"
                      value={reassignUserId}
                      onChange={(e) => setReassignUserId(e.target.value)}
                      className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                    >
                      <option value="">Select assignee...</option>
                      {detail?.assignableUsers.map((au) => (
                        <option key={au.id} value={String(au.id)}>
                          {au.name} ({au.role} · {au.department})
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="submit"
                    disabled={reassigning || !reassignUserId}
                    className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap"
                  >
                    {reassigning ? 'Reassigning...' : 'Reassign'}
                  </button>
                </form>
              )}

              {/* Evidence JSON Data */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Linked Evidence Payload
                </h4>
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
                  {JSON.stringify(activeInv.evidence, null, 2)}
                </pre>
              </div>

              {/* Status Transition Box */}
              {activeInv.status !== 'REVALIDATED' && activeInv.status !== 'CLOSED' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-slate-900">
                    Update Investigation Status (Mandatory Comment &amp; Revalidation)
                  </h4>

                  {!canMutate ? (
                    <div className="flex items-start gap-2 text-xs text-slate-600">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                      <span>
                        Read-only for {user.role}: only users in <strong>{activeInv.department}</strong> can transition this investigation.
                      </span>
                    </div>
                  ) : (
                    <>
                      <textarea
                        rows={2}
                        value={statusComment}
                        onChange={(e) => setStatusComment(e.target.value)}
                        placeholder="Enter verification explanation, GRN reference, or corrective action (required)..."
                        className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                      />
                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={updatingStatus}
                          onClick={() => void handleStatusTransition('IN_PROGRESS')}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60"
                        >
                          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                          Move to IN_PROGRESS
                        </button>
                        <button
                          type="button"
                          disabled={updatingStatus}
                          onClick={() => void handleStatusTransition('RESOLVED')}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {updatingStatus ? 'Revalidating...' : 'Mark RESOLVED & Revalidate'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Evidence Attachments */}
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                  <Paperclip className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />
                  Supporting Evidence ({detail?.evidenceItems.length || 0})
                </h4>

                {detail && detail.evidenceItems.length > 0 && (
                  <ul className="space-y-2">
                    {detail.evidenceItems.map((ev) => (
                      <li
                        key={ev.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                      >
                        <div>
                          <span className="font-mono font-semibold text-slate-800">
                            {ev.evidence_type}
                          </span>
                          {ev.original_filename && (
                            <span className="ml-2 font-medium text-slate-900">
                              <FileText className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                              {ev.original_filename}
                            </span>
                          )}
                          {ev.note && <p className="mt-0.5 text-slate-700">{ev.note}</p>}
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            Added by {ev.added_by_name || 'System'} ·{' '}
                            {new Date(ev.created_at).toLocaleString()}
                          </p>
                        </div>
                        {ev.original_filename && (
                          <button
                            type="button"
                            onClick={() => void handleDownloadEvidence(ev)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            <Download className="h-3 w-3" aria-hidden="true" />
                            Download
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {canCommentOrEvidence && (
                  <form onSubmit={(e) => void handleAttachEvidence(e)} className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={evidenceNote}
                        onChange={(e) => setEvidenceNote(e.target.value)}
                        placeholder="Evidence note (e.g. Delivery challan #DC-109 verified)..."
                        className="min-w-[200px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                      />
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.txt,.csv"
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setEvidenceFile(e.target.files?.[0] ?? null)
                        }
                        className="text-xs text-slate-600"
                      />
                      <button
                        type="submit"
                        disabled={attachingEvidence}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap"
                      >
                        {attachingEvidence ? 'Attaching...' : 'Attach Evidence'}
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Comments Timeline */}
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                  <MessageSquare className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />
                  Audit Discussion &amp; Status History ({detail?.comments.length || 0})
                </h4>

                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {detail?.comments.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="font-semibold text-slate-800">
                          {c.author_name || 'System Pipeline'}
                          {c.author_role ? ` (${c.author_role})` : ''}
                        </span>
                        <span className="font-mono tabular-nums">
                          {new Date(c.created_at).toLocaleString()}
                        </span>
                      </div>
                      {c.status_to && (
                        <p className="mt-0.5 font-mono text-[11px] font-semibold text-slate-700">
                          Transition: {c.status_from || 'NEW'} -&gt; {c.status_to}
                        </p>
                      )}
                      <p className="mt-1 text-slate-800">{c.comment}</p>
                    </div>
                  ))}
                </div>

                {canCommentOrEvidence && (
                  <form onSubmit={(e) => void handleAddComment(e)} className="flex gap-2">
                    <input
                      type="text"
                      value={plainComment}
                      onChange={(e) => setPlainComment(e.target.value)}
                      placeholder="Add an investigation comment..."
                      className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
                    />
                    <button
                      type="submit"
                      disabled={postingComment || !plainComment.trim()}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap"
                    >
                      {postingComment ? 'Posting...' : 'Post Comment'}
                    </button>
                  </form>
                )}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
