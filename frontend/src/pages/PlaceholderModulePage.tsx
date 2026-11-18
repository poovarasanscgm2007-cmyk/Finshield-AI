import { Layers } from 'lucide-react';

interface PlaceholderModulePageProps {
  title: string;
  description: string;
  scheduledPhase: string;
}

export function PlaceholderModulePage({
  title,
  description,
  scheduledPhase,
}: PlaceholderModulePageProps) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-8">
      <div className="flex items-start gap-3">
        <Layers className="mt-0.5 h-5 w-5 text-slate-600" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">{description}</p>
          <p className="mt-3 font-mono text-xs text-slate-500">
            Status: Scheduled for {scheduledPhase} (Phase 2 covers Auth, RBAC, Maker-Checker & Audit Log only).
          </p>
        </div>
      </div>
    </section>
  );
}
