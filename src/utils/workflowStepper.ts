import type { AnalysisResponse, AuditDecision } from '../types/autopatch';

export type LifecycleStageId = 'analysis' | 'inspection' | 'verification' | 'audit';
export type LifecycleStepState = 'completed' | 'active' | 'attention' | 'upcoming';

export interface LifecycleStep {
  id: LifecycleStageId;
  stepNumber: string;
  label: string;
  description: string;
  statusDetail: string;
  state: LifecycleStepState;
  enabled: boolean;
}

export interface DeriveLifecycleParams {
  analysis: AnalysisResponse | null;
  isRunning: boolean;
  isValidating: boolean;
  findingsCount: number;
  resolvedCount: number;
  hasLocalEdits: boolean;
  activeDecision: AuditDecision | null;
  auditCount: number;
}

/**
 * Computes the 4-stage AutoPatch bug lifecycle progression:
 * Analysis -> Inspection -> Verification -> Audit.
 */
export function deriveWorkflowLifecycleSteps(
  params: DeriveLifecycleParams
): LifecycleStep[] {
  const {
    analysis,
    isRunning,
    isValidating,
    findingsCount,
    resolvedCount,
    hasLocalEdits,
    activeDecision,
    auditCount,
  } = params;

  // 1. Analysis
  const analysisState: LifecycleStepState = isRunning
    ? 'active'
    : analysis
    ? 'completed'
    : 'active';

  const analysisDetail = isRunning
    ? 'Scanning AST & AI rules...'
    : analysis
    ? findingsCount === 0
      ? 'Clean scan (0 issues)'
      : `${findingsCount} bug${findingsCount === 1 ? '' : 's'} identified`
    : 'Click Scan & Find Bugs';

  // 2. Inspection
  let inspectionState: LifecycleStepState = 'upcoming';
  let inspectionDetail = 'Review colored line popups';

  if (analysis) {
    if (findingsCount === 0 || resolvedCount > 0 || hasLocalEdits || activeDecision !== null) {
      inspectionState = 'completed';
      inspectionDetail =
        findingsCount === 0
          ? 'No repairs required'
          : resolvedCount > 0
          ? `${resolvedCount}/${findingsCount} fixed in editor`
          : 'Edited in workbench';
    } else {
      inspectionState = 'active';
      inspectionDetail = 'Click a colored line or press n / p';
    }
  }

  // 3. Verification
  let verificationState: LifecycleStepState = 'upcoming';
  let verificationDetail = 'Sandbox test proof';

  if (analysis) {
    if (isValidating) {
      verificationState = 'active';
      verificationDetail = 'Running sandbox tests...';
    } else if (activeDecision !== null) {
      verificationState = 'completed';
      verificationDetail = `${analysis.sandbox.passed}/${analysis.sandbox.total} tests verified`;
    } else if (hasLocalEdits || resolvedCount > 0) {
      verificationState = 'active';
      verificationDetail = 'Re-verify edits or open Diff';
    } else if (analysis.trustVerdict === 'blocked') {
      verificationState = 'attention';
      verificationDetail = 'Blocked — review required';
    } else {
      verificationState = 'upcoming';
      verificationDetail = `Candidate: ${analysis.sandbox.passed}/${analysis.sandbox.total} pass`;
    }
  }

  // 4. Audit
  let auditState: LifecycleStepState = 'upcoming';
  let auditDetail =
    auditCount > 0
      ? `${auditCount} decision${auditCount === 1 ? '' : 's'} in ledger`
      : 'Accept, reject, or override';

  if (activeDecision !== null) {
    auditState = 'completed';
    auditDetail =
      activeDecision === 'accepted'
        ? 'Accepted & logged'
        : activeDecision === 'override'
        ? 'Override logged'
        : activeDecision === 'rejected'
        ? 'Rejected & logged'
        : 'Blocked entry logged';
  } else if (analysis && analysis.trustVerdict === 'blocked') {
    auditDetail = 'Blocked entry logged · review';
  }

  return [
    {
      id: 'analysis',
      stepNumber: '01',
      label: 'Analysis',
      description: 'Detect bugs & trace root cause',
      statusDetail: analysisDetail,
      state: analysisState,
      enabled: !isRunning,
    },
    {
      id: 'inspection',
      stepNumber: '02',
      label: 'Inspection',
      description: 'Inspect lines & apply fixes',
      statusDetail: inspectionDetail,
      state: inspectionState,
      enabled: analysis !== null,
    },
    {
      id: 'verification',
      stepNumber: '03',
      label: 'Verification',
      description: 'Prove fix passes sandbox tests',
      statusDetail: verificationDetail,
      state: verificationState,
      enabled: analysis !== null,
    },
    {
      id: 'audit',
      stepNumber: '04',
      label: 'Audit',
      description: 'Record trust decision & export',
      statusDetail: auditDetail,
      state: auditState,
      enabled: true,
    },
  ];
}
