import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, PackageCheck, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';

interface GrnRow {
  id: number;
  grn_number: string;
  po_id: number;
  po_number: string;
  supplier_name: string;
  total_quantity_received: string;
  unit: string;
  warehouse_location: string | null;
  status: string;
  received_by_name: string | null;
  received_at: string;
}

export function GrnsPage() {
  const { user, apiFetch } = useAuth();
  const [searchParams] = useSearchParams();

  const [grns, setGrns] = useState<GrnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [poNumber, setPoNumber] = useState(() => searchParams.get('poNumber') || 'PO-101');
  const [quantityReceived, setQuantityReceived] = useState('20');
  const [unit, setUnit] = useState('kg');
  const [warehouseLocation, setWarehouseLocation] = useState('WH-MUM-01');
  const [isCorrection, setIsCorrection] = useState(false);
  const [replacesGrnId, setReplacesGrnId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canCreateGrn = user?.role === 'WAREHOUSE_EMPLOYEE';

  const loadGrns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ items: GrnRow[] }>('/api/grns');
      setGrns(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GRNs.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadGrns();
  }, [loadGrns]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canCreateGrn) return;
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);

    try {
      const res = await apiFetch<{
        message: string;
        reEvaluatedInvoices?: Array<{ invoiceId: number; invoiceStatus: string }>;
      }>('/api/grns', {
        method: 'POST',
        body: JSON.stringify({
          poNumber: poNumber.trim(),
          quantityReceived: Number(quantityReceived),
          unit: unit.trim() || 'kg',
          warehouseLocation: warehouseLocation.trim() || undefined,
          isCorrection,
          replacesGrnId: isCorrection && replacesGrnId ? Number(replacesGrnId) : null,
        }),
      });

      const reEval = res.reEvaluatedInvoices || [];
      const revalSummary =
        reEval.length > 0
          ? ` Linked invoices re-evaluated: ${reEval
              .map((r) => `#${r.invoiceId} (${r.invoiceStatus})`)
              .join(', ')}.`
          : '';
      setSuccessMsg(`${res.message}${revalSummary}`);
      await loadGrns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record GRN.');
    } finally {
      setSubmitting(false);
    }
  }

  const activeGrnsForPo = grns.filter(
    (g) => g.po_number.toUpperCase() === poNumber.trim().toUpperCase() && g.status !== 'SUPERSEDED'
  );

  return (
    <div className="space-y-6">
      {canCreateGrn ? (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
            <PackageCheck className="mt-0.5 h-5 w-5 text-slate-700" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Record Partial Delivery or Corrected GRN
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Warehouse Employees can record additional partial receipts (aggregated across GRNs) or supersede an existing GRN during quantity investigation resolution. Linked active invoices are automatically re-evaluated.
              </p>
            </div>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <label htmlFor="poNumber" className="block text-xs font-medium text-slate-700">
                  Purchase Order Number
                </label>
                <input
                  id="poNumber"
                  type="text"
                  required
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900"
                />
              </div>

              <div>
                <label htmlFor="qtyReceived" className="block text-xs font-medium text-slate-700">
                  Quantity Received
                </label>
                <input
                  id="qtyReceived"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={quantityReceived}
                  onChange={(e) => setQuantityReceived(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="grnUnit" className="block text-xs font-medium text-slate-700">
                  Unit
                </label>
                <input
                  id="grnUnit"
                  type="text"
                  required
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </div>

              <div>
                <label htmlFor="whLocation" className="block text-xs font-medium text-slate-700">
                  Warehouse Location
                </label>
                <input
                  id="whLocation"
                  type="text"
                  value={warehouseLocation}
                  onChange={(e) => setWarehouseLocation(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={isCorrection}
                  onChange={(e) => setIsCorrection(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Supersede &amp; replace prior GRN on {poNumber} (instead of adding a partial receipt)
              </label>

              {isCorrection && activeGrnsForPo.length > 0 && (
                <select
                  value={replacesGrnId}
                  onChange={(e) => setReplacesGrnId(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-800"
                >
                  <option value="">Supersede all active GRNs on {poNumber}</option>
                  {activeGrnsForPo.map((g) => (
                    <option key={g.id} value={String(g.id)}>
                      Replace {g.grn_number} ({g.total_quantity_received} {g.unit})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {submitting ? 'Recording GRN...' : 'Record GRN'}
            </button>
          </form>

          {successMsg && (
            <div
              role="status"
              className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              <span>{successMsg}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </section>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <span>
            Read-only GRN ledger. Only <strong>Warehouse Employee</strong> can record or correct Goods Receipt Notes.
          </span>
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Goods Receipt Notes Ledger (Sample Data)
            </h2>
            <p className="text-xs text-slate-500">
              3-way matching aggregates all active (non-SUPERSEDED) GRNs per PO.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadGrns()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-3">GRN Number</th>
                <th className="py-2 pr-3">PO Number</th>
                <th className="py-2 pr-3">Supplier</th>
                <th className="py-2 pr-3 text-right">Qty Received</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Location</th>
                <th className="py-2 pr-3">Received By</th>
                <th className="py-2">Received At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {grns.map((g) => (
                <tr key={g.id} className={g.status === 'SUPERSEDED' ? 'bg-slate-50/70 opacity-60' : ''}>
                  <td className="py-2.5 pr-3 font-mono font-semibold text-slate-900">
                    {g.grn_number}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-slate-700">{g.po_number}</td>
                  <td className="py-2.5 pr-3 text-slate-700">{g.supplier_name}</td>
                  <td className="py-2.5 pr-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                    {g.total_quantity_received} {g.unit}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-xs font-semibold">
                    <span
                      className={
                        g.status === 'SUPERSEDED' ? 'text-slate-500 line-through' : 'text-emerald-700'
                      }
                    >
                      {g.status || 'RECEIVED'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-slate-600">{g.warehouse_location || '—'}</td>
                  <td className="py-2.5 pr-3 text-slate-700">{g.received_by_name || 'System'}</td>
                  <td className="py-2.5 font-mono text-slate-500 tabular-nums">
                    {new Date(g.received_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
