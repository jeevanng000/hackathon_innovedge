import {
  Radar,
  Bug,
  ShieldCheck,
  ClipboardCheck,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import type { AnalysisResponse, AuditDecision } from '../types/autopatch';
import {
  deriveWorkflowLifecycleSteps,
  type LifecycleStageId,
  type LifecycleStep,
} from '../utils/workflowStepper';

interface WorkflowStepperProps {
  analysis: AnalysisResponse | null;
  isRunning: boolean;
  isValidating: boolean;
  findingsCount: number;
  resolvedCount: number;
  hasLocalEdits: boolean;
  activeDecision: AuditDecision | null;
  auditCount: number;
  onTriggerAnalysis: () => void;
  onFocusInspection: () => void;
  onOpenVerification: () => void;
  onOpenAudit: () => void;
}

const STAGE_ICONS: Record<LifecycleStageId, typeof Radar> = {
  analysis: Radar,
  inspection: Bug,
  verification: ShieldCheck,
  audit: ClipboardCheck,
};

function getStepClasses(step: LifecycleStep): {
  card: string;
  badge: string;
  title: string;
  detail: string;
} {
  switch (step.state) {
    case 'completed':
      return {
        card: 'bg-[#51D6A2]/8 border-[#51D6A2]/30 hover:bg-[#51D6A2]/14',
        badge: 'bg-[#51D6A2]/20 text-[#51D6A2] border border-[#51D6A2]/30',
        title: 'text-[#F4F7FF]',
        detail: 'text-[#51D6A2]',
      };
    case 'active':
      return {
        card: 'bg-[#8B7CFF]/14 border-[#8B7CFF]/45 hover:bg-[#8B7CFF]/20 shadow-sm shadow-[#8B7CFF]/15',
        badge: 'bg-[#8B7CFF] text-white',
        title: 'text-[#F4F7FF]',
        detail: 'text-[#50D7E6]',
      };
    case 'attention':
      return {
        card: 'bg-[#FFCA70]/10 border-[#FFCA70]/40 hover:bg-[#FFCA70]/16',
        badge: 'bg-[#FFCA70]/20 text-[#FFCA70] border border-[#FFCA70]/35',
        title: 'text-[#F4F7FF]',
        detail: 'text-[#FFCA70]',
      };
    default:
      return {
        card: 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06]',
        badge: 'bg-white/10 text-[#A6B0C8]',
        title: 'text-[#F4F7FF]/85',
        detail: 'text-[#A6B0C8]',
      };
  }
}

export function WorkflowStepper({
  analysis,
  isRunning,
  isValidating,
  findingsCount,
  resolvedCount,
  hasLocalEdits,
  activeDecision,
  auditCount,
  onTriggerAnalysis,
  onFocusInspection,
  onOpenVerification,
  onOpenAudit,
}: WorkflowStepperProps) {
  const steps = deriveWorkflowLifecycleSteps({
    analysis,
    isRunning,
    isValidating,
    findingsCount,
    resolvedCount,
    hasLocalEdits,
    activeDecision,
    auditCount,
  });

  const handleStageClick = (id: LifecycleStageId) => {
    if (id === 'analysis') {
      if (!analysis) {
        onTriggerAnalysis();
      } else {
        onFocusInspection();
      }
      return;
    }
    if (id === 'inspection') {
      onFocusInspection();
      return;
    }
    if (id === 'verification') {
      onOpenVerification();
      return;
    }
    onOpenAudit();
  };

  const completedCount = steps.filter((s) => s.state === 'completed').length;

  return (
    <section
      aria-label="Bug lifecycle progress"
      className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl p-4 space-y-3 shadow-lg shadow-black/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <h2 className="font-display font-semibold text-[#F4F7FF]">
            Bug Lifecycle Workflow
          </h2>
          <span aria-hidden="true" className="text-white/25">
            ·
          </span>
          <span className="text-[#A6B0C8]">
            Analysis &rarr; Inspection &rarr; Verification &rarr; Audit
          </span>
        </div>
        <span className="font-mono text-xs tabular-nums text-[#A6B0C8]">
          {completedCount}/4 stages complete
        </span>
      </div>

      <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {steps.map((step, idx) => {
          const cls = getStepClasses(step);
          const StageIcon = STAGE_ICONS[step.id];

          return (
            <li key={step.id} className="relative flex items-stretch">
              <button
                type="button"
                disabled={!step.enabled}
                onClick={() => handleStageClick(step.id)}
                aria-current={step.state === 'active' ? 'step' : undefined}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all flex flex-col justify-between gap-1.5 ${
                  cls.card
                } ${
                  step.enabled
                    ? 'cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8B7CFF]'
                    : 'opacity-50 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`inline-flex items-center justify-center w-6 h-6 rounded-md font-mono text-[11px] font-semibold tabular-nums shrink-0 ${cls.badge}`}
                    >
                      {step.state === 'completed' ? (
                        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : step.state === 'attention' ? (
                        <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        step.stepNumber
                      )}
                    </span>
                    <span
                      className={`font-display text-xs font-semibold truncate ${cls.title}`}
                    >
                      {step.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <StageIcon
                      className="w-3.5 h-3.5 text-[#A6B0C8]"
                      aria-hidden="true"
                    />
                    {idx < steps.length - 1 && (
                      <ChevronRight
                        className="hidden lg:block w-3.5 h-3.5 text-white/25"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </div>

                <div className="space-y-0.5 pl-8">
                  <p className="text-[11px] text-[#A6B0C8] truncate">
                    {step.description}
                  </p>
                  <p className={`text-[11px] font-medium truncate ${cls.detail}`}>
                    {step.statusDetail}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
