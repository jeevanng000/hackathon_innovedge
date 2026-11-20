import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CheckCircle2,
  ShieldAlert,
  XCircle,
  Download,
  Copy,
  Check,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Mic,
  Clock,
} from 'lucide-react';
import type {
  AnalysisResponse,
  AuditDecision,
  VoiceNote,
} from '../types/autopatch';
import {
  evaluateTrustGate,
  formatStructuredMarkdownReport,
} from '../utils/diffAndAudit';
import {
  detectLanguageFromFilename,
  getLanguageMeta,
  type SupportedLanguage,
} from '../utils/languageDetect';
import { PANEL_TRANSITION, VIEW_TRANSITION } from '../utils/motionPresets';
import { AnalysisDiagnosticsPanel } from './AnalysisDiagnosticsPanel';

interface DiffReviewViewProps {
  analysis: AnalysisResponse | null;
  testCode: string;
  activeDecision: AuditDecision | null;
  onAcceptPatch: (overrideReason?: string) => void;
  onRejectPatch: () => void;
  onDownloadPatched: () => void;
  onValidateManualPatch: (candidateCode: string) => Promise<void>;
  isValidatingManual: boolean;
  onBackToWorkbench: () => void;
  voiceNotes?: VoiceNote[];
  embedded?: boolean;
}

type DiffTab = 'split' | 'unified' | 'report' | 'edit';

export function DiffReviewView({
  analysis,
  testCode,
  activeDecision,
  onAcceptPatch,
  onRejectPatch,
  onDownloadPatched,
  onValidateManualPatch,
  isValidatingManual,
  onBackToWorkbench,
  voiceNotes = [],
  embedded = false,
}: DiffReviewViewProps) {
  const [diffTab, setDiffTab] = useState<DiffTab>('split');
  const [manualCode, setManualCode] = useState(analysis?.patchedCode ?? '');
  const [showConfidenceDetails, setShowConfidenceDetails] = useState(false);
  const [copiedDiff, setCopiedDiff] = useState(false);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [expandedTraceback, setExpandedTraceback] = useState<string | null>(null);

  useEffect(() => {
    setManualCode(analysis?.patchedCode ?? '');
    setOverrideEnabled(false);
    setOverrideReason('');
    setExpandedTraceback(null);
    setDiffTab('split');
  }, [analysis]);

  const containerCls = embedded
    ? 'space-y-5'
    : 'max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6';

  if (!analysis) {
    return (
      <div className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl px-6 py-14 text-center space-y-4 shadow-lg shadow-black/20">
        <h2 className="font-display text-xl font-semibold text-[#F4F7FF]">
          No Patch Diff or Validation Results Yet
        </h2>
        <p className="text-sm text-[#A6B0C8] max-w-md mx-auto">
          Click <strong className="text-[#F4F7FF]">Scan &amp; Find Bugs</strong> in the top bar to analyze your code, generate a proposed diff, and execute sandbox verification tests.
        </p>
        <button
          type="button"
          onClick={onBackToWorkbench}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-[#F4F7FF] bg-[#8B7CFF] hover:bg-[#7A69FF] rounded-lg transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Return to Bug Inspector</span>
        </button>
      </div>
    );
  }

  const resolvedLang: SupportedLanguage =
    (analysis.language as SupportedLanguage | undefined) ??
    detectLanguageFromFilename(analysis.filename);
  const langMeta = getLanguageMeta(resolvedLang);

  const gate = evaluateTrustGate({
    verdict: analysis.trustVerdict,
    overrideEnabled,
    overrideReason,
  });

  const structuredReport = formatStructuredMarkdownReport(
    analysis,
    testCode,
    activeDecision,
    voiceNotes
  );

  const combinedTranscriptReasoning = voiceNotes
    .map((n) => n.transcript.trim())
    .filter(Boolean)
    .join(' ');

  const handleCopyUnified = () => {
    const text =
      diffTab === 'report'
        ? structuredReport
        : analysis.diff.unified || 'No changes';
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedDiff(true);
    window.setTimeout(() => setCopiedDiff(false), 1800);
  };

  const handleDownloadReport = () => {
    const blob = new Blob([structuredReport], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const baseName = analysis.filename.replace(/\.[^.]+$/, '');
    anchor.download = `${baseName}-autopatch-report.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const baselineMap = new Map(analysis.baseline.tests.map((t) => [t.name, t]));
  const allTestNames = Array.from(
    new Set([
      ...analysis.baseline.tests.map((t) => t.name),
      ...analysis.sandbox.tests.map((t) => t.name),
    ])
  );
  const sandboxMap = new Map(analysis.sandbox.tests.map((t) => [t.name, t]));

  const isApproved = activeDecision === 'accepted' || activeDecision === 'override';

  return (
    <div className={containerCls}>
      {/* Sub-Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 border-b border-white/10">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#A6B0C8]">
            <button
              type="button"
              onClick={onBackToWorkbench}
              className="hover:text-[#F4F7FF] transition-colors cursor-pointer"
            >
              Bug Inspector
            </button>
            <span aria-hidden="true">/</span>
            <span className="font-mono text-[#F4F7FF]">{analysis.filename}</span>
            <span aria-hidden="true">·</span>
            <span>{langMeta.label}</span>
            <span aria-hidden="true">·</span>
            <span>Diff &amp; Trust Review</span>
          </div>
          <h2 className="font-display text-xl font-semibold tracking-tight text-[#F4F7FF] text-balance">
            Proposed Patch Diff &amp; Sandbox Proof
          </h2>
        </div>

        <div className="flex items-center gap-2 text-sm font-medium shrink-0">
          {analysis.trustVerdict === 'verified' && (
            <>
              <CheckCircle2 className="w-4 h-4 text-[#51D6A2]" aria-hidden="true" />
              <span className="text-[#51D6A2]">Sandbox Verified</span>
            </>
          )}
          {analysis.trustVerdict === 'blocked' && (
            <>
              <ShieldAlert className="w-4 h-4 text-[#FF718B]" aria-hidden="true" />
              <span className="text-[#FF718B]">Blocked — Human Review Required</span>
            </>
          )}
          {analysis.trustVerdict === 'already_passing' && (
            <>
              <CheckCircle2 className="w-4 h-4 text-[#50D7E6]" aria-hidden="true" />
              <span className="text-[#50D7E6]">Baseline Already Passing</span>
            </>
          )}
        </div>
      </div>

      {/* 4-Column Metric Strip */}
      <section
        aria-label="Patch verification metrics"
        className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 divide-x divide-white/10 shadow-lg shadow-black/20"
      >
        <div className="p-4">
          <div className="text-xs text-[#A6B0C8]">Detected Defect</div>
          <div className="mt-1 font-mono text-sm font-semibold text-[#F4F7FF] truncate">
            {analysis.patchInfo.bugType}
          </div>
          <div className="mt-0.5 text-xs text-[#A6B0C8] font-mono tabular-nums">
            {analysis.patchInfo.targetLine
              ? `Line ${analysis.patchInfo.targetLine}`
              : 'Module scope'}{' '}
            · +{analysis.diff.linesAdded} -{analysis.diff.linesRemoved}
          </div>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#A6B0C8]">Confidence Score</span>
            <button
              type="button"
              onClick={() => setShowConfidenceDetails((prev) => !prev)}
              aria-expanded={showConfidenceDetails}
              className="text-xs font-medium text-[#50D7E6] hover:text-[#F4F7FF] inline-flex items-center gap-0.5 cursor-pointer"
            >
              <span>Breakdown</span>
              {showConfidenceDetails ? (
                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-[#F4F7FF]">
            {analysis.confidence.score}%
          </div>
          <div className="mt-0.5 text-xs text-[#A6B0C8] truncate">
            {analysis.patchInfo.ruleId}
          </div>
        </div>

        <div className="p-4">
          <div className="text-xs text-[#A6B0C8]">Baseline Run</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-[#F4F7FF]">
            {analysis.baseline.timedOut
              ? 'Timeout'
              : `${analysis.baseline.passed} / ${analysis.baseline.total}`}
          </div>
          <div className="mt-0.5 text-xs text-[#A6B0C8] font-mono tabular-nums">
            {analysis.baseline.durationMs.toFixed(0)} ms isolated
          </div>
        </div>

        <div className="p-4">
          <div className="text-xs text-[#A6B0C8]">Sandbox Validation</div>
          <div
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
              analysis.trustVerdict === 'verified' || analysis.trustVerdict === 'already_passing'
                ? 'text-[#51D6A2]'
                : 'text-[#FF718B]'
            }`}
          >
            {analysis.sandbox.timedOut
              ? 'Timeout'
              : `${analysis.sandbox.passed} / ${analysis.sandbox.total}`}
          </div>
          <div className="mt-0.5 text-xs text-[#A6B0C8] font-mono tabular-nums">
            {analysis.sandbox.durationMs.toFixed(0)} ms isolated
          </div>
        </div>
      </section>

      {/* Expandable Transparent Confidence Breakdown */}
      <AnimatePresence initial={false}>
        {showConfidenceDetails && (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={PANEL_TRANSITION}
            aria-label="Confidence score deterministic breakdown"
            className="overflow-hidden"
          >
            <div className="bg-[#111930]/75 backdrop-blur-md border border-white/10 rounded-xl p-5 shadow-lg shadow-black/20">
              <h3 className="font-display text-sm font-semibold text-[#F4F7FF] mb-3">
                Deterministic Confidence Breakdown ({analysis.confidence.score} / 100)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {analysis.confidence.factors.map((factor) => (
                  <div key={factor.label} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-[#F4F7FF]">
                        {factor.label}
                      </span>
                      <span className="font-mono tabular-nums text-[#50D7E6]">
                        {factor.points}/{factor.maxPoints}
                      </span>
                    </div>
                    <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-[#8B7CFF] to-[#50D7E6] rounded-full"
                        style={{
                          width: `${Math.round((factor.points / factor.maxPoints) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="text-xs text-[#A6B0C8]">{factor.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Root-Cause Diagnosis & Patch Strategy */}
      <section
        aria-label="Root cause diagnosis and patch strategy"
        className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl p-5 grid grid-cols-1 lg:grid-cols-2 gap-6 shadow-lg shadow-black/20"
      >
        <div className="space-y-1.5">
          <h3 className="font-display text-xs font-semibold tracking-wide text-[#50D7E6]">
            Root-Cause Diagnosis
          </h3>
          <p className="text-sm text-[#F4F7FF]/90 leading-relaxed">
            {analysis.patchInfo.rootCause}
          </p>
        </div>
        <div className="space-y-1.5">
          <h3 className="font-display text-xs font-semibold tracking-wide text-[#8B7CFF]">
            Proposed Patch Strategy
          </h3>
          <p className="text-sm text-[#F4F7FF]/90 leading-relaxed">
            {analysis.patchInfo.strategy}
          </p>
        </div>
      </section>

      {/* Diff Viewer / Manual Patch Re-Verification */}
      <section
        aria-label="Inspectable git diff viewer"
        className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-xl shadow-black/25"
      >
        <div className="px-4 py-3 bg-[#0D1426]/80 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Diff view mode"
            className="inline-flex items-center gap-1 p-1 bg-[#0B1020]/80 border border-white/10 rounded-lg overflow-x-auto max-w-full"
          >
            {(
              [
                { id: 'split', label: 'Side-by-Side Diff' },
                { id: 'unified', label: 'Unified Diff' },
                { id: 'report', label: '5-Section Triage Report' },
                { id: 'edit', label: 'Edit Patch & Re-Verify' },
              ] as Array<{ id: DiffTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={diffTab === tab.id}
                onClick={() => setDiffTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  diffTab === tab.id
                    ? 'bg-[#8B7CFF] text-white shadow-sm'
                    : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
            <span className="text-[#51D6A2]">+{analysis.diff.linesAdded} added</span>
            <span className="text-[#FF718B]">-{analysis.diff.linesRemoved} removed</span>
            {(diffTab === 'unified' || diffTab === 'report') && (
              <button
                type="button"
                onClick={handleCopyUnified}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-sans font-medium text-[#F4F7FF] bg-white/8 border border-white/12 hover:bg-white/14 rounded-md transition-colors cursor-pointer"
              >
                {copiedDiff ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#51D6A2]" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#A6B0C8]" aria-hidden="true" />
                    <span>{diffTab === 'report' ? 'Copy Markdown Report' : 'Copy Diff'}</span>
                  </>
                )}
              </button>
            )}
            {diffTab === 'report' && (
              <button
                type="button"
                onClick={handleDownloadReport}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-sans font-medium text-[#F4F7FF] bg-white/8 border border-white/12 hover:bg-white/14 rounded-md transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#A6B0C8]" aria-hidden="true" />
                <span>Download .md</span>
              </button>
            )}
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {/* Tab 1: Side-by-Side Colorized Git Diff */}
          {diffTab === 'split' && (
            <motion.div
              key="split"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={VIEW_TRANSITION}
              className="code-scroll overflow-x-auto bg-[#0B1020]/70"
            >
              <table className="w-full min-w-[720px] table-fixed border-collapse font-mono text-[12px] leading-6">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-[calc(50%-2.5rem)]" />
                  <col className="w-10" />
                  <col className="w-[calc(50%-2.5rem)]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-white/10 bg-[#0D1426]/85 text-left text-[11px] text-[#A6B0C8]">
                    <th className="px-2 py-1.5 text-right font-normal border-r border-white/10">
                      Old
                    </th>
                    <th className="px-3 py-1.5 font-medium border-r border-white/10 truncate">
                      a/{analysis.filename} (Before)
                    </th>
                    <th className="px-2 py-1.5 text-right font-normal border-r border-white/10">
                      New
                    </th>
                    <th className="px-3 py-1.5 font-medium truncate">
                      b/{analysis.filename} (After / Proposed Fix)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.diff.sideBySide.map((row, idx) => {
                    const leftRemoved =
                      row.leftText !== null &&
                      (row.type === 'delete' || row.type === 'replace');
                    const rightAdded =
                      row.rightText !== null &&
                      (row.type === 'insert' || row.type === 'replace');

                    return (
                      <tr
                        key={idx}
                        className="border-b border-white/[0.04] last:border-b-0"
                      >
                        <td
                          className={`px-2 py-0.5 text-right align-top select-none tabular-nums border-r border-white/10 ${
                            leftRemoved
                              ? 'bg-[#FF718B]/20 text-[#FF718B]'
                              : 'bg-[#090E1C]/60 text-[#A6B0C8]/60'
                          }`}
                        >
                          {row.leftLine ?? ''}
                        </td>
                        <td
                          className={`px-3 py-0.5 align-top whitespace-pre-wrap break-words border-r border-white/10 ${
                            leftRemoved
                              ? 'bg-[#FF718B]/12 text-[#FFB3C1]'
                              : row.leftText === null
                              ? 'bg-[#090E1C]/40'
                              : 'text-[#F4F7FF]'
                          }`}
                        >
                          {leftRemoved
                            ? `- ${row.leftText}`
                            : row.leftText !== null
                            ? `  ${row.leftText}`
                            : ''}
                        </td>
                        <td
                          className={`px-2 py-0.5 text-right align-top select-none tabular-nums border-r border-white/10 ${
                            rightAdded
                              ? 'bg-[#51D6A2]/20 text-[#51D6A2]'
                              : 'bg-[#090E1C]/60 text-[#A6B0C8]/60'
                          }`}
                        >
                          {row.rightLine ?? ''}
                        </td>
                        <td
                          className={`px-3 py-0.5 align-top whitespace-pre-wrap break-words ${
                            rightAdded
                              ? 'bg-[#51D6A2]/12 text-[#8EF0C9]'
                              : row.rightText === null
                              ? 'bg-[#090E1C]/40'
                              : 'text-[#F4F7FF]'
                          }`}
                        >
                          {rightAdded
                            ? `+ ${row.rightText}`
                            : row.rightText !== null
                            ? `  ${row.rightText}`
                            : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </motion.div>
          )}

          {/* Tab 2: Unified Diff */}
          {diffTab === 'unified' && (
            <motion.div
              key="unified"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={VIEW_TRANSITION}
              className="p-4 bg-[#0B1020]/75 code-scroll overflow-x-auto"
            >
              {analysis.diff.unified ? (
                <pre className="font-mono text-[12.5px] leading-6">
                  {analysis.diff.unified.split('\n').map((line, i) => {
                    let cls = 'text-[#F4F7FF]';
                    if (line.startsWith('+') && !line.startsWith('+++')) {
                      cls = 'bg-[#51D6A2]/14 text-[#8EF0C9]';
                    } else if (line.startsWith('-') && !line.startsWith('---')) {
                      cls = 'bg-[#FF718B]/14 text-[#FFB3C1]';
                    } else if (line.startsWith('@@')) {
                      cls = 'text-[#50D7E6] font-medium';
                    }
                    return (
                      <div key={i} className={`px-2 ${cls}`}>
                        {line || ' '}
                      </div>
                    );
                  })}
                </pre>
              ) : (
                <p className="text-xs text-[#A6B0C8]">
                  No textual differences between original source and candidate code.
                </p>
              )}
            </motion.div>
          )}

          {/* Tab 3: 5-Section Structured Triage & Repair Report */}
          {diffTab === 'report' && (
            <motion.div
              key="report"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={VIEW_TRANSITION}
              className="p-4 bg-[#0B1020]/75 code-scroll overflow-x-auto"
            >
              <pre className="font-mono text-[12.5px] leading-6 text-[#F4F7FF] whitespace-pre-wrap">
                {structuredReport}
              </pre>
            </motion.div>
          )}

          {/* Tab 4: Edit Patch & Re-Verify in Sandbox */}
          {diffTab === 'edit' && (
            <motion.div
              key="edit"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={VIEW_TRANSITION}
              className="p-4 space-y-3 bg-[#0B1020]/60"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-[#A6B0C8]">
                  Edit the candidate {langMeta.label} file below and re-run isolated verification. Original source remains untouched until you accept.
                </p>
                <button
                  type="button"
                  onClick={() => onValidateManualPatch(manualCode)}
                  disabled={isValidatingManual}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#8B7CFF] hover:bg-[#7A69FF] disabled:bg-white/15 disabled:text-[#A6B0C8] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${isValidatingManual ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>
                    {isValidatingManual ? 'Validating...' : 'Re-Run Sandbox Verification'}
                  </span>
                </button>
              </div>
              <textarea
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                spellCheck={false}
                aria-label="Editable candidate patch code"
                rows={13}
                className="code-editor code-scroll w-full rounded-lg border border-white/15 bg-[#070B16]/90 px-4 py-3 font-mono text-[13px] leading-6 text-[#F4F7FF] focus:outline-none focus:border-[#8B7CFF] focus:ring-2 focus:ring-[#8B7CFF]/25 whitespace-pre"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Spectrum-Based Fault Localization, Static Taint/CFG & APR Repair Trace */}
      <AnalysisDiagnosticsPanel
        key={`${analysis.filename}-${resolvedLang}-${analysis.patchInfo.ruleId}-${analysis.diff.linesAdded}-${analysis.diff.linesRemoved}`}
        analysis={analysis}
      />

      {/* Sandbox Verification Test Matrix */}
      <section
        aria-label="Sandbox test execution comparison"
        className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-lg shadow-black/20"
      >
        <div className="px-5 py-3.5 bg-[#0D1426]/80 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-sm font-semibold text-[#F4F7FF]">
            Sandbox Verification Results ({analysis.testFilename})
          </h3>
          <span className="text-xs font-mono tabular-nums text-[#A6B0C8]">
            Timeout budget: 2.0s · {langMeta.runtimeLabel}
          </span>
        </div>

        <div className="overflow-x-auto bg-[#0B1020]/50">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-[#0D1426]/70 text-xs text-[#A6B0C8]">
                <th className="py-2.5 px-5 font-medium">Test / Verification Check</th>
                <th className="py-2.5 px-4 font-medium">Baseline</th>
                <th className="py-2.5 px-4 font-medium">Sandbox Candidate</th>
                <th className="py-2.5 px-5 font-medium text-right">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {allTestNames.map((name) => {
                const base = baselineMap.get(name);
                const sand = sandboxMap.get(name);
                const tb = sand?.traceback || base?.traceback;
                const isExpanded = expandedTraceback === name;

                return (
                  <tr key={name} className="hover:bg-white/[0.03] transition-colors">
                    <td className="py-2.5 px-5 align-top">
                      <div className="font-mono text-xs text-[#F4F7FF]">{name}</div>
                      {tb && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedTraceback(isExpanded ? null : name)
                          }
                          className="mt-1 text-[11px] font-medium text-[#50D7E6] hover:text-[#F4F7FF] cursor-pointer"
                        >
                          {isExpanded ? 'Hide traceback' : 'View traceback'}
                        </button>
                      )}
                      <AnimatePresence initial={false}>
                        {isExpanded && tb && (
                          <motion.pre
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={PANEL_TRANSITION}
                            className="mt-2 p-2.5 bg-[#070B16]/90 border border-white/12 rounded-lg font-mono text-[11px] leading-5 text-[#F4F7FF]/90 overflow-x-auto max-w-xl whitespace-pre-wrap"
                          >
                            {tb}
                          </motion.pre>
                        )}
                      </AnimatePresence>
                    </td>
                    <td className="py-2.5 px-4 align-top text-xs">
                      {!base ? (
                        <span className="inline-flex items-center gap-1 text-[#A6B0C8]">
                          <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Not run</span>
                        </span>
                      ) : base.status === 'passed' ? (
                        <span className="inline-flex items-center gap-1 text-[#51D6A2] font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Pass</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[#FF718B] font-medium">
                          <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{base.errorType || 'Fail'}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 align-top text-xs">
                      {!sand ? (
                        <span className="inline-flex items-center gap-1 text-[#A6B0C8]">
                          <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Not run</span>
                        </span>
                      ) : sand.status === 'passed' ? (
                        <span className="inline-flex items-center gap-1 text-[#51D6A2] font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Pass</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[#FF718B] font-medium">
                          <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{sand.errorType || 'Fail'}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-5 align-top text-right font-mono text-xs tabular-nums text-[#A6B0C8]">
                      {(sand?.durationMs ?? base?.durationMs ?? 0).toFixed(2)} ms
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Trust Decision & Human Override Gate */}
      <section
        aria-label="Patch approval and trust gate"
        className="bg-[#111930]/75 backdrop-blur-md border border-white/12 rounded-xl p-5 space-y-4 shadow-xl shadow-black/25"
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="font-display text-sm font-semibold text-[#F4F7FF]">
              Developer Trust Decision
            </h3>
            <p className="text-xs text-[#A6B0C8]">
              {activeDecision === 'accepted'
                ? 'Patch accepted and logged to History. Original source updated in Dashboard and ready for download.'
                : activeDecision === 'override'
                ? 'Patch accepted via Human Override and logged with your justification in History.'
                : activeDecision === 'rejected'
                ? 'Patch rejected and recorded in History. Original source remains unmodified.'
                : gate.reason}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() =>
                onAcceptPatch(gate.requiresOverride ? overrideReason : undefined)
              }
              disabled={!gate.canAcceptNow || activeDecision === 'accepted' || activeDecision === 'override'}
              className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-semibold text-[#0B1020] bg-[#51D6A2] hover:bg-[#42c390] disabled:bg-white/10 disabled:text-[#A6B0C8] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                {gate.requiresOverride ? 'Accept with Override' : 'Accept Patch'}
              </span>
            </button>

            <button
              type="button"
              onClick={onRejectPatch}
              disabled={activeDecision === 'rejected'}
              className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-medium text-[#FF718B] bg-[#FF718B]/10 border border-[#FF718B]/30 hover:bg-[#FF718B]/20 disabled:opacity-45 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Reject Patch</span>
            </button>

            <button
              type="button"
              onClick={onDownloadPatched}
              disabled={!isApproved}
              className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-medium text-[#F4F7FF] bg-white/8 border border-white/15 hover:bg-white/15 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
              <span>Download {analysis.filename}</span>
            </button>
          </div>
        </div>

        {/* Attached Developer Voice Notes */}
        {voiceNotes.length > 0 && (
          <div className="pt-4 border-t border-white/10 space-y-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-[#F4F7FF]">
              <Mic className="w-3.5 h-3.5 text-[#FF718B]" aria-hidden="true" />
              <span>Attached Developer Voice Notes ({voiceNotes.length})</span>
            </div>
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {voiceNotes.map((note) => (
                <li
                  key={note.id}
                  className="p-3 bg-[#0B1020]/70 border border-white/10 rounded-lg space-y-1.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2 text-[#A6B0C8]">
                    <span className="font-mono font-semibold tabular-nums text-[#50D7E6]">
                      Line {note.line}
                    </span>
                    <span className="truncate font-medium text-[#F4F7FF]">
                      {note.bugTitle}
                    </span>
                  </div>
                  <audio
                    controls
                    preload="metadata"
                    src={note.audioDataUrl}
                    className="w-full h-8"
                  />
                  {note.transcript.trim() && (
                    <p className="text-xs text-[#F4F7FF]/90 leading-relaxed">
                      &ldquo;{note.transcript.trim()}&rdquo;
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Explicit Human Override Panel when Sandbox Blocks the Patch */}
        {gate.requiresOverride && activeDecision !== 'override' && (
          <div className="pt-4 border-t border-white/10 space-y-3">
            <label className="inline-flex items-center gap-2.5 text-xs font-medium text-[#F4F7FF] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={overrideEnabled}
                onChange={(e) => setOverrideEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-white/25 bg-[#0B1020] text-[#8B7CFF] focus:ring-[#8B7CFF]"
              />
              <span>
                Enable Human Override (unlock blocked patch approval with mandatory audit justification)
              </span>
            </label>

            {overrideEnabled && (
              <div className="space-y-1.5 max-w-xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="override-reason"
                    className="block text-xs font-medium text-[#A6B0C8]"
                  >
                    Override Justification (minimum 8 characters)
                  </label>
                  {combinedTranscriptReasoning && (
                    <button
                      type="button"
                      onClick={() => setOverrideReason(combinedTranscriptReasoning)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#50D7E6] hover:text-[#F4F7FF] cursor-pointer"
                    >
                      <Mic className="w-3 h-3" aria-hidden="true" />
                      <span>Use Voice Note Reasoning</span>
                    </button>
                  )}
                </div>
                <input
                  id="override-reason"
                  type="text"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Exporting annotated file to implement dead-letter queue manually"
                  className="w-full px-3 py-2 text-xs text-[#F4F7FF] placeholder:text-[#A6B0C8]/60 bg-[#070B16]/90 border border-white/15 rounded-lg focus:outline-none focus:border-[#8B7CFF] focus:ring-2 focus:ring-[#8B7CFF]/25"
                />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
