import { AlertTriangle } from 'lucide-react';

export function SampleDataBanner() {
  return (
    <div
      role="status"
      aria-label="Sample data notice"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-amber-950"
    >
      <div className="mx-auto flex max-w-5xl items-center gap-2.5 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <p>
          <span className="font-semibold uppercase tracking-wide">Sample data</span>
          {' — '}
          All demo company records (ABC Manufacturing), suppliers, purchase orders, GRNs,
          invoices, and GSTR-2B entries are sample data for verification only.
        </p>
      </div>
    </div>
  );
}
