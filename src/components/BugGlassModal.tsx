import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import type { AutoPatchBug, AutoPatchSeverity, SafePatchDecision } from '../types/autopatch';

interface BugGlassModalProps {
  bug: AutoPatchBug | null;
  bugsCount: number;
  currentIndex: number;
  decision?: SafePatchDecision;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
  onAcceptPatch: (bug: AutoPatchBug) => void;
  onRejectPatch: (bug: AutoPatchBug) => void;
}

const SEVERITY_BADGE_CLASS: Record<AutoPatchSeverity, string> = {
  Critical:
    'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  High:
    'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  Medium:
    'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  Low:
    'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
};

export function BugGlassModal({
  bug,
  bugsCount,
  currentIndex,
  decision,
  onClose,
  onNavigate,
  onAcceptPatch,
  onRejectPatch,
}: BugGlassModalProps) {
  useEffect(() => {
    if (!bug) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [bug, onClose]);

  return (
    <AnimatePresence>
      {bug && (
        <motion.div
          key="bug-glass-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-950/40 dark:bg-slate-950/65"
          onClick={onClose}
        >
          <motion.div
            key={bug.id}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-modal-title"
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden rounded-3xl backdrop-blur-xl bg-white/75 dark:bg-slate-900/75 border border-white/40 dark:border-white/20 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 dark:border-white/15 px-5 py-4 sm:px-6">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-xs font-semibold ${
                      SEVERITY_BADGE_CLASS[bug.severity]
                    }`}
                  >
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                    {bug.severity}
                  </span>
                  <span className="tabular-nums rounded-lg bg-indigo-500/12 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                    {bug.confidence}% confidence
                  </span>
                  {decision && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-semibold ${
                        decision === 'Accepted'
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {decision === 'Accepted' ? (
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {decision}
                    </span>
                  )}
                </div>

                <h2
                  id="bug-modal-title"
                  className="font-display text-lg sm:text-xl font-semibold text-slate-900 dark:text-white"
                >
                  {bug.title}
                </h2>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {bugsCount > 1 && (
                  <div className="flex items-center gap-1 mr-1">
                    <button
                      type="button"
                      onClick={() => onNavigate('prev')}
                      aria-label="Previous bug"
                      className="tactile-btn flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200/80 dark:border-white/15 bg-white/70 dark:bg-white/5 text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <span className="tabular-nums px-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      {currentIndex + 1}/{bugsCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => onNavigate('next')}
                      aria-label="Next bug"
                      className="tactile-btn flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200/80 dark:border-white/15 bg-white/70 dark:bg-white/5 text-slate-700 dark:text-slate-200 cursor-pointer"
                    >
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close bug details"
                  className="tactile-btn flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200/80 dark:border-white/15 bg-white/70 dark:bg-white/5 text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto code-scroll p-5 sm:p-6 space-y-5">
              {/* Spotlight Errored Statement in Red Tint */}
              <div>
                <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Errored Statement</span>
                </div>
                <pre className="overflow-x-auto rounded-2xl border border-red-500/35 bg-red-500/12 px-4 py-3 font-mono text-xs sm:text-[13px] text-red-800 dark:text-red-200">
                  <code>{bug.errored_statement || bug.before_code}</code>
                </pre>
              </div>

              {/* Root Cause Explanation */}
              <div className="rounded-2xl border border-slate-200/70 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] p-4">
                <div className="flex items-center gap-1.5 mb-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Root Cause &amp; Triggering Input</span>
                </div>
                <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                  {bug.root_cause}
                </p>
              </div>

              {/* Clean Before / After Diff View */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Proposed Minimal Patch (Before / After)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="overflow-hidden rounded-2xl border border-red-500/30 bg-red-500/[0.07]">
                    <div className="border-b border-red-500/20 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-red-700 dark:text-red-300">
                      Before (Buggy)
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3.5 font-mono text-xs leading-relaxed text-red-900 dark:text-red-100">
                      <code>{(bug.before_code || bug.errored_statement).trim()}</code>
                    </pre>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.08]">
                    <div className="border-b border-emerald-500/20 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                      After (Focused Fix)
                    </div>
                    <pre className="whitespace-pre-wrap break-words p-3.5 font-mono text-xs leading-relaxed text-emerald-950 dark:text-emerald-100">
                      <code>{bug.after_code.trim()}</code>
                    </pre>
                  </div>
                </div>
              </div>

              {/* Test Cases */}
              {bug.test_cases.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Validation Test Cases
                  </h3>
                  <div className="space-y-2">
                    {bug.test_cases.map((tc, idx) => {
                      const effectivePass = decision === 'Accepted' || tc.status === 'pass';
                      return (
                        <div
                          key={idx}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-slate-200/70 dark:border-white/10 bg-white/65 dark:bg-white/[0.04] px-3.5 py-2.5"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {tc.case_type && (
                                <span
                                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                    tc.case_type === 'invalid'
                                      ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                                      : tc.case_type === 'boundary'
                                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                      : 'bg-slate-500/15 text-slate-700 dark:text-slate-300'
                                  }`}
                                >
                                  {tc.case_type}
                                </span>
                              )}
                              <p className="font-mono text-xs text-slate-800 dark:text-slate-100 break-all">
                                Input: {tc.input}
                              </p>
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-300">
                              Expected: <span className="font-mono">{tc.expected_output}</span>
                            </p>
                          </div>
                          <span
                            className={`shrink-0 inline-flex items-center gap-1 self-start sm:self-center rounded-md px-2.5 py-1 text-xs font-semibold ${
                              effectivePass
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                : 'bg-red-500/15 text-red-700 dark:text-red-300'
                            }`}
                          >
                            {effectivePass ? (
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            {effectivePass ? 'Pass' : 'Fail'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Footer Decision Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/70 dark:border-white/15 bg-white/50 dark:bg-slate-900/50 px-5 py-3.5 sm:px-6">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Decisions are logged in Safe Change History.
              </p>

              <div className="flex items-center gap-2.5 ml-auto">
                <button
                  type="button"
                  onClick={() => onRejectPatch(bug)}
                  className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-slate-300/80 dark:border-white/20 bg-white/80 dark:bg-white/5 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-700 dark:text-slate-200 hover:border-rose-400/60 hover:text-rose-700 dark:hover:text-rose-300 hover:shadow-md cursor-pointer"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                  <span>Reject</span>
                </button>

                <button
                  type="button"
                  onClick={() => onAcceptPatch(bug)}
                  className="tactile-btn inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-lg shadow-emerald-600/25 hover:shadow-xl hover:shadow-emerald-500/30 cursor-pointer"
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                  <span>{decision === 'Accepted' ? 'Patch Applied' : 'Accept Patch'}</span>
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
