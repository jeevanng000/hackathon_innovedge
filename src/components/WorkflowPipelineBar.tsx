import { Check, Loader2, AlertCircle } from 'lucide-react';
import type { WorkflowStageId } from '../types/autopatch';

export const AUTOPATCH_STAGES: Array<{
  id: WorkflowStageId;
  label: string;
  shortLabel: string;
}> = [
  { id: 1, label: 'Upload / Input', shortLabel: 'Input' },
  { id: 2, label: 'Scan', shortLabel: 'Scan' },
  { id: 3, label: 'Explain Root Cause', shortLabel: 'Root Cause' },
  { id: 4, label: 'Generate Fix', shortLabel: 'Fix' },
  { id: 5, label: 'Test & Validate', shortLabel: 'Validate' },
];

interface WorkflowPipelineBarProps {
  currentStage: WorkflowStageId;
  isScanning: boolean;
  hasCompleted: boolean;
  hasError: boolean;
}

export function WorkflowPipelineBar({
  currentStage,
  isScanning,
  hasCompleted,
  hasError,
}: WorkflowPipelineBarProps) {
  return (
    <section
      aria-label="5-stage AutoPatch pipeline"
      className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-white/70 dark:bg-slate-900/60 backdrop-blur-md px-3 py-3 sm:px-5 shadow-sm"
    >
      <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
        {AUTOPATCH_STAGES.map((stage) => {
          const isComplete =
            (hasCompleted && !isScanning && !hasError) ||
            stage.id < currentStage;
          const isCurrent = isScanning && stage.id === currentStage;
          const isFailed = hasError && stage.id === currentStage;

          return (
            <li
              key={stage.id}
              className={`flex items-center gap-2 rounded-xl px-2.5 py-2 border transition-all duration-300 ${
                isFailed
                  ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
                  : isCurrent
                  ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-700 dark:text-indigo-200 shadow-sm shadow-indigo-500/10'
                  : isComplete
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200/70 dark:border-white/10 bg-slate-100/60 dark:bg-white/[0.03] text-slate-500 dark:text-slate-400'
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
                  isFailed
                    ? 'bg-red-500 text-white'
                    : isCurrent
                    ? 'gemini-accent-gradient text-white'
                    : isComplete
                    ? 'bg-emerald-500 text-white'
                    : 'bg-slate-300/70 dark:bg-white/10 text-slate-700 dark:text-slate-300'
                }`}
              >
                {isFailed ? (
                  <AlertCircle className="h-3 w-3" aria-hidden="true" />
                ) : isCurrent ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : isComplete ? (
                  <Check className="h-3 w-3" aria-hidden="true" />
                ) : (
                  stage.id
                )}
              </span>
              <span className="truncate text-xs font-medium">
                <span className="hidden md:inline">{stage.label}</span>
                <span className="md:hidden">{stage.shortLabel}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
