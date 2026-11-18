import { DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  RefreshCw,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';

interface InvoiceListItem {
  id: number;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  supplier_name: string | null;
  supplier_name_extracted: string | null;
  supplier_gstin_extracted: string | null;
  po_number: string | null;
  po_reference_extracted: string | null;
  invoice_date: string | null;
  total: string | null;
  status: string;
  extraction_source: string | null;
  extraction_method: string | null;
  extraction_confidence: {
    missingFields?: string[];
    lowConfidenceFields?: string[];
    ocrConfidence?: number;
  } | null;
  original_filename: string | null;
  is_historical: boolean;
  is_sample_data: boolean;
  verified_by_name: string | null;
  created_at: string;
}

const MAX_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTS = ['.pdf', '.png', '.jpg', '.jpeg'];

function formatCurrency(val: string | null): string {
  if (val === null || val === undefined || val === '') return '—';
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  return `Rs ${num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function StatusDisplay({ status }: { status: string }) {
  if (status === 'VERIFIED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        VERIFIED
      </span>
    );
  }
  if (status === 'EXTRACTED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700">
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        EXTRACTED
      </span>
    );
  }
  if (status === 'NEEDS_VERIFICATION') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        NEEDS_VERIFICATION
      </span>
    );
  }
  if (status === 'EXTRACTING') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        EXTRACTING
      </span>
    );
  }
  return <span className="text-xs font-semibold text-slate-700">{status}</span>;
}

export function InvoicesPage() {
  const { user, token, apiFetch } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [listError, setListError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const [dragActive, setDragActive] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadStage, setUploadStage] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const canUploadOrVerify = user?.role === 'AP_EMPLOYEE';

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await apiFetch<{ items: InvoiceListItem[] }>('/api/invoices');
      setInvoices(data.items);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load invoices.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  function validateFile(file: File): string | null {
    const lowerName = file.name.toLowerCase();
    const validExt = ALLOWED_EXTS.some((ext) => lowerName.endsWith(ext));
    const validMime =
      file.type === 'application/pdf' ||
      file.type === 'image/png' ||
      file.type === 'image/jpeg' ||
      file.type === 'image/jpg';

    if (!validExt || (file.type && !validMime)) {
      return 'Unsupported file format. Upload a PDF, PNG, or JPG invoice file.';
    }
    if (file.size > MAX_SIZE_BYTES) {
      return 'File exceeds the 10 MB upload limit.';
    }
    if (file.size === 0) {
      return 'The selected file is empty.';
    }
    return null;
  }

  function handleFileUpload(file: File) {
    setUploadError(null);
    const validationErr = validateFile(file);
    if (validationErr) {
      setUploadError(validationErr);
      return;
    }

    setUploading(true);
    setUploadProgress(5);
    setUploadStage(`Uploading ${file.name}...`);

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/invoices/upload');
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.min(85, Math.round((evt.loaded / evt.total) * 85));
        setUploadProgress(pct);
        if (pct >= 80) {
          setUploadStage('Running PDF text / Tesseract OCR & AI extraction...');
        }
      }
    };

    xhr.upload.onload = () => {
      setUploadProgress(90);
      setUploadStage('Running PDF text / Tesseract OCR & AI extraction...');
    };

    xhr.onload = () => {
      setUploading(false);
      let parsed: { message?: string; error?: string; invoice?: { id: number } } = {};
      try {
        parsed = JSON.parse(xhr.responseText || '{}');
      } catch {
        // Ignore parse failures
      }

      if (xhr.status >= 200 && xhr.status < 300 && parsed.invoice?.id) {
        setUploadProgress(100);
        setUploadStage('Extraction complete. Opening verification screen...');
        navigate(`/invoices/${parsed.invoice.id}`);
        return;
      }

      setUploadProgress(0);
      setUploadStage('');
      setUploadError(
        parsed.message ||
          parsed.error ||
          `Invoice upload failed with HTTP ${xhr.status}.`
      );
    };

    xhr.onerror = () => {
      setUploading(false);
      setUploadProgress(0);
      setUploadStage('');
      setUploadError('Network error while uploading invoice.');
    };

    xhr.send(formData);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (canUploadOrVerify && !uploading) {
      setDragActive(true);
    }
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (!canUploadOrVerify || uploading) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      handleFileUpload(dropped);
    }
  }

  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter === 'ALL') return true;
    return inv.status === statusFilter;
  });

  return (
    <div className="space-y-6">
      {canUploadOrVerify ? (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Upload Invoice for OCR &amp; AI Extraction
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Supports embedded-text PDFs, scanned PDFs, PNG, and JPG files up to 10 MB.
                Low-confidence or missing fields are flagged for human verification.
              </p>
            </div>
            <span className="font-mono text-xs text-slate-500">
              Sample PDFs available in /sample-data/invoices
            </span>
          </div>

          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors ${
              dragActive
                ? 'border-slate-900 bg-slate-100'
                : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100/70'
            } ${uploading ? 'pointer-events-none opacity-80' : ''}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleFileUpload(file);
                }
                e.target.value = '';
              }}
            />

            <Upload className="h-6 w-6 text-slate-700" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-slate-900">
              {uploading
                ? uploadStage
                : 'Drag and drop an invoice file here, or click to browse'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Accepted formats: PDF, PNG, JPG · Max size: 10 MB
            </p>

            {uploading && (
              <div className="mt-4 w-full max-w-md">
                <div className="h-2 w-full overflow-hidden rounded-sm bg-slate-200">
                  <div
                    className="h-full bg-slate-900 transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="mt-1.5 font-mono text-xs text-slate-600 tabular-nums">
                  {uploadProgress}%
                </p>
              </div>
            )}
          </div>

          {uploadError && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              <span>{uploadError}</span>
            </div>
          )}
        </section>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <span>
            Read-only invoice view. Only <strong className="font-semibold">AP Employee</strong> can
            upload invoices or verify extracted fields.
          </span>
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Invoices Queue &amp; Sample Ledger
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              All records are sample/prototype data. Click any invoice to inspect extraction confidence and document preview.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {['ALL', 'NEEDS_VERIFICATION', 'EXTRACTED', 'VERIFIED', 'EXTRACTING'].map(
                (st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      statusFilter === st
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {st}
                  </button>
                )
              )}
            </div>

            <button
              type="button"
              onClick={() => void loadInvoices()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh
            </button>
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

        {loading ? (
          <p className="py-8 text-sm text-slate-500">Loading invoices...</p>
        ) : filteredInvoices.length === 0 ? (
          <p className="py-8 text-sm text-slate-500">
            No invoices match the selected status filter.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
                  <th className="py-2.5 pr-4">Invoice No.</th>
                  <th className="py-2.5 pr-4">Normalized</th>
                  <th className="py-2.5 pr-4">Supplier</th>
                  <th className="py-2.5 pr-4">PO Ref</th>
                  <th className="py-2.5 pr-4">Date</th>
                  <th className="py-2.5 pr-4 text-right">Total</th>
                  <th className="py-2.5 pr-4">Extraction</th>
                  <th className="py-2.5 pr-4">Status</th>
                  <th className="py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredInvoices.map((inv) => {
                  const supplierDisplay =
                    inv.supplier_name || inv.supplier_name_extracted || 'Unknown / Missing';
                  const poDisplay = inv.po_number || inv.po_reference_extracted || '—';
                  const missingCount = inv.extraction_confidence?.missingFields?.length ?? 0;
                  const lowCount = inv.extraction_confidence?.lowConfidenceFields?.length ?? 0;

                  return (
                    <tr key={inv.id} className="hover:bg-slate-50">
                      <td className="py-3 pr-4">
                        <span className="font-mono text-xs font-semibold text-slate-900">
                          {inv.invoice_number || `INV-#${inv.id}`}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {inv.is_historical
                            ? 'Sample Historical'
                            : inv.original_filename || 'Uploaded Sample'}
                        </span>
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-600">
                        {inv.normalized_invoice_number || '—'}
                      </td>
                      <td className="py-3 pr-4 text-slate-700">
                        <span className="block max-w-[200px] truncate">{supplierDisplay}</span>
                        {inv.supplier_gstin_extracted && (
                          <span className="block font-mono text-xs text-slate-500">
                            {inv.supplier_gstin_extracted}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-700">
                        {poDisplay}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-600 tabular-nums">
                        {inv.invoice_date ? String(inv.invoice_date).slice(0, 10) : '—'}
                      </td>
                      <td className="py-3 pr-4 text-right font-mono text-xs font-medium text-slate-900 tabular-nums">
                        {formatCurrency(inv.total)}
                      </td>
                      <td className="py-3 pr-4 text-xs text-slate-600">
                        <span className="block font-mono">
                          {inv.extraction_source || 'SEED'} · {inv.extraction_method || 'DB'}
                        </span>
                        {(missingCount > 0 || lowCount > 0) && inv.status !== 'VERIFIED' && (
                          <span className="block text-amber-700">
                            {missingCount > 0 ? `${missingCount} missing` : ''}
                            {missingCount > 0 && lowCount > 0 ? ', ' : ''}
                            {lowCount > 0 ? `${lowCount} low conf` : ''}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <StatusDisplay status={inv.status} />
                        {inv.verified_by_name && (
                          <span className="block text-xs text-slate-500">
                            by {inv.verified_by_name}
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <Link
                          to={`/invoices/${inv.id}`}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                          {canUploadOrVerify && inv.status !== 'VERIFIED'
                            ? 'Verify'
                            : 'Inspect'}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
