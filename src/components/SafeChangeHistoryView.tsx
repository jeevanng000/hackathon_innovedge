import { ArrowLeft, CheckCircle2, History, Trash2, XCircle } from 'lucide-react';
import type { SafeChangeHistoryEntry } from '../types/autopatch';

interface SafeChangeHistoryViewProps {
  entries: SafeChangeHistoryEntry[];
  onClearHistory: () => void;
  onBackToWorkspace: () => void;
}

export function SafeChangeHistoryView({
  entries,
  onClearHistory,
  onBackToWorkspace,
}: SafeChangeHistoryViewProps) {
  return (
    <section
      aria-label="Safe Change History"
      className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 pb-28 space-y-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-white">
            Safe Change History
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Immutable decision ledger tracking every patch you Accepted or Rejected.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBackToWorkspace}
            className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-slate-200/80 dark:border-white/15 bg-white/80 dark:bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:shadow-md cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Back to Workspace</span>
          </button>

          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClearHistory}
              className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-700 dark:text-rose-300 hover:shadow-md cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Clear History</span>
            </button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-3xl border border-slate-200/80 dark:border-white/10 bg-white/75 dark:bg-slate-900/60 backdrop-blur-md p-10 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
            <History className="h-6 w-6" aria-hidden="true" />
          </div>
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            No patch decisions recorded yet
          </h2>
          <p className="mx-auto max-w-md text-sm text-slate-600 dark:text-slate-300">
            Scan a code snippet, open a detected bug pop-up, and click Accept Patch or Reject to log
            your first safe change decision.
          </p>
          <button
            type="button"
            onClick={onBackToWorkspace}
            className="tactile-btn gemini-accent-gradient mt-2 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-500/20 cursor-pointer"
          >
            Go to Workspace
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <article
              key={entry.id}
              className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/80 dark:bg-slate-900/65 backdrop-blur-md p-4 sm:p-5 shadow-sm space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold ${
                      entry.decision === 'Accepted'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                    }`}
                  >
                    {entry.decision === 'Accepted' ? (
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {entry.decision}
                  </span>

                  <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                    {entry.filename}
                  </span>

                  <span className="rounded-md bg-slate-100 dark:bg-white/10 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                    {entry.severity} · {entry.confidence}%
                  </span>
                </div>

                <time className="tabular-nums text-xs text-slate-500 dark:text-slate-400">
                  {new Date(entry.timestamp).toLocaleString()}
                </time>
              </div>

              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                {entry.bugTitle}
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <pre className="overflow-x-auto code-scroll rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 font-mono text-xs text-red-900 dark:text-red-100">
                  <code>{entry.before_code || entry.errored_statement}</code>
                </pre>
                <pre className="overflow-x-auto code-scroll rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3 font-mono text-xs text-emerald-950 dark:text-emerald-100">
                  <code>{entry.after_code}</code>
                </pre>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
