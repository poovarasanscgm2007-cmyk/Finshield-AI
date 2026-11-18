import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  FileSearch,
  Send,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';

export interface CopilotEvidenceItem {
  recordType: string;
  recordId: string;
  label: string;
  link: string;
  summary: string;
}

export interface CopilotRecommendedAction {
  department: string;
  action: string;
  link: string;
}

export interface CopilotResponse {
  question: string;
  intent: string;
  source: 'LLM' | 'TEMPLATE_FALLBACK';
  answer: string;
  evidence: CopilotEvidenceItem[];
  recommendedActions: CopilotRecommendedAction[];
  rbacFiltered: boolean;
}

interface ChatEntry {
  id: string;
  question: string;
  response?: CopilotResponse;
  error?: string;
}

const SUGGESTED_QUESTIONS = [
  "Why is Supplier A's invoice flagged?",
  'Which invoices are high risk?',
  'How much ITC is at risk?',
  'What should Warehouse verify?',
];

export function CopilotPanel({
  invoiceId,
  invoiceNumber,
}: {
  invoiceId?: number;
  invoiceNumber?: string | null;
}) {
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);

  const suggestions = invoiceId
    ? [
        `Why is ${invoiceNumber || `Invoice #${invoiceId}`} flagged?`,
        ...SUGGESTED_QUESTIONS.slice(1),
      ]
    : SUGGESTED_QUESTIONS;

  async function submitQuestion(qText: string) {
    const clean = qText.trim();
    if (!clean || asking) return;

    const entryId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setAsking(true);
    setQuestion('');
    setEntries((prev) => [...prev, { id: entryId, question: clean }]);

    try {
      const res = await apiFetch<CopilotResponse>('/api/copilot/ask', {
        method: 'POST',
        body: JSON.stringify({
          question: clean,
          ...(invoiceId ? { invoiceId } : {}),
        }),
      });
      setEntries((prev) =>
        prev.map((item) => (item.id === entryId ? { ...item, response: res } : item))
      );
    } catch (err) {
      setEntries((prev) =>
        prev.map((item) =>
          item.id === entryId
            ? {
                ...item,
                error: err instanceof Error ? err.message : 'Unable to query AI Copilot.',
              }
            : item
        )
      );
    } finally {
      setAsking(false);
    }
  }

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submitQuestion(question);
  }

  return (
    <section
      aria-label="AI Audit Copilot"
      className="rounded-lg border border-slate-200 bg-white p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Bot className="h-4.5 w-4.5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              AI Audit Copilot{invoiceNumber ? ` · ${invoiceNumber}` : ''}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Grounded strictly in live PostgreSQL audit, 3-way matching, GST, and investigation records (RBAC-filtered). Risk scores indicate investigation priority, not proof of fraud.
            </p>
          </div>
        </div>
      </div>

      {/* Suggested Questions */}
      <div className="mt-4">
        <p className="text-xs font-medium text-slate-500">Suggested audit questions</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {suggestions.map((sq) => (
            <button
              key={sq}
              type="button"
              disabled={asking}
              onClick={() => void submitQuestion(sq)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-100 disabled:opacity-60"
            >
              <Sparkles className="h-3 w-3 text-slate-500" aria-hidden="true" />
              {sq}
            </button>
          ))}
        </div>
      </div>

      {/* Conversation History */}
      {entries.length > 0 && (
        <div className="mt-5 space-y-4">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-900">
                  Q: {entry.question}
                </p>
                {entry.response && (
                  <span className="font-mono text-[11px] font-medium text-slate-500">
                    {entry.response.source === 'LLM' ? 'GEMINI SYNTHESIS' : 'VERIFIED RECORD SUMMARY'}
                  </span>
                )}
              </div>

              {!entry.response && !entry.error && (
                <p className="text-xs text-slate-500">
                  Fetching database facts &amp; grounding response...
                </p>
              )}

              {entry.error && (
                <div className="flex items-center gap-2 text-xs text-rose-700">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{entry.error}</span>
                </div>
              )}

              {entry.response && (
                <>
                  {entry.response.rbacFiltered && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <ShieldAlert className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                      <span>Response filtered by your department RBAC permissions.</span>
                    </div>
                  )}

                  <div className="whitespace-pre-line text-sm leading-relaxed text-slate-800">
                    {entry.response.answer}
                  </div>

                  {entry.response.evidence.length > 0 && (
                    <div className="border-t border-slate-200 pt-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                        <FileSearch className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                        Cited Evidence Records ({entry.response.evidence.length})
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {entry.response.evidence.map((ev) => (
                          <button
                            key={`${ev.recordType}-${ev.recordId}`}
                            type="button"
                            onClick={() => navigate(ev.link)}
                            title={ev.summary}
                            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 transition-colors hover:border-slate-900 hover:bg-slate-50"
                          >
                            <span className="font-mono font-semibold">{ev.label}</span>
                            <ArrowUpRight className="h-3 w-3 text-slate-500" aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {entry.response.recommendedActions.length > 0 && (
                    <div className="border-t border-slate-200 pt-3">
                      <p className="text-xs font-semibold text-slate-700">
                        Recommended Actions by Department
                      </p>
                      <ul className="mt-1.5 space-y-1.5">
                        {entry.response.recommendedActions.map((act, idx) => (
                          <li
                            key={idx}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
                          >
                            <div>
                              <span className="font-mono font-semibold text-slate-900">
                                [{act.department}]
                              </span>{' '}
                              <span className="text-slate-700">{act.action}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => navigate(act.link)}
                              className="inline-flex items-center gap-1 font-medium text-slate-900 hover:underline whitespace-nowrap"
                            >
                              Open
                              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Ask Form */}
      <form onSubmit={handleFormSubmit} className="mt-5 flex flex-wrap gap-3">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={asking}
          placeholder="Ask about flagged invoices, ITC at risk, PO changes, or department tasks..."
          aria-label="Ask AI Audit Copilot"
          className="min-w-[240px] flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={asking || !question.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {asking ? 'Analyzing...' : 'Ask Copilot'}
        </button>
      </form>
    </section>
  );
}
