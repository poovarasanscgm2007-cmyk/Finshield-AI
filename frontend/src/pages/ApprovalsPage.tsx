import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FileWarning, RefreshCw, ShieldAlert } from 'lucide-react';
import { ROLE_LABELS } from '../auth/permissions.ts';
import { useAuth } from '../context/AuthContext.tsx';

interface ApprovalItem {
  id: number;
  entity_type: string;
  entity_id: number;
  approval_level: number;
  requested_by: number;
  requested_by_name: string;
  requested_by_role: string;
  approved_by: number | null;
  approved_by_name: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  remarks: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  decided_at: string | null;
}

interface PurchaseOrderSummary {
  id: number;
  po_number: string;
  supplier_name: string;
  current_total: string;
  status: string;
}

interface UnapprovedChange {
  id: number;
  po_number: string;
  field: string;
  old_value: string;
  new_value: string;
  changed_by_name: string;
  changed_by_code: string;
  changed_at: string;
  status: string;
  approval_id: number | null;
  reason: string | null;
}

export function ApprovalsPage() {
  const { user, apiFetch } = useAuth();
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [loading, setLoading] = useState<boolean>(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Procurement PO price change request state
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderSummary[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<number>(1);
  const [newUnitPrice, setNewUnitPrice] = useState<string>('700');
  const [priceReason, setPriceReason] = useState<string>(
    'Supplier timber rate adjustment request'
  );
  const [submittingPoChange, setSubmittingPoChange] = useState<boolean>(false);

  // Unapproved PO changes list (Procurement / Finance Manager / Admin)
  const [unapprovedChanges, setUnapprovedChanges] = useState<UnapprovedChange[]>([]);

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const qs = statusFilter !== 'ALL' ? `?status=${statusFilter}` : '';
      const approvalsRes = await apiFetch<{ items: ApprovalItem[] }>(`/api/approvals${qs}`);
      setApprovals(approvalsRes.items);

      if (
        user.role === 'PROCUREMENT_EMPLOYEE' ||
        user.role === 'FINANCE_MANAGER' ||
        user.role === 'ADMIN'
      ) {
        const [poRes, unapprovedRes] = await Promise.all([
          apiFetch<{ purchaseOrders: PurchaseOrderSummary[] }>('/api/purchase-orders'),
          apiFetch<{ items: UnapprovedChange[] }>('/api/purchase-orders/unapproved-changes'),
        ]);
        setPurchaseOrders(poRes.purchaseOrders);
        if (poRes.purchaseOrders.length > 0) {
          setSelectedPoId((prev) => prev || poRes.purchaseOrders[0].id);
        }
        setUnapprovedChanges(unapprovedRes.items);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to load approvals.');
    } finally {
      setLoading(false);
    }
  }, [user, statusFilter, apiFetch]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleApprove(approvalId: number) {
    setActionError(null);
    setActionSuccess(null);
    setBusyId(approvalId);
    try {
      const res = await apiFetch<{ message: string }>(`/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ remarks: 'Approved via FINSHIELD GUARD' }),
      });
      setActionSuccess(res.message);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approval blocked.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(approvalId: number) {
    setActionError(null);
    setActionSuccess(null);
    setBusyId(approvalId);
    try {
      const res = await apiFetch<{ message: string }>(`/api/approvals/${approvalId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Rejected during FINSHIELD GUARD review' }),
      });
      setActionSuccess(res.message);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rejection failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function handlePoPriceRequest(e: FormEvent) {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);
    setSubmittingPoChange(true);
    try {
      const res = await apiFetch<{ message: string }>(
        `/api/purchase-orders/${selectedPoId}/price`,
        {
          method: 'PUT',
          body: JSON.stringify({
            newUnitPrice: Number(newUnitPrice),
            reason: priceReason,
          }),
        }
      );
      setActionSuccess(res.message);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to request PO price change.');
    } finally {
      setSubmittingPoChange(false);
    }
  }

  if (!user) return null;

  const canDecideApprovals = user.role === 'FINANCE_MANAGER';
  const isProcurement = user.role === 'PROCUREMENT_EMPLOYEE';
  const canViewUnapproved =
    user.role === 'PROCUREMENT_EMPLOYEE' ||
    user.role === 'FINANCE_MANAGER' ||
    user.role === 'ADMIN';

  return (
    <div className="space-y-8">
      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
          <div>
            <p className="font-semibold">Action Blocked</p>
            <p className="mt-0.5">{actionError}</p>
          </div>
        </div>
      )}

      {actionSuccess && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {isProcurement && (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Request Purchase Order Price Change
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Price edits do not update the PO immediately. A pending approval request is routed to Finance Manager.
          </p>

          <form
            onSubmit={(e) => void handlePoPriceRequest(e)}
            className="mt-5 grid gap-4 sm:grid-cols-4 sm:items-end"
          >
            <div>
              <label htmlFor="poSelect" className="block text-xs font-medium text-slate-700">
                Purchase Order
              </label>
              <select
                id="poSelect"
                value={selectedPoId}
                onChange={(e) => setSelectedPoId(Number(e.target.value))}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                {purchaseOrders.map((po) => (
                  <option key={po.id} value={po.id}>
                    {po.po_number} — {po.supplier_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="newUnitPrice" className="block text-xs font-medium text-slate-700">
                Proposed Unit Price (INR)
              </label>
              <input
                id="newUnitPrice"
                type="number"
                step="0.01"
                min="1"
                required
                value={newUnitPrice}
                onChange={(e) => setNewUnitPrice(e.target.value)}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums"
              />
            </div>

            <div>
              <label htmlFor="priceReason" className="block text-xs font-medium text-slate-700">
                Justification
              </label>
              <input
                id="priceReason"
                type="text"
                required
                value={priceReason}
                onChange={(e) => setPriceReason(e.target.value)}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <button
              type="submit"
              disabled={submittingPoChange || purchaseOrders.length === 0}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
            >
              {submittingPoChange ? 'Submitting...' : 'Submit for Approval'}
            </button>
          </form>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Maker-Checker Approval Queue
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {canDecideApprovals
                ? 'Finance Manager view — approve or reject requests created by other users.'
                : user.role === 'ADMIN'
                ? 'Admin read-only view — Admin cannot approve PO changes or payments.'
                : `Showing approval requests submitted by ${user.name} (${ROLE_LABELS[user.role]}).`}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {['ALL', 'PENDING', 'APPROVED', 'REJECTED'].map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <p className="py-8 text-sm text-slate-500">Loading approval requests...</p>
        ) : approvals.length === 0 ? (
          <p className="py-8 text-sm text-slate-500">
            No approval requests match the current filter.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                  <th className="py-2.5 pr-4">ID</th>
                  <th className="py-2.5 pr-4">Type</th>
                  <th className="py-2.5 pr-4">Requested By</th>
                  <th className="py-2.5 pr-4">Details</th>
                  <th className="py-2.5 pr-4">Status</th>
                  <th className="py-2.5 pr-4">Created</th>
                  {canDecideApprovals && <th className="py-2.5 text-right">Decision</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {approvals.map((item) => {
                  const isSelfRequest = item.requested_by === user.id;
                  const oldPrice = item.payload?.oldUnitPrice;
                  const newPrice = item.payload?.newUnitPrice;
                  const poNum = item.payload?.poNumber;

                  return (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="py-3 pr-4 font-mono text-xs text-slate-700 tabular-nums">
                        #{item.id}
                      </td>
                      <td className="py-3 pr-4 font-medium text-slate-900">
                        {item.entity_type}
                      </td>
                      <td className="py-3 pr-4 text-slate-700">
                        {item.requested_by_name}
                        <span className="block text-xs text-slate-500">
                          {item.requested_by_role}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-xs text-slate-600">
                        {poNum ? (
                          <span className="font-mono text-slate-900 tabular-nums">
                            {String(poNum)}: Rs {String(oldPrice)} → Rs {String(newPrice)}
                          </span>
                        ) : (
                          <span>Entity #{item.entity_id}</span>
                        )}
                        {item.remarks && (
                          <span className="block text-slate-500">{item.remarks}</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-xs font-semibold tabular-nums">
                        <span
                          className={
                            item.status === 'APPROVED'
                              ? 'text-emerald-700'
                              : item.status === 'REJECTED'
                              ? 'text-rose-700'
                              : 'text-amber-700'
                          }
                        >
                          {item.status}
                        </span>
                        {item.approved_by_name && (
                          <span className="block font-normal text-slate-500">
                            by {item.approved_by_name}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-500 tabular-nums">
                        {new Date(item.created_at).toLocaleString()}
                      </td>
                      {canDecideApprovals && (
                        <td className="py-3 text-right">
                          {item.status === 'PENDING' ? (
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => void handleApprove(item.id)}
                                title={
                                  isSelfRequest
                                    ? 'Maker-checker blocks approving your own request'
                                    : 'Approve request'
                                }
                                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => void handleReject(item.id)}
                                className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50 whitespace-nowrap"
                              >
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Decided</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canViewUnapproved && (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex items-center gap-2.5 border-b border-slate-200 pb-4">
            <FileWarning className="h-5 w-5 text-amber-600" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Unapproved PO Changes (Sample Data)
              </h2>
              <p className="text-xs text-slate-500">
                Tracks historical or direct PO modifications lacking an approval record.
              </p>
            </div>
          </div>

          {unapprovedChanges.length === 0 ? (
            <p className="py-6 text-sm text-slate-500">No unapproved PO changes found.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                    <th className="py-2.5 pr-4">PO Number</th>
                    <th className="py-2.5 pr-4">Field</th>
                    <th className="py-2.5 pr-4">Old → New</th>
                    <th className="py-2.5 pr-4">Modified By</th>
                    <th className="py-2.5 pr-4">Status</th>
                    <th className="py-2.5">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {unapprovedChanges.map((ch) => (
                    <tr key={ch.id}>
                      <td className="py-3 pr-4 font-mono text-xs font-semibold text-slate-900">
                        {ch.po_number}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-700">{ch.field}</td>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-900 tabular-nums">
                        {ch.old_value} → {ch.new_value}
                      </td>
                      <td className="py-3 pr-4 text-slate-700">
                        {ch.changed_by_name} ({ch.changed_by_code})
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs font-semibold text-amber-700">
                        <span className="inline-flex items-center gap-1">
                          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                          {ch.status}
                        </span>
                      </td>
                      <td className="py-3 text-xs text-slate-600">{ch.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
