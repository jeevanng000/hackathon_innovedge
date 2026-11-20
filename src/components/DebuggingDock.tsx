import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Terminal,
  XCircle,
} from 'lucide-react';
import type { AutoPatchReport, SafePatchDecision, WorkflowStageId } from '../types/autopatch';
import { computeTestSummary } from '../utils/autopatchWorkflow';
import { AUTOPATCH_STAGES } from './WorkflowPipelineBar';

interface DebuggingDockProps {
  visible: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  isScanning: boolean;
  currentStage: WorkflowStageId;
  report: AutoPatchReport | null;
  decisions: Record<string, SafePatchDecision>;
  errorMessage: string | null;
  onSelectBug?: (bugId: string) => void;
}

export function DebuggingDock({
  visible,
  expanded,
  onToggleExpand,
  isScanning,
  currentStage,
  report,
  decisions,
  errorMessage,
  onSelectBug,
}: DebuggingDockProps) {
  if (!visible) return null;

  const activeStageMeta =
    AUTOPATCH_STAGES.find((s) => s.id === currentStage) ?? AUTOPATCH_STAGES[0];
  const bugs = report?.bugs ?? [];
  const testSummary = computeTestSummary(bugs, decisions);
  const traceLogs = report?.trace_logs ?? [];
  const latestTrace = isScanning
    ? `Stage ${currentStage}/5 · ${activeStageMeta.label}...`
    : errorMessage
    ? 'Scan halted — check actionable error banner'
    : traceLogs[traceLogs.length - 1] ?? 'Ready for root-cause inspection';

  return (
    <div className="fixed bottom-4 sm:bottom-5 left-1/2 -translate-x-1/2 z-40 w-[min(94vw,680px)]">
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="dock-drawer"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="mb-2.5 overflow-hidden rounded-2xl border border-slate-200/80 dark:border-white/20 bg-white/85 dark:bg-slate-900/85 backdrop-blur-xl shadow-2xl"
          >
            <div className="max-h-[46vh] overflow-y-auto code-scroll p-4 space-y-4">
              {/* Trace Logs */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Root-Cause Trace Logs
                  </span>
                  {report?.model && (
                    <span className="text-[11px] font-mono text-indigo-600 dark:text-indigo-300">
                      {report.model}
                    </span>
                  )}
                </div>
                {traceLogs.length > 0 ? (
                  <ul className="space-y-1.5 rounded-xl bg-slate-900/[0.04] dark:bg-black/30 p-3 border border-slate-200/60 dark:border-white/10">
                    {traceLogs.map((line, i) => (
                      <li
                        key={i}
                        className="font-mono text-xs text-slate-700 dark:text-slate-300 leading-relaxed"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {isScanning
                      ? `Executing stage ${currentStage} of 5 (${activeStageMeta.label})...`
                      : 'Submit code or select a preset to stream root-cause trace logs.'}
                  </p>
                )}
              </div>

              {/* Test Case Results */}
              {bugs.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Test Runner Breakdown
                    </span>
                    <span className="tabular-nums text-xs font-medium text-slate-600 dark:text-slate-300">
                      {testSummary.passed} passed / {testSummary.total} total
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {bugs.flatMap((bug) =>
                      bug.test_cases.map((tc, idx) => {
                        const isAccepted = decisions[bug.id] === 'Accepted';
                        const passed = isAccepted || tc.status === 'pass';
                        return (
                          <button
                            key={`${bug.id}-tc-${idx}`}
                            type="button"
                            onClick={() => onSelectBug?.(bug.id)}
                            className="tactile-btn w-full flex items-center justify-between gap-3 rounded-xl border border-slate-200/70 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] px-3 py-2 text-left cursor-pointer"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                {tc.case_type && (
                                  <span className="shrink-0 rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700 dark:text-slate-300">
                                    {tc.case_type}
                                  </span>
                                )}
                                <p className="truncate font-mono text-xs text-slate-800 dark:text-slate-200">
                                  {tc.input}
                                </p>
                              </div>
                              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                                Expected: {tc.expected_output}
                              </p>
                            </div>
                            <span
                              className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                passed
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-red-500/15 text-red-700 dark:text-red-300'
                              }`}
                            >
                              {passed ? (
                                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                              ) : (
                                <XCircle className="h-3 w-3" aria-hidden="true" />
                              )}
                              {passed ? 'PASS' : 'FAIL'}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compact Lower-Mid Dock Bar */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse debugging dock' : 'Expand debugging dock'}
        className="tactile-btn w-full flex items-center justify-between gap-3 rounded-2xl border border-slate-200/80 dark:border-white/20 bg-white/85 dark:bg-slate-900/85 backdrop-blur-xl px-4 py-2.5 shadow-2xl shadow-indigo-500/10 cursor-pointer"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {isScanning ? (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-indigo-500"
              aria-hidden="true"
            />
          ) : errorMessage ? (
            <AlertCircle
              className="h-4 w-4 shrink-0 text-red-500"
              aria-hidden="true"
            />
          ) : (
            <Terminal
              className="h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-400"
              aria-hidden="true"
            />
          )}

          <div className="min-w-0 text-left">
            <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">
              {latestTrace}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {testSummary.total > 0 && (
            <div className="flex items-center gap-1.5 tabular-nums text-[11px] font-semibold">
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                {testSummary.passed} Pass
              </span>
              {testSummary.failed > 0 && (
                <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-0.5 text-red-700 dark:text-red-300">
                  <XCircle className="h-3 w-3" aria-hidden="true" />
                  {testSummary.failed} Fail
                </span>
              )}
            </div>
          )}

          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-900/5 dark:bg-white/10 text-slate-600 dark:text-slate-300">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </span>
        </div>
      </button>
    </div>
  );
}
