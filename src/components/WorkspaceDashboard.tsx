import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type {
  AutoPatchBug,
  AutoPatchReport,
  AutoPatchSeverity,
  BatchFileResult,
  SafePatchDecision,
  WorkflowStageId,
} from '../types/autopatch';
import {
  buildBatchMarkdownExport,
  computeBatchSummary,
  findErroredLineIndices,
} from '../utils/autopatchWorkflow';
import { WorkflowPipelineBar } from './WorkflowPipelineBar';

interface WorkspaceDashboardProps {
  filename: string;
  sourceCode: string;
  report: AutoPatchReport | null;
  activeBugId: string | null;
  decisions: Record<string, SafePatchDecision>;
  isScanning: boolean;
  currentStage: WorkflowStageId;
  errorMessage: string | null;
  errorCode: string | null;
  batchResults?: BatchFileResult[];
  activeFileId?: string | null;
  onSelectFile?: (fileId: string) => void;
  onSelectBug: (bugId: string) => void;
  onRunLocalSandboxFallback: () => void;
}

const SEVERITY_STYLE: Record<AutoPatchSeverity, string> = {
  Critical:
    'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  High:
    'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  Medium:
    'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  Low:
    'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
};

export function WorkspaceDashboard({
  filename,
  sourceCode,
  report,
  activeBugId,
  decisions,
  isScanning,
  currentStage,
  errorMessage,
  errorCode,
  batchResults = [],
  activeFileId = null,
  onSelectFile,
  onSelectBug,
  onRunLocalSandboxFallback,
}: WorkspaceDashboardProps) {
  const [copied, setCopied] = useState(false);

  const bugs = report?.bugs ?? [];

  const lineToBugMap = useMemo(() => {
    const map = new Map<number, AutoPatchBug>();
    for (const bug of bugs) {
      if (decisions[bug.id] === 'Accepted') continue;
      const lines = findErroredLineIndices(
        sourceCode,
        bug.errored_statement,
        bug.before_code
      );
      for (const lineNum of lines) {
        if (!map.has(lineNum)) {
          map.set(lineNum, bug);
        }
      }
    }
    return map;
  }, [bugs, decisions, sourceCode]);

  const acceptedCount = bugs.filter((b) => decisions[b.id] === 'Accepted').length;
  const effectiveHealthScore = useMemo(() => {
    if (!report) return 0;
    const base = report.summary.health_score;
    if (bugs.length === 0) return base;
    const bonus = Math.round(((100 - base) * acceptedCount) / bugs.length);
    return Math.min(100, base + bonus);
  }, [report, bugs.length, acceptedCount]);

  const sourceLines = sourceCode.split('\n');

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(sourceCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleDownloadCode = () => {
    const blob = new Blob([sourceCode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'patched_code.py';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const batchSummary = useMemo(
    () => (batchResults.length > 1 ? computeBatchSummary(batchResults) : null),
    [batchResults]
  );

  const handleExportBatchReport = () => {
    if (batchResults.length === 0) return;
    const md = buildBatchMarkdownExport(batchResults);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autopatch-batch-report.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* Multi-File Execution Results Switcher */}
      {batchResults.length > 1 && batchSummary && (
        <div
          aria-label="Multi-file batch results switcher"
          className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/90 dark:bg-slate-900/80 backdrop-blur-md p-3.5 shadow-sm space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Multi-File Execution
              </span>
              <span className="tabular-nums rounded-md bg-indigo-500/12 px-2 py-0.5 font-semibold text-indigo-700 dark:text-indigo-300">
                {batchSummary.completedFiles}/{batchSummary.totalFiles} completed
              </span>
              <span className="tabular-nums text-slate-600 dark:text-slate-300">
                {batchSummary.totalBugs} total bug{batchSummary.totalBugs === 1 ? '' : 's'} ·{' '}
                {batchSummary.acceptedPatches} patched · Avg Health {batchSummary.averageHealthScore}/100
              </span>
            </div>

            <button
              type="button"
              onClick={handleExportBatchReport}
              className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-slate-200/80 dark:border-white/15 bg-slate-50 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Export All Results</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {batchResults.map((item) => {
              const isActive = item.fileId === activeFileId;
              const bugCount = item.report?.bugs.length ?? 0;
              return (
                <button
                  key={item.fileId}
                  type="button"
                  onClick={() => onSelectFile?.(item.fileId)}
                  className={`tactile-btn inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-mono transition-all cursor-pointer ${
                    isActive
                      ? 'border-indigo-500/60 bg-indigo-500/12 text-indigo-800 dark:text-indigo-200 font-semibold shadow-sm'
                      : 'border-slate-200/80 dark:border-white/10 bg-slate-50/80 dark:bg-white/[0.04] text-slate-700 dark:text-slate-300 hover:border-indigo-400/40'
                  }`}
                >
                  <span className="truncate max-w-[180px]">{item.filename}</span>
                  {item.status === 'scanning' ? (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-sans font-semibold text-amber-700 dark:text-amber-300">
                      Scanning…
                    </span>
                  ) : item.status === 'pending' ? (
                    <span className="rounded bg-slate-200/80 dark:bg-white/10 px-1.5 py-0.5 text-[10px] font-sans text-slate-600 dark:text-slate-400">
                      Queued
                    </span>
                  ) : item.status === 'error' ? (
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-sans font-semibold text-red-700 dark:text-red-300">
                      Error
                    </span>
                  ) : (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-sans font-semibold tabular-nums ${
                        bugCount > 0
                          ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      }`}
                    >
                      {bugCount} {bugCount === 1 ? 'bug' : 'bugs'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 5-Stage Autonomous Workflow Stepper */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <WorkflowPipelineBar
          currentStage={currentStage}
          isScanning={isScanning}
          hasCompleted={Boolean(report) && !isScanning && !errorMessage}
          hasError={Boolean(errorMessage)}
        />
      </motion.div>

      {/* Honest Actionable Error Banner */}
      {errorMessage && (
        <motion.div
          role="alert"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-red-500/35 bg-red-500/10 backdrop-blur-md px-4 py-3.5"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle
              className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400 mt-0.5"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-red-800 dark:text-red-200">
                {errorCode === 'MISSING_GEMINI_API_KEY'
                  ? 'Gemini API key is not configured on this server'
                  : 'Autonomous scan could not complete'}
              </p>
              <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">
                {errorMessage}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onRunLocalSandboxFallback}
            disabled={isScanning}
            className="tactile-btn shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3.5 py-2 text-xs font-semibold shadow-md cursor-pointer"
          >
            <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Run Local Sandbox</span>
          </button>
        </motion.div>
      )}

      {/* Loading Skeleton while scanning */}
      {isScanning && !report && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 animate-pulse">
          <div className="lg:col-span-7 h-72 rounded-3xl border border-slate-200/70 dark:border-white/10 bg-white/60 dark:bg-slate-900/50" />
          <div className="lg:col-span-5 h-72 rounded-3xl border border-slate-200/70 dark:border-white/10 bg-white/60 dark:bg-slate-900/50" />
        </div>
      )}

      {/* Populated Report Workspace */}
      {report && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-5"
        >
          {/* Summary Health Score & Prioritized Action Items */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-4 rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/92 dark:bg-slate-900/85 p-4 sm:p-5 shadow-sm flex flex-col justify-between">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Health Score
                </span>
                <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/12 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-300">
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  {report.execution_source === 'gemini' ? 'Gemini AI' : 'Local Sandbox'}
                </span>
              </div>

              <div className="my-3 flex items-baseline gap-2">
                <span className="font-display text-4xl font-bold tabular-nums text-slate-900 dark:text-white">
                  {effectiveHealthScore}
                </span>
                <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                  / 100
                </span>
              </div>

              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {report.summary.overview}
              </p>
            </div>

            <div className="md:col-span-8 rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/92 dark:bg-slate-900/85 p-4 sm:p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Prioritized Action Items
                </span>
                <span className="tabular-nums text-xs font-medium text-slate-500 dark:text-slate-400">
                  {bugs.length} issue{bugs.length === 1 ? '' : 's'} detected · {acceptedCount} patched
                </span>
              </div>

              <ul className="space-y-2">
                {report.summary.prioritized_actions.map((item, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-2.5 text-xs sm:text-sm text-slate-700 dark:text-slate-200"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500/12 text-[11px] font-semibold tabular-nums text-indigo-700 dark:text-indigo-300">
                      {idx + 1}
                    </span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Code Inspector + Detected Bugs Queue */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left: Interactive Code Surface spotlighting errored lines in red tint */}
            <div className="lg:col-span-7 overflow-hidden rounded-3xl border border-slate-200/80 dark:border-white/10 bg-white/95 dark:bg-slate-900/90 shadow-sm flex flex-col">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 dark:border-white/10 px-4 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                    {filename}
                  </span>
                  <span className="rounded-md bg-slate-100 dark:bg-white/10 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                    {report.detected_language}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    className="tactile-btn inline-flex items-center gap-1 rounded-lg border border-slate-200/80 dark:border-white/15 bg-slate-50 dark:bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleDownloadCode}
                    className="tactile-btn inline-flex items-center gap-1 rounded-lg border border-slate-200/80 dark:border-white/15 bg-slate-50 dark:bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Export</span>
                  </button>
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto code-scroll p-2 sm:p-3">
                <div className="min-w-full font-mono text-xs leading-6">
                  {sourceLines.map((lineText, idx) => {
                    const lineNumber = idx + 1;
                    const linkedBug = lineToBugMap.get(lineNumber);
                    const isActiveLine = linkedBug && linkedBug.id === activeBugId;

                    return (
                      <div
                        key={lineNumber}
                        onClick={() => linkedBug && onSelectBug(linkedBug.id)}
                        className={`flex items-start gap-3 rounded-lg px-2.5 py-0.5 transition-colors ${
                          linkedBug
                            ? `cursor-pointer bg-red-500/12 border-l-2 border-red-500 hover:bg-red-500/20 ${
                                isActiveLine ? 'ring-1 ring-red-500/40' : ''
                              }`
                            : 'hover:bg-slate-900/[0.03] dark:hover:bg-white/[0.03]'
                        }`}
                      >
                        <span className="w-7 shrink-0 select-none text-right tabular-nums text-slate-400 dark:text-slate-500">
                          {lineNumber}
                        </span>
                        <span
                          className={`whitespace-pre flex-1 ${
                            linkedBug
                              ? 'text-red-800 dark:text-red-200 font-medium'
                              : 'text-slate-800 dark:text-slate-200'
                          }`}
                        >
                          {lineText || ' '}
                        </span>
                        {linkedBug && (
                          <span className="shrink-0 self-center rounded-md bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-200">
                            Inspect
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right: Detected Bugs Queue */}
            <div className="lg:col-span-5 rounded-3xl border border-slate-200/80 dark:border-white/10 bg-white/95 dark:bg-slate-900/90 p-4 sm:p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                  Detected Bugs ({bugs.length})
                </h2>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  N/P navigate · Enter inspect
                </span>
              </div>

              {bugs.length === 0 ? (
                <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-5 text-center space-y-2">
                  <CheckCircle2
                    className="mx-auto h-7 w-7 text-emerald-600 dark:text-emerald-400"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                    Clean bill of health
                  </p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    No unresolved bugs were flagged in this snippet.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {bugs.map((bug) => {
                    const isSelected = bug.id === activeBugId;
                    const decision = decisions[bug.id];
                    return (
                      <button
                        key={bug.id}
                        type="button"
                        onClick={() => onSelectBug(bug.id)}
                        className={`tactile-btn w-full text-left rounded-2xl border p-3.5 transition-all cursor-pointer ${
                          isSelected
                            ? 'border-indigo-500/50 bg-indigo-500/[0.08] shadow-md shadow-indigo-500/10'
                            : 'border-slate-200/80 dark:border-white/10 bg-white/70 dark:bg-white/[0.03] hover:border-indigo-400/40 hover:shadow-md hover:shadow-indigo-500/10'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                              SEVERITY_STYLE[bug.severity]
                            }`}
                          >
                            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                            {bug.severity}
                          </span>

                          <div className="flex items-center gap-2">
                            <span className="tabular-nums text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                              {bug.confidence}% conf
                            </span>
                            {decision && (
                              <span
                                className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
                                  decision === 'Accepted'
                                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                    : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                                }`}
                              >
                                {decision === 'Accepted' ? (
                                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                ) : (
                                  <XCircle className="h-3 w-3" aria-hidden="true" />
                                )}
                                {decision}
                              </span>
                            )}
                          </div>
                        </div>

                        <p className="font-display text-sm font-semibold text-slate-900 dark:text-white">
                          {bug.title}
                        </p>

                        <p className="mt-1 truncate font-mono text-[11px] text-red-700 dark:text-red-300">
                          {bug.errored_statement}
                        </p>

                        <div className="mt-2 flex items-center justify-between text-[11px] text-indigo-600 dark:text-indigo-300 font-medium">
                          <span>Open Glass Diff &amp; Root Cause</span>
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
