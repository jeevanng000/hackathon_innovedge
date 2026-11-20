import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ShieldAlert,
  AlertTriangle,
  Bug,
  Radar,
  CheckCircle2,
  X,
  ChevronLeft,
  ChevronRight,
  Wand2,
  Pencil,
  Eye,
  Upload,
  Mic,
} from 'lucide-react';
import type {
  BugCategory,
  ExplanationMode,
  UnifiedBugFinding,
  VoiceNote,
} from '../types/autopatch';
import {
  getAdjacentFindingId,
  isEditableTargetElement,
} from '../utils/unifiedFindings';
import {
  computeScrollViewportMetrics,
  type BugHeatmapBand,
  type ScrollViewportMetrics,
} from '../utils/bugHeatmap';
import { POPOVER_SPRING, VIEW_TRANSITION } from '../utils/motionPresets';
import { BugHeatmap } from './BugHeatmap';
import { VoiceNoteRecorder } from './VoiceNoteRecorder';

export type CodeStageMode = 'inspect' | 'edit';

interface BugCodeStageProps {
  filename: string;
  onChangeFilename: (name: string) => void;
  sourceCode: string;
  onChangeSourceCode: (code: string) => void;
  onDropSourceFile: (filename: string, content: string) => void;
  findings: UnifiedBugFinding[];
  activeFindingId: string | null;
  onSelectFinding: (id: string | null) => void;
  resolvedFindingIds: Set<string>;
  onApplyFix: (finding: UnifiedBugFinding) => void;
  explanationMode: ExplanationMode;
  stageMode: CodeStageMode;
  onChangeStageMode: (mode: CodeStageMode) => void;
  hasScanned: boolean;
  voiceNotes: VoiceNote[];
  onAddVoiceNote: (note: VoiceNote) => void;
  onUpdateVoiceNote: (noteId: string, patch: Partial<VoiceNote>) => void;
  onDeleteVoiceNote: (noteId: string) => void;
}

interface CategoryStyle {
  label: string;
  rowBg: string;
  rowHover: string;
  gutterBg: string;
  gutterText: string;
  markerBtn: string;
  popoverHeaderBg: string;
  accentText: string;
  Icon: typeof ShieldAlert;
}

const CATEGORY_STYLES: Record<BugCategory, CategoryStyle> = {
  security: {
    label: 'Security',
    rowBg: 'bg-[#FF718B]/12',
    rowHover: 'hover:bg-[#FF718B]/18',
    gutterBg: 'bg-[#FF718B]/18',
    gutterText: 'text-[#FF718B] font-semibold',
    markerBtn:
      'bg-[#FF718B]/18 text-[#FF718B] border-[#FF718B]/40 hover:bg-[#FF718B]/28',
    popoverHeaderBg: 'bg-[#FF718B]/12',
    accentText: 'text-[#FF718B]',
    Icon: ShieldAlert,
  },
  runtime: {
    label: 'Crash Risk',
    rowBg: 'bg-[#FFCA70]/12',
    rowHover: 'hover:bg-[#FFCA70]/18',
    gutterBg: 'bg-[#FFCA70]/18',
    gutterText: 'text-[#FFCA70] font-semibold',
    markerBtn:
      'bg-[#FFCA70]/18 text-[#FFCA70] border-[#FFCA70]/40 hover:bg-[#FFCA70]/28',
    popoverHeaderBg: 'bg-[#FFCA70]/12',
    accentText: 'text-[#FFCA70]',
    Icon: AlertTriangle,
  },
  logic: {
    label: 'Logic',
    rowBg: 'bg-[#50D7E6]/10',
    rowHover: 'hover:bg-[#50D7E6]/16',
    gutterBg: 'bg-[#50D7E6]/16',
    gutterText: 'text-[#50D7E6] font-semibold',
    markerBtn:
      'bg-[#50D7E6]/16 text-[#50D7E6] border-[#50D7E6]/35 hover:bg-[#50D7E6]/25',
    popoverHeaderBg: 'bg-[#50D7E6]/10',
    accentText: 'text-[#50D7E6]',
    Icon: Bug,
  },
  modern: {
    label: 'Latest AI',
    rowBg: 'bg-[#8B7CFF]/12',
    rowHover: 'hover:bg-[#8B7CFF]/18',
    gutterBg: 'bg-[#8B7CFF]/18',
    gutterText: 'text-[#8B7CFF] font-semibold',
    markerBtn:
      'bg-[#8B7CFF]/18 text-[#C4BCFF] border-[#8B7CFF]/40 hover:bg-[#8B7CFF]/28',
    popoverHeaderBg: 'bg-[#8B7CFF]/14',
    accentText: 'text-[#B4A9FF]',
    Icon: Radar,
  },
};

function sourceLabel(source: UnifiedBugFinding['source']): string {
  if (source === 'ai-latest') return 'Latest AI Scan';
  if (source === 'sandbox-runtime') return 'Sandbox Test Trace';
  return 'Static AST / CFG';
}

export function BugCodeStage({
  filename,
  onChangeFilename,
  sourceCode,
  onChangeSourceCode,
  onDropSourceFile,
  findings,
  activeFindingId,
  onSelectFinding,
  resolvedFindingIds,
  onApplyFix,
  explanationMode,
  stageMode,
  onChangeStageMode,
  hasScanned,
  voiceNotes,
  onAddVoiceNote,
  onUpdateVoiceNote,
  onDeleteVoiceNote,
}: BugCodeStageProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inspectScrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [viewport, setViewport] = useState<ScrollViewportMetrics>({
    topPct: 0,
    heightPct: 100,
  });

  const lines = sourceCode.split('\n');
  const lineCount = lines.length;

  // Map each line to findings covering it
  const findingsByLine = new Map<number, UnifiedBugFinding[]>();
  for (const f of findings) {
    for (let ln = f.line; ln <= Math.min(lineCount, f.endLine); ln++) {
      const arr = findingsByLine.get(ln) ?? [];
      arr.push(f);
      findingsByLine.set(ln, arr);
    }
  }

  const activeFinding =
    findings.find((f) => f.id === activeFindingId) ?? null;
  const activeIndex = activeFinding
    ? findings.findIndex((f) => f.id === activeFinding.id)
    : -1;

  // Scroll smoothly to active finding line in Inspect mode
  useEffect(() => {
    if (stageMode === 'inspect' && activeFinding) {
      const el = lineRefs.current[activeFinding.line];
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [activeFinding?.id, stageMode]);

  const syncViewportMetrics = () => {
    const el = stageMode === 'inspect' ? inspectScrollRef.current : textareaRef.current;
    if (!el) return;
    setViewport(
      computeScrollViewportMetrics(el.scrollTop, el.clientHeight, el.scrollHeight)
    );
  };

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      syncViewportMetrics();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [stageMode, sourceCode, findings.length, activeFindingId]);

  const handleScrubScroll = (fraction: number) => {
    const el = stageMode === 'inspect' ? inspectScrollRef.current : textareaRef.current;
    if (!el) return;
    const targetTop = Math.max(0, fraction * el.scrollHeight - el.clientHeight * 0.5);
    el.scrollTop = targetTop;
    if (stageMode === 'edit' && gutterRef.current) {
      gutterRef.current.scrollTop = targetTop;
    }
    setViewport(
      computeScrollViewportMetrics(el.scrollTop, el.clientHeight, el.scrollHeight)
    );
  };

  const handleSelectHeatmapBand = (band: BugHeatmapBand) => {
    if (stageMode === 'inspect') {
      onSelectFinding(band.primaryFindingId);
      return;
    }
    const ta = textareaRef.current;
    if (ta) {
      const fraction = (band.startLine - 1) / Math.max(1, lineCount);
      const targetTop = Math.max(0, fraction * ta.scrollHeight - ta.clientHeight * 0.35);
      ta.scrollTop = targetTop;
      if (gutterRef.current) {
        gutterRef.current.scrollTop = targetTop;
      }
      const before = lines.slice(0, Math.max(0, band.startLine - 1)).join('\n');
      const startPos = band.startLine > 1 ? before.length + 1 : 0;
      const endPos = startPos + (lines[band.startLine - 1]?.length ?? 0);
      ta.focus();
      ta.setSelectionRange(startPos, endPos);
      syncViewportMetrics();
    }
  };

  const handleJumpToEditLine = (lineNum: number) => {
    onChangeStageMode('edit');
    window.requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const before = lines.slice(0, Math.max(0, lineNum - 1)).join('\n');
      const startPos = lineNum > 1 ? before.length + 1 : 0;
      const endPos = startPos + (lines[lineNum - 1]?.length ?? 0);
      ta.focus();
      ta.setSelectionRange(startPos, endPos);
    });
  };

  // Power-user keyboard navigation between findings in Inspect mode
  useEffect(() => {
    if (stageMode !== 'inspect' || findings.length === 0) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (isEditableTargetElement(target)) {
        if (e.key === 'Escape' && activeFindingId) {
          target?.blur();
          onSelectFinding(null);
        }
        return;
      }

      const key = e.key;
      const lower = key.toLowerCase();

      if (key === 'Escape' && activeFindingId) {
        e.preventDefault();
        onSelectFinding(null);
        return;
      }

      if (
        lower === 'n' ||
        lower === 'j' ||
        key === 'ArrowDown' ||
        key === 'ArrowRight'
      ) {
        e.preventDefault();
        const nextId = getAdjacentFindingId(findings, activeFindingId, 'next');
        if (nextId) onSelectFinding(nextId);
        return;
      }

      if (
        lower === 'p' ||
        lower === 'k' ||
        key === 'ArrowUp' ||
        key === 'ArrowLeft'
      ) {
        e.preventDefault();
        const prevId = getAdjacentFindingId(findings, activeFindingId, 'prev');
        if (prevId) onSelectFinding(prevId);
        return;
      }

      if (
        lower === 'f' &&
        activeFinding &&
        activeFinding.canAutoFix &&
        activeFinding.suggestedReplacement !== null &&
        !resolvedFindingIds.has(activeFinding.id)
      ) {
        e.preventDefault();
        onApplyFix(activeFinding);
        return;
      }

      if (lower === 'e') {
        e.preventDefault();
        handleJumpToEditLine(activeFinding?.line ?? 1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    stageMode,
    findings,
    activeFindingId,
    activeFinding,
    resolvedFindingIds,
    onSelectFinding,
    onApplyFix,
  ]);

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onDropSourceFile(file.name, reader.result);
      }
    };
    reader.readAsText(file);
  };

  const unresolvedCount = findings.filter((f) => !resolvedFindingIds.has(f.id)).length;

  return (
    <section
      aria-label="Interactive source code and bug inspector"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
      className={`relative flex flex-col bg-[#111930]/75 backdrop-blur-md border rounded-xl overflow-hidden shadow-xl shadow-black/25 transition-colors ${
        isDraggingOver
          ? 'border-[#50D7E6] ring-2 ring-[#50D7E6]/30'
          : 'border-white/10'
      }`}
    >
      {/* Frosted-Glass Drag-and-drop overlay */}
      <AnimatePresence>
        {isDraggingOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={VIEW_TRANSITION}
            className="absolute inset-0 z-20 bg-[#0B1020]/85 backdrop-blur-md flex flex-col items-center justify-center gap-2 pointer-events-none"
          >
            <Upload className="w-7 h-7 text-[#50D7E6]" aria-hidden="true" />
            <p className="text-sm font-medium text-[#F4F7FF]">
              Drop your code file to inspect it
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stage Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-[#0D1426]/80 border-b border-white/10">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <label
            htmlFor="stage-filename"
            className="text-xs font-medium text-[#A6B0C8] shrink-0"
          >
            File
          </label>
          <span aria-hidden="true" className="text-white/25">
            /
          </span>
          <input
            id="stage-filename"
            type="text"
            value={filename}
            onChange={(e) => onChangeFilename(e.target.value)}
            aria-label="Source filename"
            className="font-mono text-xs font-medium text-[#F4F7FF] bg-transparent border-b border-transparent hover:border-white/25 focus:border-[#8B7CFF] focus:outline-none px-1 py-0.5 min-w-0 w-full max-w-[240px]"
          />
          <span className="hidden sm:inline font-mono text-xs text-[#A6B0C8] tabular-nums shrink-0">
            · {lineCount} lines
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {hasScanned && (
            <span className="hidden md:inline text-xs font-mono tabular-nums text-[#A6B0C8]">
              {unresolvedCount === 0 && findings.length > 0 ? (
                <span className="text-[#51D6A2] font-medium">
                  All {findings.length} highlighted fixes applied
                </span>
              ) : findings.length > 0 ? (
                <span>
                  {unresolvedCount} bug{unresolvedCount === 1 ? '' : 's'} highlighted
                </span>
              ) : (
                <span className="text-[#51D6A2] font-medium">
                  Zero bugs flagged
                </span>
              )}
            </span>
          )}

          {/* Mode Segmented Control: Inspect Bugs | Edit Code */}
          <div
            role="group"
            aria-label="Code view mode"
            className="inline-flex items-center gap-1 p-1 bg-[#0B1020]/80 border border-white/10 rounded-lg"
          >
            <button
              type="button"
              onClick={() => onChangeStageMode('inspect')}
              aria-pressed={stageMode === 'inspect'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                stageMode === 'inspect'
                  ? 'bg-[#8B7CFF] text-white shadow-sm'
                  : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
              }`}
            >
              <Eye className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Inspect Bugs</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeStageMode('edit')}
              aria-pressed={stageMode === 'edit'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                stageMode === 'edit'
                  ? 'bg-[#8B7CFF] text-white shadow-sm'
                  : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
              }`}
            >
              <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Edit Code</span>
            </button>
          </div>
        </div>
      </div>

      {/* Color Legend Strip (visible when findings exist) */}
      {hasScanned && findings.length > 0 && stageMode === 'inspect' && (
        <div className="px-4 py-2 bg-[#0B1020]/60 border-b border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[#A6B0C8]">
            <span className="font-medium text-[#F4F7FF]/90">
              Click any highlighted line to inspect:
            </span>
            {(Object.keys(CATEGORY_STYLES) as BugCategory[]).map((cat) => {
              const cfg = CATEGORY_STYLES[cat];
              const Icon = cfg.Icon;
              const count = findings.filter((f) => f.category === cat).length;
              if (count === 0) return null;
              return (
                <span
                  key={cat}
                  className={`inline-flex items-center gap-1 font-medium ${cfg.accentText}`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {cfg.label} ({count})
                  </span>
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums text-[#A6B0C8]">
            <span>
              Keys: <strong className="font-semibold text-[#F4F7FF]">n</strong> /{' '}
              <strong className="font-semibold text-[#F4F7FF]">&darr;</strong> next
              {' · '}
              <strong className="font-semibold text-[#F4F7FF]">p</strong> /{' '}
              <strong className="font-semibold text-[#F4F7FF]">&uarr;</strong> prev
              {' · '}
              <strong className="font-semibold text-[#F4F7FF]">f</strong> apply fix
              {' · '}
              <strong className="font-semibold text-[#F4F7FF]">esc</strong> close
            </span>
            {activeFinding && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#50D7E6] font-medium">
                  Viewing bug {activeIndex + 1} of {findings.length}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Mode 1: Interactive Color-Coded Bug Inspector with Frosted-Glass Line Popover + Bug Heatmap */}
      {stageMode === 'inspect' ? (
        <div className="relative flex max-h-[560px] bg-[#0B1020]/75 overflow-hidden">
          <div
            ref={inspectScrollRef}
            onScroll={syncViewportMetrics}
            className="code-scroll flex-1 min-w-0 overflow-auto divide-y divide-white/[0.04]"
          >
            {lines.map((lineText, idx) => {
              const lineNum = idx + 1;
              const lineFindings = findingsByLine.get(lineNum) ?? [];
              const primaryFinding = lineFindings[0] ?? null;
              const anchoredFinding =
                activeFinding && activeFinding.line === lineNum ? activeFinding : null;

              const isResolved =
                primaryFinding !== null &&
                lineFindings.every((f) => resolvedFindingIds.has(f.id));
              const style = primaryFinding ? CATEGORY_STYLES[primaryFinding.category] : null;
              const Icon = style?.Icon ?? Bug;

              const rowClasses = primaryFinding
                ? isResolved
                  ? 'bg-[#51D6A2]/10 hover:bg-[#51D6A2]/16 cursor-pointer'
                  : `${style!.rowBg} ${style!.rowHover} cursor-pointer`
                : 'hover:bg-white/[0.03]';

              const gutterClasses = primaryFinding
                ? isResolved
                  ? 'bg-[#51D6A2]/15 text-[#51D6A2] font-semibold'
                  : `${style!.gutterBg} ${style!.gutterText}`
                : 'bg-[#090E1C]/60 text-[#A6B0C8]/70';

              return (
                <div
                  key={lineNum}
                  ref={(el) => {
                    lineRefs.current[lineNum] = el;
                  }}
                >
                  <div
                    onClick={() => {
                      if (primaryFinding) {
                        onSelectFinding(
                          activeFindingId === primaryFinding.id ? null : primaryFinding.id
                        );
                      }
                    }}
                    className={`flex items-stretch font-mono text-[13px] leading-6 transition-colors ${rowClasses}`}
                  >
                    {/* Line Number + Marker Indicator Gutter */}
                    <div
                      className={`w-14 px-2.5 py-0.5 text-right select-none tabular-nums border-r border-white/10 shrink-0 flex items-center justify-end gap-1.5 ${gutterClasses}`}
                    >
                      {primaryFinding && (
                        isResolved ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        )
                      )}
                      <span>{lineNum}</span>
                    </div>

                    {/* Code Text + Inline Clickable Bug Marking */}
                    <div className="flex-1 min-w-0 px-3.5 py-0.5 flex items-center justify-between gap-3">
                      <pre className="whitespace-pre overflow-x-auto text-[#F4F7FF] flex-1 min-w-0">
                        {lineText || ' '}
                      </pre>

                      {primaryFinding && primaryFinding.line === lineNum && (
                        <div className="inline-flex items-center gap-1.5 shrink-0">
                          {(() => {
                            const lineNoteCount = voiceNotes.filter((n) =>
                              lineFindings.some((f) => f.id === n.findingId)
                            ).length;
                            if (lineNoteCount === 0) return null;
                            return (
                              <span
                                title={`${lineNoteCount} voice note${lineNoteCount === 1 ? '' : 's'} attached`}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-[#F4F7FF]"
                              >
                                <Mic className="w-3 h-3 text-[#FF718B]" aria-hidden="true" />
                                <span>{lineNoteCount}</span>
                              </span>
                            );
                          })()}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectFinding(
                                activeFindingId === primaryFinding.id ? null : primaryFinding.id
                              );
                            }}
                            aria-expanded={activeFindingId === primaryFinding.id}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[11px] font-sans font-medium border rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                              isResolved
                                ? 'bg-[#51D6A2]/18 text-[#51D6A2] border-[#51D6A2]/40'
                                : style!.markerBtn
                            }`}
                          >
                            {isResolved ? (
                              <>
                                <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                                <span>Fixed</span>
                              </>
                            ) : (
                              <>
                                <Icon className="w-3 h-3" aria-hidden="true" />
                                <span>
                                  {style!.label}
                                  {lineFindings.length > 1 ? ` +${lineFindings.length - 1}` : ''}
                                </span>
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Frosted-Glass Anchored Per-Line Bug Popover with Spring Transition */}
                  <AnimatePresence initial={false}>
                    {anchoredFinding && (
                      <motion.div
                        key={anchoredFinding.id}
                        initial={{ opacity: 0, y: -6, scale: 0.985 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.985 }}
                        transition={POPOVER_SPRING}
                        role="dialog"
                        aria-label={`Bug details for line ${anchoredFinding.line}`}
                        className="mx-3 sm:mx-14 my-2.5 bg-[#141E38]/88 backdrop-blur-xl border border-white/15 rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
                      >
                        {(() => {
                          const popStyle = CATEGORY_STYLES[anchoredFinding.category];
                          const PopIcon = popStyle.Icon;
                          const popResolved = resolvedFindingIds.has(anchoredFinding.id);
                          const lineFindingsOnAnchor = findingsByLine.get(lineNum) ?? [anchoredFinding];

                          return (
                            <>
                              {/* Popover Header */}
                              <div
                                className={`px-4 py-2.5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2 ${
                                  popResolved
                                    ? 'bg-[#51D6A2]/12'
                                    : popStyle.popoverHeaderBg
                                }`}
                              >
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  <span
                                    className={`inline-flex items-center gap-1.5 font-semibold ${
                                      popResolved ? 'text-[#51D6A2]' : popStyle.accentText
                                    }`}
                                  >
                                    {popResolved ? (
                                      <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                                    ) : (
                                      <PopIcon className="w-4 h-4" aria-hidden="true" />
                                    )}
                                    <span>
                                      {popResolved ? 'Fix Applied' : popStyle.label}
                                    </span>
                                  </span>
                                  <span aria-hidden="true" className="text-white/25">
                                    ·
                                  </span>
                                  <span className="font-mono text-[#F4F7FF] tabular-nums">
                                    {anchoredFinding.line === anchoredFinding.endLine
                                      ? `Line ${anchoredFinding.line}`
                                      : `Lines ${anchoredFinding.line}–${anchoredFinding.endLine}`}
                                  </span>
                                  <span aria-hidden="true" className="text-white/25">
                                    ·
                                  </span>
                                  <span className="text-[#F4F7FF]/90 capitalize">
                                    {anchoredFinding.severity}
                                  </span>
                                  <span aria-hidden="true" className="text-white/25">
                                    ·
                                  </span>
                                  <span className="text-[#A6B0C8]">
                                    {sourceLabel(anchoredFinding.source)}
                                  </span>
                                </div>

                                <div className="flex items-center gap-1.5">
                                  {lineFindingsOnAnchor.length > 1 && (
                                    <span className="text-[11px] text-[#A6B0C8] mr-1">
                                      ({lineFindingsOnAnchor.length} issues on line)
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => onSelectFinding(null)}
                                    aria-label="Close bug popup"
                                    aria-keyshortcuts="Escape"
                                    title="Close popup (Esc)"
                                    className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-[#A6B0C8] hover:text-[#F4F7FF] hover:bg-white/10 cursor-pointer"
                                  >
                                    <X className="w-4 h-4" aria-hidden="true" />
                                  </button>
                                </div>
                              </div>

                              {/* Multiple bugs switcher if more than 1 bug hits the same line */}
                              {lineFindingsOnAnchor.length > 1 && (
                                <div className="px-4 py-1.5 bg-[#0B1020]/60 border-b border-white/10 flex items-center gap-2 overflow-x-auto">
                                  {lineFindingsOnAnchor.map((lf) => (
                                    <button
                                      key={lf.id}
                                      type="button"
                                      onClick={() => onSelectFinding(lf.id)}
                                      className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap cursor-pointer transition-colors ${
                                        lf.id === anchoredFinding.id
                                          ? 'bg-[#8B7CFF] text-white font-medium'
                                          : 'text-[#A6B0C8] hover:bg-white/10 hover:text-[#F4F7FF]'
                                      }`}
                                    >
                                      {lf.title}
                                    </button>
                                  ))}
                                </div>
                              )}

                              {/* Popover Body */}
                              <div className="p-4 space-y-3">
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                                    <h3 className="font-display text-sm font-semibold text-[#F4F7FF]">
                                      {anchoredFinding.title}
                                    </h3>
                                    {explanationMode === 'technical' && anchoredFinding.cweOrRule && (
                                      <span className="font-mono text-xs text-[#50D7E6]">
                                        {anchoredFinding.cweOrRule}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm text-[#F4F7FF]/90 leading-relaxed">
                                    {explanationMode === 'plain'
                                      ? anchoredFinding.plainEnglishExplanation
                                      : anchoredFinding.technicalExplanation}
                                  </p>
                                  <p className="text-xs text-[#A6B0C8]">
                                    <strong className="font-medium text-[#F4F7FF]">
                                      Trigger &amp; Impact:{' '}
                                    </strong>
                                    {anchoredFinding.impactSummary}
                                  </p>
                                </div>

                                {/* Before -> After Suggested Fix Preview */}
                                {anchoredFinding.suggestedReplacement !== null && (
                                  <div className="border border-white/12 rounded-lg overflow-hidden font-mono text-xs">
                                    <div className="px-3 py-1.5 bg-[#0B1020]/70 border-b border-white/10 text-[11px] font-sans font-medium text-[#A6B0C8]">
                                      Proposed Code Fix Preview
                                    </div>
                                    <div className="divide-y divide-white/10">
                                      <pre className="px-3 py-2 bg-[#FF718B]/12 text-[#FFB3C1] overflow-x-auto whitespace-pre">
                                        {anchoredFinding.originalSnippet
                                          .split('\n')
                                          .map((l) => `- ${l}`)
                                          .join('\n')}
                                      </pre>
                                      <pre className="px-3 py-2 bg-[#51D6A2]/12 text-[#8EF0C9] overflow-x-auto whitespace-pre">
                                        {anchoredFinding.suggestedReplacement === ''
                                          ? '+ (remove unreachable statement)'
                                          : anchoredFinding.suggestedReplacement
                                              .split('\n')
                                              .map((l) => `+ ${l}`)
                                              .join('\n')}
                                      </pre>
                                    </div>
                                  </div>
                                )}

                                {/* Action Footer */}
                                <div className="pt-1 flex flex-wrap items-center justify-between gap-3">
                                  <div className="flex flex-wrap items-center gap-2">
                                    {anchoredFinding.canAutoFix &&
                                      anchoredFinding.suggestedReplacement !== null && (
                                        <button
                                          type="button"
                                          disabled={popResolved}
                                          onClick={() => onApplyFix(anchoredFinding)}
                                          aria-keyshortcuts="f"
                                          title="Apply fix to line (f)"
                                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0B1020] bg-[#51D6A2] hover:bg-[#42c390] disabled:bg-white/10 disabled:text-[#A6B0C8] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                                        >
                                          <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                                          <span>
                                            {popResolved ? 'Fix Applied' : 'Apply Fix to Line'}
                                          </span>
                                        </button>
                                      )}

                                    <button
                                      type="button"
                                      onClick={() => handleJumpToEditLine(anchoredFinding.line)}
                                      aria-keyshortcuts="e"
                                      title="Edit this line manually (e)"
                                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#F4F7FF] bg-white/8 border border-white/15 hover:bg-white/14 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                    >
                                      <Pencil className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
                                      <span>Edit Line Manually</span>
                                    </button>
                                  </div>

                                  {/* Prev / Next Bug Navigation */}
                                  {findings.length > 1 && (
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const prevId = getAdjacentFindingId(
                                            findings,
                                            activeFindingId,
                                            'prev'
                                          );
                                          if (prevId) onSelectFinding(prevId);
                                        }}
                                        aria-keyshortcuts="p k ArrowUp ArrowLeft"
                                        title="Previous bug (p or ↑)"
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#F4F7FF] bg-white/8 hover:bg-white/15 border border-white/10 rounded-md transition-colors cursor-pointer"
                                      >
                                        <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                                        <span>Prev</span>
                                      </button>
                                      <span className="font-mono text-xs tabular-nums text-[#A6B0C8] px-1">
                                        {activeIndex + 1}/{findings.length}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const nextId = getAdjacentFindingId(
                                            findings,
                                            activeFindingId,
                                            'next'
                                          );
                                          if (nextId) onSelectFinding(nextId);
                                        }}
                                        aria-keyshortcuts="n j ArrowDown ArrowRight"
                                        title="Next bug (n or ↓)"
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#F4F7FF] bg-white/8 hover:bg-white/15 border border-white/10 rounded-md transition-colors cursor-pointer"
                                      >
                                        <span>Next</span>
                                        <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* Attached Voice Notes Recorder & Playback */}
                                <VoiceNoteRecorder
                                  findingId={anchoredFinding.id}
                                  filename={filename}
                                  line={anchoredFinding.line}
                                  bugTitle={anchoredFinding.title}
                                  notes={voiceNotes.filter(
                                    (n) => n.findingId === anchoredFinding.id
                                  )}
                                  onAddNote={onAddVoiceNote}
                                  onUpdateNote={onUpdateVoiceNote}
                                  onDeleteNote={onDeleteVoiceNote}
                                />
                              </div>
                            </>
                          );
                        })()}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
          {findings.length > 0 && (
            <BugHeatmap
              lineCount={lineCount}
              findings={findings}
              resolvedFindingIds={resolvedFindingIds}
              activeFindingId={activeFindingId}
              viewport={viewport}
              onSelectBand={handleSelectHeatmapBand}
              onScrubScroll={handleScrubScroll}
            />
          )}
        </div>
      ) : (
        /* Mode 2: Clean Line-Numbered Editor for Pasting & Direct Edits + Bug Heatmap */
        <div className="relative flex min-h-[340px] max-h-[560px] bg-[#0B1020]/75 overflow-hidden">
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="select-none bg-[#090E1C]/60 border-r border-white/10 py-3 px-2.5 text-right font-mono text-xs leading-6 text-[#A6B0C8]/70 tabular-nums overflow-hidden shrink-0 w-12"
          >
            {Array.from({ length: Math.max(lineCount, 14) }, (_, idx) => {
              const num = idx + 1;
              const flagged = findingsByLine.get(num)?.[0];
              const style = flagged ? CATEGORY_STYLES[flagged.category] : null;
              return (
                <div key={num} className={style ? style.gutterText : undefined}>
                  {num}
                </div>
              );
            })}
          </div>
          <textarea
            ref={textareaRef}
            id="source-code-editor"
            value={sourceCode}
            onChange={(e) => onChangeSourceCode(e.target.value)}
            onScroll={(e) => {
              if (gutterRef.current) {
                gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }
              syncViewportMetrics();
            }}
            spellCheck={false}
            placeholder="Paste or type your program here, or drop a file from your computer..."
            aria-label="Source code editor"
            className="code-editor code-scroll flex-1 w-full resize-none bg-transparent px-3.5 py-3 font-mono text-[13px] leading-6 text-[#F4F7FF] placeholder:text-[#A6B0C8]/60 focus:outline-none focus:ring-inset focus:ring-2 focus:ring-[#8B7CFF]/40 overflow-auto whitespace-pre"
          />
          {findings.length > 0 && (
            <BugHeatmap
              lineCount={lineCount}
              findings={findings}
              resolvedFindingIds={resolvedFindingIds}
              activeFindingId={activeFindingId}
              viewport={viewport}
              onSelectBand={handleSelectHeatmapBand}
              onScrubScroll={handleScrubScroll}
            />
          )}
        </div>
      )}
    </section>
  );
}
