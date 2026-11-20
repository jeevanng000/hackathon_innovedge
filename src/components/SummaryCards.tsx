import {
  Bug,
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle2,
  Clock,
  RefreshCw,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { AnalysisResponse, UnifiedBugFinding } from '../types/autopatch';

interface SummaryCardsProps {
  analysis: AnalysisResponse | null;
  findings: UnifiedBugFinding[];
  resolvedCount: number;
  hasLocalEdits: boolean;
  isRunning: boolean;
  isValidating: boolean;
  onOpenDiffProof: () => void;
}

export function SummaryCards({
  analysis,
  findings,
  resolvedCount,
  hasLocalEdits,
  isRunning,
  isValidating,
  onOpenDiffProof,
}: SummaryCardsProps) {
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  const isBusy = isRunning || isValidating;

  // Honest test & verification state (never claims verified while unverified local edits exist or before sandbox runs)
  let statusTitle = 'Not run yet';
  let statusSubtitle = 'Run Scan & Find Bugs to execute tests in the sandbox';
  let statusColor = 'text-[#A6B0C8]';
  let StatusIcon = Clock;

  if (isRunning) {
    statusTitle = 'Scanning...';
    statusSubtitle = 'Running static analysis, fault tracing, and baseline tests';
    statusColor = 'text-[#50D7E6]';
    StatusIcon = Loader2;
  } else if (isValidating) {
    statusTitle = 'Validating...';
    statusSubtitle = 'Re-running isolated sandbox tests against edited code';
    statusColor = 'text-[#50D7E6]';
    StatusIcon = Loader2;
  } else if (!analysis) {
    statusTitle = 'Not run yet';
    statusSubtitle = 'Start a scan to see test pass/fail results and confidence';
    statusColor = 'text-[#A6B0C8]';
    StatusIcon = Clock;
  } else if (hasLocalEdits) {
    statusTitle = 'Re-verify needed';
    statusSubtitle = 'Code was edited locally — run sandbox verification to confirm fix';
    statusColor = 'text-[#FFCA70]';
    StatusIcon = RefreshCw;
  } else if (analysis.trustVerdict === 'verified') {
    statusTitle = `${analysis.sandbox.passed} / ${analysis.sandbox.total} tests pass`;
    statusSubtitle = `Sandbox verified · Confidence ${analysis.confidence.score}%`;
    statusColor = 'text-[#51D6A2]';
    StatusIcon = CheckCircle2;
  } else if (analysis.trustVerdict === 'already_passing') {
    statusTitle = `${analysis.sandbox.passed} / ${analysis.sandbox.total} tests pass`;
    statusSubtitle = 'Baseline tests already pass cleanly';
    statusColor = 'text-[#51D6A2]';
    StatusIcon = CheckCircle2;
  } else {
    statusTitle = analysis.sandbox.timedOut
      ? 'Sandbox timed out'
      : `${analysis.sandbox.passed} / ${analysis.sandbox.total} tests pass`;
    statusSubtitle = `${analysis.sandbox.failed} failing or blocked — review needed`;
    statusColor = 'text-[#FF718B]';
    StatusIcon = XCircle;
  }

  return (
    <section
      aria-label="Scan and verification summary"
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
    >
      {/* Card 1: Total Findings */}
      <div className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-lg shadow-black/20 flex flex-col justify-between gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#A6B0C8]">
            Total Findings
          </span>
          <Bug className="w-4 h-4 text-[#8B7CFF]" aria-hidden="true" />
        </div>
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-2xl font-semibold tabular-nums text-[#F4F7FF]">
            {isRunning ? '—' : analysis ? findings.length : '0'}
          </span>
          {analysis && !isRunning && resolvedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[#51D6A2] font-mono tabular-nums">
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{resolvedCount} fixed locally</span>
            </span>
          )}
        </div>
        <p className="text-xs text-[#A6B0C8] truncate">
          {isRunning
            ? 'Scanning lines, AST, and traces...'
            : analysis
            ? findings.length === 0
              ? 'No active defects flagged in this scan'
              : `Click any highlighted finding below or press n / p`
            : 'No scan run on this snippet yet'}
        </p>
      </div>

      {/* Card 2: Severity Breakdown (Always paired with icons & text labels) */}
      <div className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-lg shadow-black/20 flex flex-col justify-between gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#A6B0C8]">
            Severity Breakdown
          </span>
          <ShieldAlert className="w-4 h-4 text-[#50D7E6]" aria-hidden="true" />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-sm tabular-nums">
          <span className="inline-flex items-center gap-1.5 text-[#FF718B] font-semibold">
            <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{isRunning || !analysis ? 0 : criticalCount}</span>
            <span className="font-sans text-xs font-medium">Critical</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-[#FFCA70] font-semibold">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{isRunning || !analysis ? 0 : warningCount}</span>
            <span className="font-sans text-xs font-medium">Warning</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-[#50D7E6] font-semibold">
            <Info className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{isRunning || !analysis ? 0 : infoCount}</span>
            <span className="font-sans text-xs font-medium">Info</span>
          </span>
        </div>
        <p className="text-xs text-[#A6B0C8] truncate">
          {analysis?.aiScanStatus?.message || 'Prioritized Critical → Warning → Info'}
        </p>
      </div>

      {/* Card 3: Test & Verification Status */}
      <div className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl p-4 shadow-lg shadow-black/20 flex flex-col justify-between gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#A6B0C8]">
            Test &amp; Verification Status
          </span>
          <StatusIcon
            className={`w-4 h-4 ${statusColor} ${isBusy ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className={`font-display text-lg font-semibold tabular-nums ${statusColor}`}>
            {statusTitle}
          </span>
          {analysis && !isRunning && (
            <button
              type="button"
              onClick={onOpenDiffProof}
              className="text-xs font-medium text-[#50D7E6] hover:text-[#F4F7FF] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B7CFF]"
            >
              Inspect Diff &rarr;
            </button>
          )}
        </div>
        <p className="text-xs text-[#A6B0C8] truncate">{statusSubtitle}</p>
      </div>
    </section>
  );
}
