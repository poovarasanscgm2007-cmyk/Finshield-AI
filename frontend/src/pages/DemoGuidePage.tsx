import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Play,
  RotateCcw,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import { ROLE_LABELS, UserRole } from '../auth/permissions.ts';
import { useAuth } from '../context/AuthContext.tsx';

interface DemoAccount {
  role: UserRole;
  name: string;
  email: string;
  password: string;
  summary: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    role: 'AP_EMPLOYEE',
    name: 'Aarav Mehta (Sample AP Employee)',
    email: 'ap.employee@abcmfg.sample',
    password: 'SamplePass@101',
    summary: 'Upload PDFs/scans, verify low-confidence fields, run 3-way match, view duplicates.',
  },
  {
    role: 'PROCUREMENT_EMPLOYEE',
    name: 'Employee 102',
    email: 'employee102@abcmfg.sample',
    password: 'SamplePass@102',
    summary: 'Submit PO price change requests & observe maker-checker self-approval block.',
  },
  {
    role: 'WAREHOUSE_EMPLOYEE',
    name: 'Rohan Verma (Sample Warehouse Employee)',
    email: 'warehouse@abcmfg.sample',
    password: 'SamplePass@103',
    summary: 'Inspect GRN-101 (80 kg), record +20 kg delivery GRN, resolve Warehouse investigation.',
  },
  {
    role: 'FINANCE_MANAGER',
    name: 'Priya Nair (Sample Finance Manager)',
    email: 'finance.manager@abcmfg.sample',
    password: 'SamplePass@104',
    summary: 'Inspect GST/ITC risk, Graph, Copilot, approve maker-checker requests & final payments.',
  },
  {
    role: 'ADMIN',
    name: 'Vikram Rao (Sample Admin)',
    email: 'admin@abcmfg.sample',
    password: 'SamplePass@105',
    summary: 'Verify SHA-256 hash-chained audit log, reset demo data (cannot approve payments).',
  },
];

interface DemoStep {
  step: number;
  title: string;
  actor: string;
  route: string;
  routeLabel: string;
  whatToDo: string;
  expectedOutcome: string;
}

const DEMO_STEPS: DemoStep[] = [
  {
    step: 1,
    title: 'Login by Role (RBAC & Sample Data Context)',
    actor: 'Admin / Finance Manager -> AP Employee',
    route: '/',
    routeLabel: 'Overview',
    whatToDo: 'Use Quick Login below to sign in as AP Employee and inspect role capabilities.',
    expectedOutcome: 'Sidebar and API routes enforce RBAC; sample data banner is visible globally.',
  },
  {
    step: 2,
    title: 'Upload Sample Invoice & OCR/AI Extraction',
    actor: 'AP Employee',
    route: '/invoices',
    routeLabel: 'Invoices',
    whatToDo: 'Upload INV-101-sample.pdf or INV-099-scanned-sample.pdf from /sample-data/invoices.',
    expectedOutcome:
      'PDF/Tesseract OCR extracts fields with per-field confidence; low-confidence scans enter NEEDS_VERIFICATION.',
  },
  {
    step: 3,
    title: 'Human Verification & Normalized Duplicate Check',
    actor: 'AP Employee',
    route: '/invoices',
    routeLabel: 'Invoices',
    whatToDo: 'Verify extracted fields if needed and open seeded INV-101 to inspect INV_101 duplicate flag.',
    expectedOutcome:
      'Normalized invoice number INV101 catches INV_101 as POSSIBLE DUPLICATE with similarity score (never auto-rejected).',
  },
  {
    step: 4,
    title: '3-Way Matching (PO-101 vs GRN-101 vs INV-101)',
    actor: 'AP Employee / Finance Manager',
    route: '/invoices',
    routeLabel: 'Invoices',
    whatToDo: 'Inspect INV-101 side-by-side PO/GRN/Invoice comparison and click Run Matching.',
    expectedOutcome:
      'Status MISMATCH & ON_HOLD: "Invoice qty 100 exceeds received qty 80 by 20" and PO-101 unapproved price 500 -> 700.',
  },
  {
    step: 5,
    title: 'GSTIN Check, Tax Type & GSTR-2B ITC at Risk',
    actor: 'Finance Manager',
    route: '/invoices',
    routeLabel: 'Invoices',
    whatToDo: 'Open INV-101 GST & Risk panel to view GSTIN checksum, CGST+SGST intra-state check, and GSTR-2B status.',
    expectedOutcome:
      'INV-101 missing in GSTR-2B flags Rs 9,000.00 ITC at risk (Rs 4,500 CGST + Rs 4,500 SGST).',
  },
  {
    step: 6,
    title: 'Explainable Risk Alerts & Supplier Scorecard',
    actor: 'Finance Manager',
    route: '/suppliers',
    routeLabel: 'Suppliers & Scorecards',
    whatToDo: 'Open Suppliers & Scorecards and inspect Supplier A historical extra charges (Rs 500, 700, 1000).',
    expectedOutcome:
      'INV-101 carries HIGH investigation priority; Supplier A displays transparent weighted performance score & evidence.',
  },
  {
    step: 7,
    title: 'Supplier Relationship Graph (PostgreSQL)',
    actor: 'Finance Manager / Admin',
    route: '/supplier-graph',
    routeLabel: 'Supplier Graph',
    whatToDo: 'Click Supplier A / B nodes and the red SHARED_BANK edge (masked XXXX8877).',
    expectedOutcome:
      'Shows "Relationship requires verification" indicator and linked Finance & Compliance investigation (never proof of fraud).',
  },
  {
    step: 8,
    title: 'Evidence-Linked AI Copilot',
    actor: 'Finance Manager',
    route: '/',
    routeLabel: 'Overview (Copilot)',
    whatToDo: 'Ask: "Why is Supplier A\'s invoice flagged?" in the AI Audit Copilot panel.',
    expectedOutcome:
      'Cites real DB records: 20 kg shortage, PO-101 500 -> 700 by Employee 102, extra charges, Rs 9,000 ITC at risk, shared bank.',
  },
  {
    step: 9,
    title: 'Auto-Assigned Investigations & Maker-Checker Block',
    actor: 'Employee 102 & Finance Manager',
    route: '/approvals',
    routeLabel: 'Approvals & Guard',
    whatToDo:
      'Check Investigations routed to Warehouse, Procurement/Finance, AP/Finance, Finance/Compliance; test Employee 102 self-approval.',
    expectedOutcome:
      'Employee 102 receives 403 "Maker-checker violation"; payment remains blocked (409) while investigations are open.',
  },
  {
    step: 10,
    title: 'GRN Resolution, Revalidation, Audit Verify & Human Final Approval',
    actor: 'Warehouse -> Finance Manager -> Admin',
    route: '/investigations',
    routeLabel: 'Investigation Center',
    whatToDo:
      'Record +20 kg GRN as Warehouse Employee, resolve quantity investigation to trigger REVALIDATED, approve remaining items as Finance Manager, and verify hash chain as Admin.',
    expectedOutcome:
      'Only after all investigations are REVALIDATED does Finance Manager unlock human final payment approval; SHA-256 audit log verifies valid.',
  },
];

export function DemoGuidePage() {
  const { user, login, apiFetch } = useAuth();
  const navigate = useNavigate();
  const [switchingRole, setSwitchingRole] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  if (!user) return null;

  async function handleQuickLogin(account: DemoAccount) {
    setSwitchingRole(account.role);
    setFeedback(null);
    try {
      await login(account.email, account.password);
      navigate('/');
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Quick login failed.',
      });
    } finally {
      setSwitchingRole(null);
    }
  }

  async function handleResetDemo() {
    setResetting(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ message: string; evaluatedInvoices?: number[] }>(
        '/api/system/reset-demo',
        { method: 'POST' }
      );
      setFeedback({
        type: 'ok',
        text: `${res.message} Evaluated active invoice(s): ${(res.evaluatedInvoices || []).join(', ') || 'none'}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to reset demo data.',
      });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-900">
                FINSHIELD AI Live Demo Guide (Sample Data)
              </h2>
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                Sample data
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              10-step end-to-end walkthrough for ABC Manufacturing (Sample). AI never releases payment; risk score indicates investigation priority only.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleResetDemo()}
            disabled={resetting}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
          >
            <RotateCcw className={`h-3.5 w-3.5 ${resetting ? 'animate-spin' : ''}`} aria-hidden="true" />
            {resetting ? 'Resetting Demo Data...' : 'Reset demo data'}
          </button>
        </div>

        {feedback && (
          <div
            role="status"
            className={`mt-4 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-xs ${
              feedback.type === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-rose-200 bg-rose-50 text-rose-900'
            }`}
          >
            {feedback.type === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
            ) : (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" aria-hidden="true" />
            )}
            <span>{feedback.text}</span>
          </div>
        )}

        <div className="mt-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <UserCheck className="h-4 w-4 text-slate-700" aria-hidden="true" />
            Quick Role Switcher (All 5 RBAC Roles)
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Currently signed in as{' '}
            <span className="font-semibold text-slate-900">
              {user.name} ({ROLE_LABELS[user.role]})
            </span>
            . Switching to AP, Procurement, or Warehouse navigates directly to Overview.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {DEMO_ACCOUNTS.map((acc) => {
              const isCurrent = user.email === acc.email;
              return (
                <div
                  key={acc.role}
                  className={`flex flex-col justify-between rounded-lg border p-3.5 ${
                    isCurrent
                      ? 'border-slate-900 bg-slate-50'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-900">
                      {ROLE_LABELS[acc.role]}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-500 truncate">
                      {acc.email}
                    </p>
                    <p className="mt-2 text-[11px] text-slate-600">{acc.summary}</p>
                  </div>

                  <button
                    type="button"
                    disabled={switchingRole !== null || isCurrent}
                    onClick={() => void handleQuickLogin(acc)}
                    className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                  >
                    <Play className="h-3 w-3" aria-hidden="true" />
                    {isCurrent
                      ? 'Active Role'
                      : switchingRole === acc.role
                      ? 'Signing in...'
                      : `Login ${ROLE_LABELS[acc.role].split(' ')[0]}`}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              10-Step Demo Execution Sequence
            </h3>
            <p className="text-xs text-slate-500">
              Aligned with PROJECT_SPEC.md Section 6 and /docs/DEMO_SCRIPT.md
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Sample invoices in /sample-data/invoices
          </span>
        </div>

        <ol className="mt-4 divide-y divide-slate-200">
          {DEMO_STEPS.map((s) => (
            <li key={s.step} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1 pr-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-slate-900 font-mono text-[11px] font-bold text-white">
                    {s.step}
                  </span>
                  <h4 className="text-sm font-semibold text-slate-900">{s.title}</h4>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                    {s.actor}
                  </span>
                </div>
                <p className="text-xs text-slate-700">
                  <span className="font-semibold">Action:</span> {s.whatToDo}
                </p>
                <p className="text-xs text-slate-600">
                  <span className="font-semibold text-emerald-800">Expected:</span>{' '}
                  {s.expectedOutcome}
                </p>
              </div>

              <Link
                to={s.route}
                className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
              >
                Open {s.routeLabel}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
