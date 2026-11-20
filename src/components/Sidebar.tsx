import { useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  AlertTriangle,
  X,
  Upload,
  Circle,
  Loader2,
  FilePlus2,
  ShieldAlert,
  Info,
  CheckCircle2,
} from 'lucide-react';
import type {
  AnalysisResponse,
  BugSeverity,
  DemoCase,
  UnifiedBugFinding,
} from '../types/autopatch';
import { sortFindingsBySeverity } from '../utils/unifiedFindings';
import { DRAWER_SPRING, VIEW_TRANSITION } from '../utils/motionPresets';

interface SidebarProps {
  demoCases: DemoCase[];
  activeDemoId: string | null;
  onSelectDemo: (demo: DemoCase) => void;
  onStartBlank: () => void;
  onUploadSource: (filename: string, content: string) => void;
  onUploadTest: (filename: string, content: string) => void;
  analysis: AnalysisResponse | null;
  isRunning: boolean;
  decisionRecorded: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  findings: UnifiedBugFinding[];
  activeFindingId: string | null;
  resolvedFindingIds: Set<string>;
  onSelectFinding: (id: string) => void;
}

const SEVERITY_BADGES: Record<
  BugSeverity,
  { label: string; badgeCls: string; Icon: typeof ShieldAlert }
> = {
  critical: {
    label: 'Critical',
    badgeCls:
      'bg-[#FF718B]/15 text-[#FF718B] border-[#FF718B]/35',
    Icon: ShieldAlert,
  },
  warning: {
    label: 'Warning',
    badgeCls:
      'bg-[#FFCA70]/15 text-[#FFCA70] border-[#FFCA70]/35',
    Icon: AlertTriangle,
  },
  info: {
    label: 'Info',
    badgeCls:
      'bg-[#50D7E6]/15 text-[#50D7E6] border-[#50D7E6]/35',
    Icon: Info,
  },
};

type StageStatus = 'idle' | 'running' | 'passed' | 'warning' | 'blocked';

interface PipelineStage {
  step: string;
  label: string;
  status: StageStatus;
  detail: string;
}

const UNIVERSAL_CODE_ACCEPT =
  '.py,.js,.mjs,.cjs,.jsx,.ts,.tsx,.mts,.c,.h,.cpp,.cc,.cxx,.hpp,.java,.go,.rs,.cs,.php,.rb,.sh,.bash,.sql,.kt,.swift,.scala,.dart,.lua,.r,.pl,.txt';

function derivePipelineStages(
  analysis: AnalysisResponse | null,
  isRunning: boolean,
  decisionRecorded: boolean
): PipelineStage[] {
  if (isRunning) {
    return [
      { step: '01', label: 'Static & AI Scan', status: 'running', detail: 'AST + Latest bug check' },
      { step: '02', label: 'Run Tests', status: 'running', detail: 'Isolated baseline run' },
      { step: '03', label: 'Prepare Line Fixes', status: 'idle', detail: 'Waiting' },
      { step: '04', label: 'Verify Patch', status: 'idle', detail: 'Waiting' },
      { step: '05', label: 'Save Decision', status: 'idle', detail: 'Waiting' },
    ];
  }

  if (!analysis) {
    return [
      { step: '01', label: 'Static & AI Scan', status: 'idle', detail: 'AST, CFG & Gemini check' },
      { step: '02', label: 'Run Tests', status: 'idle', detail: 'Isolated sandbox' },
      { step: '03', label: 'Prepare Line Fixes', status: 'idle', detail: 'One-click line repairs' },
      { step: '04', label: 'Verify Patch', status: 'idle', detail: '2.0s timeout verifier' },
      { step: '05', label: 'Save Decision', status: 'idle', detail: 'Audit ledger & export' },
    ];
  }

  const totalFindings = analysis.unifiedFindings?.length ?? analysis.astReport.findings.length;
  const stage1: PipelineStage = {
    step: '01',
    label: 'Static & AI Scan',
    status: totalFindings > 0 ? 'warning' : 'passed',
    detail: `${totalFindings} issue${totalFindings === 1 ? '' : 's'} · ${analysis.astReport.durationMs.toFixed(1)}ms`,
  };

  const stage2: PipelineStage = {
    step: '02',
    label: 'Run Tests',
    status: analysis.baseline.failed > 0 || analysis.baseline.timedOut ? 'warning' : 'passed',
    detail: analysis.baseline.timedOut
      ? `Timeout · ${analysis.baseline.durationMs.toFixed(0)}ms`
      : `${analysis.baseline.passed}/${analysis.baseline.total} pass · ${analysis.baseline.durationMs.toFixed(0)}ms`,
  };

  const stage3: PipelineStage = {
    step: '03',
    label: 'Prepare Line Fixes',
    status: analysis.patchInfo.patchApplied
      ? 'passed'
      : analysis.trustVerdict === 'already_passing'
      ? 'passed'
      : 'blocked',
    detail: analysis.patchInfo.patchApplied
      ? `+${analysis.diff.linesAdded} -${analysis.diff.linesRemoved} lines`
      : analysis.trustVerdict === 'already_passing'
      ? 'No fix needed'
      : 'Manual edit needed',
  };

  const stage4: PipelineStage = {
    step: '04',
    label: 'Verify Patch',
    status:
      analysis.trustVerdict === 'verified' || analysis.trustVerdict === 'already_passing'
        ? 'passed'
        : 'blocked',
    detail: analysis.sandbox.timedOut
      ? 'Blocked (timeout)'
      : `${analysis.sandbox.passed}/${analysis.sandbox.total} pass · ${analysis.sandbox.durationMs.toFixed(0)}ms`,
  };

  const stage5: PipelineStage = {
    step: '05',
    label: 'Save Decision',
    status: decisionRecorded ? 'passed' : analysis.trustVerdict === 'blocked' ? 'blocked' : 'warning',
    detail: decisionRecorded
      ? 'Saved to ledger'
      : analysis.trustVerdict === 'blocked'
      ? 'Review or edit line'
      : 'Ready to accept',
  };

  return [stage1, stage2, stage3, stage4, stage5];
}

export function Sidebar({
  demoCases,
  activeDemoId,
  onSelectDemo,
  onStartBlank,
  onUploadSource,
  onUploadTest,
  analysis,
  isRunning,
  decisionRecorded,
  mobileOpen,
  onCloseMobile,
  findings,
  activeFindingId,
  resolvedFindingIds,
  onSelectFinding,
}: SidebarProps) {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const testInputRef = useRef<HTMLInputElement>(null);

  const stages = derivePipelineStages(analysis, isRunning, decisionRecorded);
  const prioritizedFindings = sortFindingsBySeverity(findings);
  const criticalCount = prioritizedFindings.filter((f) => f.severity === 'critical').length;
  const warningCount = prioritizedFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = prioritizedFindings.filter((f) => f.severity === 'info').length;

  const handleFileRead = (
    file: File | undefined,
    cb: (filename: string, content: string) => void
  ) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        cb(file.name, reader.result);
      }
    };
    reader.readAsText(file);
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0E1529]/75 backdrop-blur-xl border-r border-white/10 w-[272px] shrink-0 overflow-y-auto code-scroll">
      {/* Prioritized Bug Findings with Color-Coded Severity Badges */}
      {prioritizedFindings.length > 0 && (
        <div className="p-4 border-b border-white/10">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h2 className="font-display text-xs font-semibold tracking-wide text-[#A6B0C8]">
              Bug Findings
            </h2>
            <span className="font-mono text-xs tabular-nums text-[#A6B0C8]">
              {prioritizedFindings.length}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono tabular-nums text-[#A6B0C8] mb-2.5">
            {criticalCount > 0 && (
              <span className="text-[#FF718B] font-medium">
                {criticalCount} Critical
              </span>
            )}
            {warningCount > 0 && (
              <>
                {criticalCount > 0 && <span aria-hidden="true">·</span>}
                <span className="text-[#FFCA70] font-medium">
                  {warningCount} Warning
                </span>
              </>
            )}
            {infoCount > 0 && (
              <>
                {(criticalCount > 0 || warningCount > 0) && <span aria-hidden="true">·</span>}
                <span className="text-[#50D7E6] font-medium">
                  {infoCount} Info
                </span>
              </>
            )}
          </div>

          <ul className="space-y-1.5" aria-label="Prioritized bug findings">
            {prioritizedFindings.map((finding) => {
              const isSelected = activeFindingId === finding.id;
              const isFixed = resolvedFindingIds.has(finding.id);
              const sevCfg = SEVERITY_BADGES[finding.severity];
              const SevIcon = sevCfg.Icon;

              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectFinding(finding.id);
                      onCloseMobile();
                    }}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#8B7CFF] ${
                      isSelected
                        ? 'bg-[#8B7CFF]/18 border-[#8B7CFF]/50 text-[#F4F7FF]'
                        : 'border-transparent hover:bg-white/5 text-[#F4F7FF]/90'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-medium leading-snug line-clamp-2 min-w-0">
                        {finding.title}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold border rounded whitespace-nowrap shrink-0 ${sevCfg.badgeCls}`}
                      >
                        <SevIcon className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                        <span>{sevCfg.label}</span>
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono tabular-nums text-[#A6B0C8]">
                      <span>Line {finding.line}</span>
                      {isFixed && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-0.5 font-sans font-medium text-[#51D6A2]">
                            <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                            <span>Fixed</span>
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Section 1: Sample Programs */}
      <div className="p-4 border-b border-white/10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-xs font-semibold tracking-wide text-[#A6B0C8]">
            Sample Programs
          </h2>
          <span className="font-mono text-xs tabular-nums text-[#A6B0C8]">
            {demoCases.length}
          </span>
        </div>

        <div className="space-y-1">
          {demoCases.map((demo) => {
            const isSelected = activeDemoId === demo.id;
            return (
              <button
                key={demo.id}
                type="button"
                onClick={() => {
                  onSelectDemo(demo);
                  onCloseMobile();
                }}
                aria-pressed={isSelected}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#8B7CFF] border ${
                  isSelected
                    ? 'bg-[#8B7CFF]/15 text-[#F4F7FF] border-[#8B7CFF]/45'
                    : 'text-[#F4F7FF]/85 hover:bg-white/5 hover:text-[#F4F7FF] border-transparent'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{demo.title}</span>
                  {demo.expectedOutcome === 'blocked-review' && (
                    <span className="text-[11px] font-medium text-[#FFCA70] shrink-0">
                      Review
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[#A6B0C8] truncate">
                  <span className="font-mono truncate">{demo.filename}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0">{demo.category}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Section 2: Paste New or Upload Local Files */}
      <div className="p-4 border-b border-white/10">
        <h2 className="font-display text-xs font-semibold tracking-wide text-[#A6B0C8] mb-3">
          Check Your Own Code
        </h2>

        <input
          ref={sourceInputRef}
          type="file"
          accept={UNIVERSAL_CODE_ACCEPT}
          className="sr-only"
          aria-label="Upload source code file"
          onChange={(e) => {
            handleFileRead(e.target.files?.[0], onUploadSource);
            e.target.value = '';
          }}
        />
        <input
          ref={testInputRef}
          type="file"
          accept={UNIVERSAL_CODE_ACCEPT}
          className="sr-only"
          aria-label="Upload unit test suite file"
          onChange={(e) => {
            handleFileRead(e.target.files?.[0], onUploadTest);
            e.target.value = '';
          }}
        />

        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={() => {
              onStartBlank();
              onCloseMobile();
            }}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-[#50D7E6] bg-[#50D7E6]/10 border border-[#50D7E6]/25 hover:bg-[#50D7E6]/18 rounded-lg transition-colors cursor-pointer"
          >
            <FilePlus2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Paste New Code</span>
          </button>
          <button
            type="button"
            onClick={() => sourceInputRef.current?.click()}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-[#F4F7FF] bg-white/5 border border-white/10 hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-[#A6B0C8]" aria-hidden="true" />
            <span>Upload Source File</span>
          </button>
          <button
            type="button"
            onClick={() => testInputRef.current?.click()}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-[#F4F7FF] bg-white/5 border border-white/10 hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-[#A6B0C8]" aria-hidden="true" />
            <span>Upload Test Suite</span>
          </button>
        </div>
      </div>

      {/* Section 3: Scan Progress Rail */}
      <div className="p-4 flex-1">
        <h2 className="font-display text-xs font-semibold tracking-wide text-[#A6B0C8] mb-3">
          Scan &amp; Repair Stages
        </h2>
        <ol className="space-y-3">
          {stages.map((stage) => (
            <li key={stage.step} className="flex items-start gap-2.5">
              <div className="mt-0.5 shrink-0">
                {stage.status === 'running' && (
                  <Loader2 className="w-4 h-4 text-[#50D7E6] animate-spin" aria-hidden="true" />
                )}
                {stage.status === 'passed' && (
                  <Check className="w-4 h-4 text-[#51D6A2]" aria-hidden="true" />
                )}
                {stage.status === 'warning' && (
                  <AlertTriangle className="w-4 h-4 text-[#FFCA70]" aria-hidden="true" />
                )}
                {stage.status === 'blocked' && (
                  <X className="w-4 h-4 text-[#FF718B]" aria-hidden="true" />
                )}
                {stage.status === 'idle' && (
                  <Circle className="w-3.5 h-3.5 text-white/25 mt-0.5" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[11px] tabular-nums text-[#A6B0C8]">
                    {stage.step}.
                  </span>
                  <span className="text-xs font-medium text-[#F4F7FF] truncate">
                    {stage.label}
                  </span>
                </div>
                <p className="text-xs text-[#A6B0C8] font-mono tabular-nums truncate mt-0.5">
                  {stage.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );

  return (
    <>
      <aside aria-label="Sample programs and scan stages" className="hidden lg:block shrink-0">
        {sidebarContent}
      </aside>

      {/* Frosted glass animated mobile navigation drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden flex">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={VIEW_TRANSITION}
              className="fixed inset-0 bg-[#050814]/70 backdrop-blur-sm"
              onClick={onCloseMobile}
              aria-hidden="true"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={DRAWER_SPRING}
              aria-label="Mobile workspace navigation"
              className="relative z-50 flex flex-col h-full bg-[#111930]/90 backdrop-blur-xl border-r border-white/15 shadow-2xl shadow-black/60"
            >
              <div className="flex items-center justify-between px-4 h-14 border-b border-white/10">
                <span className="font-display text-sm font-semibold text-[#F4F7FF]">
                  Programs &amp; Findings
                </span>
                <button
                  type="button"
                  onClick={onCloseMobile}
                  aria-label="Close navigation drawer"
                  className="inline-flex items-center justify-center w-10 h-10 -mr-2 rounded-lg text-[#A6B0C8] hover:text-[#F4F7FF] hover:bg-white/10 cursor-pointer"
                >
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>
              {sidebarContent}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
