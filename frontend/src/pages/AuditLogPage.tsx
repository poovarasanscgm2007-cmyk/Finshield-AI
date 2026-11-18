import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';

interface AuditEntry {
  id: number;
  actor_id: number | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  created_at: string;
}

interface VerifyResponse {
  valid: boolean;
  totalEntries: number;
  brokenAtId?: number;
  reason?: string;
}

export function AuditLogPage() {
  const { apiFetch } = useAuth();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);

  const loadAuditLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '15',
      });
      if (actionFilter.trim()) {
        params.set('action', actionFilter.trim());
      }

      const data = await apiFetch<{
        items: AuditEntry[];
        total: number;
        page: number;
        totalPages: number;
      }>(`/api/audit-log?${params.toString()}`);

      setItems(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log.');
    } finally {
      setLoading(false);
    }
  }, [page, actionFilter, apiFetch]);

  useEffect(() => {
    void loadAuditLog();
  }, [loadAuditLog]);

  async function handleVerifyChain() {
    setVerifying(true);
    setError(null);
    try {
      const result = await apiFetch<VerifyResponse>('/api/audit-log/verify');
      setVerifyResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chain verification failed.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Tamper-Evident Hash-Chained Audit Log
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Append-only SHA-256 chain ({total} total entries).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Filter by action"
              value={actionFilter}
              onChange={(e) => {
                setActionFilter(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
            >
              <option value="">All Actions</option>
              <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
              <option value="LOGIN_FAILURE">LOGIN_FAILURE</option>
              <option value="PO_PRICE_CHANGE_REQUESTED">PO_PRICE_CHANGE_REQUESTED</option>
              <option value="PO_PRICE_CHANGE_APPLIED">PO_PRICE_CHANGE_APPLIED</option>
              <option value="APPROVAL_CREATED">APPROVAL_CREATED</option>
              <option value="APPROVAL_APPROVED">APPROVAL_APPROVED</option>
              <option value="APPROVAL_REJECTED">APPROVAL_REJECTED</option>
              <option value="MAKER_CHECKER_VIOLATION">MAKER_CHECKER_VIOLATION</option>
              <option value="ACCESS_DENIED_403">ACCESS_DENIED_403</option>
            </select>

            <button
              type="button"
              onClick={() => void loadAuditLog()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>

            <button
              type="button"
              onClick={() => void handleVerifyChain()}
              disabled={verifying}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              {verifying ? 'Verifying...' : 'Verify Chain'}
            </button>
          </div>
        </div>

        {verifyResult && (
          <div
            role="status"
            className={`mt-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
              verifyResult.valid
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-rose-200 bg-rose-50 text-rose-900'
            }`}
          >
            {verifyResult.valid ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            ) : (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
            )}
            <div>
              <p className="font-semibold">
                {verifyResult.valid
                  ? `Chain Verified Valid (${verifyResult.totalEntries} records checked)`
                  : `Chain Integrity Broken at Record #${verifyResult.brokenAtId}`}
              </p>
              {verifyResult.reason && <p className="mt-0.5 text-xs">{verifyResult.reason}</p>}
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-rose-700" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="py-8 text-sm text-slate-500">Loading audit log...</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-sm text-slate-500">No audit entries found.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 font-medium text-slate-500">
                  <th className="py-2.5 pr-3">ID</th>
                  <th className="py-2.5 pr-3">Timestamp</th>
                  <th className="py-2.5 pr-3">Actor</th>
                  <th className="py-2.5 pr-3">Action</th>
                  <th className="py-2.5 pr-3">Entity</th>
                  <th className="py-2.5 pr-3">Prev Hash</th>
                  <th className="py-2.5">Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {items.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50">
                    <td className="py-2.5 pr-3 font-mono text-slate-700 tabular-nums">
                      {entry.id}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                      {new Date(entry.created_at).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-3 text-slate-800">
                      {entry.actor_name || 'SYSTEM'}
                      {entry.actor_role && (
                        <span className="block text-[11px] text-slate-500">
                          {entry.actor_role}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 font-mono font-medium text-slate-900">
                      {entry.action}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-slate-600">
                      {entry.entity}:{entry.entity_id}
                    </td>
                    <td
                      className="py-2.5 pr-3 font-mono text-slate-500 tabular-nums"
                      title={entry.prev_hash}
                    >
                      {entry.prev_hash.slice(0, 12)}…
                    </td>
                    <td
                      className="py-2.5 font-mono text-slate-900 tabular-nums"
                      title={entry.hash}
                    >
                      {entry.hash.slice(0, 12)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4 text-xs text-slate-600">
          <span className="font-mono tabular-nums">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
