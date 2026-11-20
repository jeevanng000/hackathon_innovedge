import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  RotateCcw,
  AlertCircle,
  Wand2,
  Undo2,
  RefreshCw,
  FolderOpen,
  ChevronDown,
  ChevronUp,
  Bug,
  GitCompare,
  Terminal,
  BookOpen,
  Cpu,
} from 'lucide-react';
import type {
  AnalysisResponse,
  AuditDecision,
  DashboardTab,
  ExplanationMode,
  UnifiedBugFinding,
  VoiceNote,
} from '../types/autopatch';
import {
  SUPPORTED_LANGUAGES,
  getLanguageMeta,
  type SupportedLanguage,
} from '../utils/languageDetect';
import {
  highlightCodeWithPrism,
  resolvePrismLanguage,
} from '../utils/syntaxHighlight';
import { PANEL_TRANSITION, VIEW_TRANSITION } from '../utils/motionPresets';
import { WorkflowStepper } from './WorkflowStepper';
import { SummaryCards } from './SummaryCards';
import { BugCodeStage, type CodeStageMode } from './BugCodeStage';
import { DiffReviewView } from './DiffReviewView';

interface WorkbenchViewProps {
  filename: string;
  testFilename: string;
  sourceCode: string;
  testCode: string;
  bugContext: string;
  caseDescription: string;
  selectedLanguage: 'auto' | SupportedLanguage;
  resolvedLanguage: SupportedLanguage;
  onChangeLanguage: (lang: 'auto' | SupportedLanguage) => void;
  onChangeFilename: (name: string) => void;
  onChangeTestFilename: (name: string) => void;
  onChangeSourceCode: (code: string) => void;
  onChangeTestCode: (code: string) => void;
  onChangeBugContext: (ctx: string) => void;
  onUploadSource: (filename: string, content: string) => void;
  onResetDemo: () => void;
  canResetDemo: boolean;
  analysis: AnalysisResponse | null;
  unifiedFindings: UnifiedBugFinding[];
  activeFindingId: string | null;
  onSelectFinding: (id: string | null) => void;
  resolvedFindingIds: Set<string>;
  onApplyFix: (finding: UnifiedBugFinding) => void;
  onApplyAllSafeFixes: () => void;
  onUndoFix: () => void;
  canUndoFix: boolean;
  hasLocalEdits: boolean;
  onVerifyCurrentCode: () => Promise<void>;
  isValidating: boolean;
  isRunning: boolean;
  errorMessage: string | null;
  dashboardTab: DashboardTab;
  onChangeDashboardTab: (tab: DashboardTab) => void;
  onOpenProjects: () => void;
  explanationMode: ExplanationMode;
  onChangeExplanationMode: (mode: ExplanationMode) => void;
  stageMode: CodeStageMode;
  onChangeStageMode: (mode: CodeStageMode) => void;
  voiceNotes: VoiceNote[];
  onAddVoiceNote: (note: VoiceNote) => void;
  onUpdateVoiceNote: (noteId: string, patch: Partial<VoiceNote>) => void;
  onDeleteVoiceNote: (noteId: string) => void;
  activeDecision: AuditDecision | null;
  auditCount: number;
  onRunAnalysis: () => void;
  onOpenAudit: () => void;
  onAcceptPatch: (overrideReason?: string) => void;
  onRejectPatch: () => void;
  onDownloadPatched: () => void;
  onValidateManualPatch: (candidateCode: string) => Promise<void>;
}

function PrismTestEditor({
  filename,
  onChangeFilename,
  value,
  onChange,
  language,
}: {
  filename: string;
  onChangeFilename: (val: string) => void;
  value: string;
  onChange: (val: string) => void;
  language: SupportedLanguage;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const highlightPreRef = useRef<HTMLPreElement>(null);
  const lines = value.split('\n');
  const lineCount = lines.length;

  const effectiveLang = useMemo(
    () => resolvePrismLanguage(language, filename),
    [language, filename]
  );

  const highlightedHtml = useMemo(
    () => highlightCodeWithPrism(value, effectiveLang, filename),
    [value, effectiveLang, filename]
  );

  const langMeta = getLanguageMeta(effectiveLang);

  return (
    <div className="flex flex-col bg-[#0B1020]/75 border border-white/10 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2 bg-[#0D1426]/85 border-b border-white/10">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <label
            htmlFor="test-editor-filename"
            className="text-xs font-medium text-[#A6B0C8] shrink-0"
          >
            Test Suite
          </label>
          <span aria-hidden="true" className="text-white/25">
            /
          </span>
          <input
            id="test-editor-filename"
            type="text"
            value={filename}
            onChange={(e) => onChangeFilename(e.target.value)}
            aria-label="Unit test suite filename"
            className="font-mono text-xs font-medium text-[#F4F7FF] bg-transparent border-b border-transparent hover:border-white/25 focus:border-[#8B7CFF] focus:outline-none px-1 py-0.5 min-w-0 w-full max-w-[220px]"
          />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-[#A6B0C8] shrink-0">
          <span>{langMeta.label}</span>
          <span aria-hidden="true">·</span>
          <span>{lineCount} lines</span>
        </div>
      </div>

      <div className="relative flex min-h-[190px] max-h-[280px] overflow-hidden bg-[#070B16]/85">
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="select-none bg-[#090E1C]/70 border-r border-white/10 py-3 px-2.5 text-right font-mono text-xs leading-6 text-[#A6B0C8]/65 tabular-nums overflow-hidden shrink-0 w-10 z-10"
        >
          {Array.from({ length: Math.max(lineCount, 8) }, (_, idx) => (
            <div key={idx + 1}>{idx + 1}</div>
          ))}
        </div>

        <div className="relative flex-1 min-w-0 overflow-hidden">
          <pre
            ref={highlightPreRef}
            aria-hidden="true"
            data-testid="test-editor-syntax-layer"
            className="prism-syntax pointer-events-none select-none absolute inset-0 m-0 overflow-hidden px-3.5 py-3 font-mono text-[12.5px] leading-6 whitespace-pre"
          >
            <code
              className={`language-${effectiveLang} relative z-[1]`}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          </pre>

          <textarea
            id="test-editor"
            value={value}
            placeholder="Paste unit tests here, or leave blank to auto-synthesize from source & traceback..."
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => {
              const { scrollTop, scrollLeft } = e.currentTarget;
              if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
              if (highlightPreRef.current) {
                highlightPreRef.current.scrollTop = scrollTop;
                highlightPreRef.current.scrollLeft = scrollLeft;
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label="Unit test suite code editor"
            className="code-editor code-scroll relative z-10 h-full w-full resize-none bg-transparent px-3.5 py-3 font-mono text-[12.5px] leading-6 text-transparent caret-[#F4F7FF] selection:bg-[#8B7CFF]/30 placeholder:text-[#A6B0C8]/55 focus:outline-none focus:ring-inset focus:ring-2 focus:ring-[#8B7CFF]/35 overflow-auto whitespace-pre"
          />
        </div>
      </div>
    </div>
  );
}

export function WorkbenchView({
  filename,
  testFilename,
  sourceCode,
  testCode,
  bugContext,
  caseDescription,
  selectedLanguage,
  resolvedLanguage,
  onChangeLanguage,
  onChangeFilename,
  onChangeTestFilename,
  onChangeSourceCode,
  onChangeTestCode,
  onChangeBugContext,
  onUploadSource,
  onResetDemo,
  canResetDemo,
  analysis,
  unifiedFindings,
  activeFindingId,
  onSelectFinding,
  resolvedFindingIds,
  onApplyFix,
  onApplyAllSafeFixes,
  onUndoFix,
  canUndoFix,
  hasLocalEdits,
  onVerifyCurrentCode,
  isValidating,
  isRunning,
  errorMessage,
  dashboardTab,
  onChangeDashboardTab,
  onOpenProjects,
  explanationMode,
  onChangeExplanationMode,
  stageMode,
  onChangeStageMode,
  voiceNotes,
  onAddVoiceNote,
  onUpdateVoiceNote,
  onDeleteVoiceNote,
  activeDecision,
  auditCount,
  onRunAnalysis,
  onOpenAudit,
  onAcceptPatch,
  onRejectPatch,
  onDownloadPatched,
  onValidateManualPatch,
}: WorkbenchViewProps) {
  const [showTestContextPanel, setShowTestContextPanel] = useState(false);

  const langMeta = getLanguageMeta(resolvedLanguage);
  const resolvedCount = unifiedFindings.filter((f) => resolvedFindingIds.has(f.id)).length;
  const remainingAutoFixCount = unifiedFindings.filter(
    (f) => f.canAutoFix && f.suggestedReplacement !== null && !resolvedFindingIds.has(f.id)
  ).length;

  return (
    <div className="max-w-[1320px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-4 border-b border-white/10">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#A6B0C8]">
            <span>Dashboard</span>
            <span aria-hidden="true">/</span>
            <span className="font-mono text-[#F4F7FF]">{filename}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[#50D7E6]">{langMeta.runtimeLabel}</span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F4F7FF] text-balance">
            Autonomous Bug Inspector &amp; Patch Sandbox
          </h1>
          <p className="text-sm text-[#A6B0C8] max-w-2xl">{caseDescription}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <label
              htmlFor="language-select"
              className="text-xs font-medium text-[#A6B0C8] whitespace-nowrap"
            >
              Language
            </label>
            <select
              id="language-select"
              value={selectedLanguage}
              onChange={(e) =>
                onChangeLanguage(e.target.value as 'auto' | SupportedLanguage)
              }
              aria-label="Target programming language"
              className="h-9 px-2.5 text-xs font-medium text-[#F4F7FF] bg-[#111930]/85 border border-white/15 rounded-lg focus:outline-none focus:border-[#8B7CFF] cursor-pointer"
            >
              <option value="auto">Auto-Detect ({langMeta.label})</option>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={onOpenProjects}
            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-[#F4F7FF] bg-[#111930]/75 border border-white/12 hover:bg-white/10 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
            <span>Projects</span>
          </button>

          {canResetDemo && (
            <button
              type="button"
              onClick={onResetDemo}
              className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-[#F4F7FF] bg-[#111930]/75 border border-white/12 hover:bg-white/10 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[#A6B0C8]" aria-hidden="true" />
              <span>Reset Case</span>
            </button>
          )}
        </div>
      </div>

      {/* Bug Lifecycle Workflow Stepper */}
      <WorkflowStepper
        analysis={analysis}
        isRunning={isRunning}
        isValidating={isValidating}
        findingsCount={unifiedFindings.length}
        resolvedCount={resolvedCount}
        hasLocalEdits={hasLocalEdits}
        activeDecision={activeDecision}
        auditCount={auditCount}
        onTriggerAnalysis={onRunAnalysis}
        onFocusInspection={() => {
          onChangeDashboardTab('inspector');
          onChangeStageMode('inspect');
        }}
        onOpenVerification={() => onChangeDashboardTab('diff')}
        onOpenAudit={onOpenAudit}
      />

      {/* 3-Card Scan & Verification Summary */}
      <SummaryCards
        analysis={analysis}
        findings={unifiedFindings}
        resolvedCount={resolvedCount}
        hasLocalEdits={hasLocalEdits}
        isRunning={isRunning}
        isValidating={isValidating}
        onOpenDiffProof={() => onChangeDashboardTab('diff')}
      />

      {/* Inline Error Banner */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-3 px-4 py-3 bg-[#FF718B]/12 border border-[#FF718B]/35 rounded-xl text-sm text-[#FFB3C1]"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 text-[#FF718B] shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium text-[#F4F7FF]">Analysis could not complete</p>
            <p className="text-xs text-[#FFB3C1] mt-0.5">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* Dashboard Sub-Navigation & Repair Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Dashboard workspace tabs"
          className="inline-flex items-center gap-1 p-1 bg-[#111930]/80 backdrop-blur-md border border-white/10 rounded-lg"
        >
          <button
            type="button"
            role="tab"
            aria-selected={dashboardTab === 'inspector'}
            onClick={() => onChangeDashboardTab('inspector')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              dashboardTab === 'inspector'
                ? 'bg-[#8B7CFF] text-white shadow-sm'
                : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
            }`}
          >
            <Bug className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Bug Inspector</span>
            {unifiedFindings.length > 0 && (
              <span className="font-mono text-[11px] tabular-nums opacity-85">
                ({unifiedFindings.length})
              </span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={dashboardTab === 'diff'}
            onClick={() => onChangeDashboardTab('diff')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              dashboardTab === 'diff'
                ? 'bg-[#8B7CFF] text-white shadow-sm'
                : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
            }`}
          >
            <GitCompare className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Diff &amp; Sandbox Proof</span>
          </button>
        </div>

        {/* Contextual Controls for Inspector Tab */}
        {dashboardTab === 'inspector' && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Explanation Mode Toggle: Plain English vs Technical */}
            <div
              role="group"
              aria-label="Explanation detail mode"
              className="inline-flex items-center gap-1 p-1 bg-[#111930]/80 border border-white/10 rounded-lg"
            >
              <button
                type="button"
                onClick={() => onChangeExplanationMode('plain')}
                aria-pressed={explanationMode === 'plain'}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  explanationMode === 'plain'
                    ? 'bg-[#50D7E6]/20 text-[#50D7E6] border border-[#50D7E6]/35'
                    : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
                }`}
              >
                <BookOpen className="w-3 h-3" aria-hidden="true" />
                <span>Plain English</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeExplanationMode('technical')}
                aria-pressed={explanationMode === 'technical'}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  explanationMode === 'technical'
                    ? 'bg-[#8B7CFF]/25 text-[#C4BCFF] border border-[#8B7CFF]/40'
                    : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
                }`}
              >
                <Cpu className="w-3 h-3" aria-hidden="true" />
                <span>Technical</span>
              </button>
            </div>

            {remainingAutoFixCount > 0 && (
              <button
                type="button"
                onClick={onApplyAllSafeFixes}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-semibold text-[#0B1020] bg-[#51D6A2] hover:bg-[#42c390] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  Apply All Safe Fixes ({remainingAutoFixCount})
                </span>
              </button>
            )}

            {canUndoFix && (
              <button
                type="button"
                onClick={onUndoFix}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-[#F4F7FF] bg-white/8 hover:bg-white/14 border border-white/12 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5 text-[#FFCA70]" aria-hidden="true" />
                <span>Undo</span>
              </button>
            )}

            {hasLocalEdits && (
              <button
                type="button"
                onClick={() => {
                  void onVerifyCurrentCode();
                }}
                disabled={isValidating}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium text-white bg-[#8B7CFF] hover:bg-[#7A69FF] disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isValidating ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>{isValidating ? 'Verifying...' : 'Re-Verify Current Code'}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Loading Skeleton during Scan */}
      {isRunning && (
        <section
          aria-live="polite"
          className="bg-[#111930]/75 backdrop-blur-md border border-white/10 rounded-xl p-5 space-y-3 shadow-lg shadow-black/20"
        >
          <div className="h-4 w-64 bg-white/10 rounded animate-pulse" />
          <div className="h-3 w-full max-w-xl bg-white/8 rounded animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="h-24 bg-[#0B1020]/70 border border-white/10 rounded-lg animate-pulse" />
            <div className="h-24 bg-[#0B1020]/70 border border-white/10 rounded-lg animate-pulse" />
          </div>
        </section>
      )}

      {/* Main Dashboard Tab Body */}
      <AnimatePresence mode="wait" initial={false}>
        {dashboardTab === 'inspector' ? (
          <motion.div
            key="inspector-tab"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={VIEW_TRANSITION}
            className="space-y-5"
          >
            {/* Interactive Line-Highlighted Code Inspector & Editor Stage */}
            <BugCodeStage
              filename={filename}
              onChangeFilename={onChangeFilename}
              sourceCode={sourceCode}
              onChangeSourceCode={onChangeSourceCode}
              onDropSourceFile={onUploadSource}
              findings={unifiedFindings}
              activeFindingId={activeFindingId}
              onSelectFinding={onSelectFinding}
              resolvedFindingIds={resolvedFindingIds}
              onApplyFix={onApplyFix}
              explanationMode={explanationMode}
              stageMode={stageMode}
              onChangeStageMode={onChangeStageMode}
              hasScanned={analysis !== null}
              voiceNotes={voiceNotes}
              onAddVoiceNote={onAddVoiceNote}
              onUpdateVoiceNote={onUpdateVoiceNote}
              onDeleteVoiceNote={onDeleteVoiceNote}
            />

            {/* Collapsible Unit Test Suite & Error Traceback Context Drawer */}
            <section
              aria-label="Unit test suite and error traceback inputs"
              className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-lg shadow-black/20"
            >
              <button
                type="button"
                onClick={() => setShowTestContextPanel((prev) => !prev)}
                aria-expanded={showTestContextPanel}
                className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Terminal className="w-4 h-4 text-[#50D7E6] shrink-0" aria-hidden="true" />
                  <span className="font-display text-xs font-semibold text-[#F4F7FF]">
                    Unit Test Suite &amp; Error Traceback Context
                  </span>
                  <span className="font-mono text-[11px] text-[#A6B0C8] truncate">
                    {testCode.trim()
                      ? `${testFilename} (${testCode.split('\n').length} lines)`
                      : 'Auto-synthesizes tests if left empty'}
                    {bugContext.trim() ? ' · Error log attached' : ''}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[#50D7E6] shrink-0">
                  <span>{showTestContextPanel ? 'Hide' : 'Edit Tests & Traceback'}</span>
                  {showTestContextPanel ? (
                    <ChevronUp className="w-4 h-4" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="w-4 h-4" aria-hidden="true" />
                  )}
                </span>
              </button>

              <AnimatePresence initial={false}>
                {showTestContextPanel && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={PANEL_TRANSITION}
                    className="overflow-hidden border-t border-white/10"
                  >
                    <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
                      <PrismTestEditor
                        filename={testFilename}
                        onChangeFilename={onChangeTestFilename}
                        value={testCode}
                        onChange={onChangeTestCode}
                        language={resolvedLanguage}
                      />

                      <div className="flex flex-col bg-[#0B1020]/75 border border-white/10 rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between gap-2 px-3.5 py-2 bg-[#0D1426]/85 border-b border-white/10">
                          <label
                            htmlFor="bug-context-input"
                            className="text-xs font-medium text-[#A6B0C8]"
                          >
                            Failing Traceback / Bug Description (Optional)
                          </label>
                          <span className="font-mono text-[11px] text-[#A6B0C8]/75">
                            Parsed for Line &amp; Exception Triage
                          </span>
                        </div>
                        <textarea
                          id="bug-context-input"
                          value={bugContext}
                          onChange={(e) => onChangeBugContext(e.target.value)}
                          spellCheck={false}
                          rows={8}
                          placeholder="Paste failing test traceback, compiler error log, or bug description here (e.g. TypeError: 'NoneType' object is not subscriptable at line 6)..."
                          className="code-editor code-scroll flex-1 w-full resize-none bg-[#070B16]/85 px-3.5 py-3 font-mono text-xs leading-6 text-[#F4F7FF] placeholder:text-[#A6B0C8]/55 focus:outline-none focus:ring-inset focus:ring-2 focus:ring-[#8B7CFF]/35"
                        />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </motion.div>
        ) : (
          <motion.div
            key="diff-tab"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={VIEW_TRANSITION}
          >
            <DiffReviewView
              embedded
              analysis={analysis}
              testCode={testCode}
              activeDecision={activeDecision}
              onAcceptPatch={onAcceptPatch}
              onRejectPatch={onRejectPatch}
              onDownloadPatched={onDownloadPatched}
              onValidateManualPatch={onValidateManualPatch}
              isValidatingManual={isValidating}
              onBackToWorkbench={() => onChangeDashboardTab('inspector')}
              voiceNotes={voiceNotes}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
