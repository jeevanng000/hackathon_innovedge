export type AstSeverity = 'error' | 'warning';

export interface AstFinding {
  id: string;
  kind: string;
  category?: 'syntax' | 'runtime' | 'dataflow' | 'cfg' | 'security' | 'quality';
  severity: AstSeverity;
  line: number;
  col?: number;
  function: string;
  message: string;
  snippet: string;
  denominator?: string;
  sequence?: string;
  variable?: string;
  sink?: string;
  taintSources?: string[];
}

export interface FunctionMetric {
  name: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  calls: string[];
}

export interface CallGraphEdge {
  caller: string;
  callee: string;
}

export type AnalysisKind = 'ast-parser' | 'compiler-diagnostics' | 'heuristic';

export type VerificationMode =
  | 'dynamic-sandbox'
  | 'compile-only'
  | 'static-only'
  | 'execution-unavailable'
  | 'blocked';

export type VerificationStatus =
  | 'RUNTIME_VERIFIED'
  | 'STATIC_ANALYSIS_PASSED'
  | 'VERIFICATION_UNAVAILABLE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'FAILED';

export type CoverageStatus = 'collected' | 'empty' | 'unavailable';

export type TestSynthesisStatus =
  | 'user-provided'
  | 'synthesized-behavioral'
  | 'unavailable-human-tests-required';

export interface SandboxIsolationInfo {
  level: 'linux-namespace-unprivileged' | 'process-rlimit-only' | 'unavailable';
  isolatedUser: boolean;
  networkIsolated: boolean;
  pidIsolated: boolean;
  limitsApplied: string[];
  limitations: string[];
}

export interface AstReport {
  syntaxValid: boolean;
  durationMs: number;
  findings: AstFinding[];
  functions?: FunctionMetric[];
  callGraph?: CallGraphEdge[];
  analysisKind?: AnalysisKind;
  parserTool?: string;
}

export interface TestCaseResult {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  errorType?: string;
  errorMessage?: string;
  errorLine?: number | null;
  traceback?: string;
  executedLines?: number[];
}

export interface TestRunResult {
  timedOut: boolean;
  importError: boolean;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  errorType: string | null;
  errorMessage: string | null;
  errorLine: number | null;
  traceback: string | null;
  tests: TestCaseResult[];
  executionKind?: 'dynamic-sandbox' | 'static-only' | 'execution-unavailable';
  outputTruncated?: boolean;
}

export interface SbflLineRanking {
  line: number;
  code: string;
  failedCovering: number;
  passedCovering: number;
  ochiai: number;
  tarantula: number;
  testHits: boolean[];
}

export interface SbflSpectrum {
  totalPassed: number;
  totalFailed: number;
  tests: Array<{ name: string; status: 'passed' | 'failed' }>;
  rankings: SbflLineRanking[];
  coverageStatus?: CoverageStatus;
  coverageNote?: string;
}

export interface AprMutantEvaluation {
  line: number;
  ochiai: number;
  operator: string;
  originalLine: string;
  mutatedLine: string;
  passed: number;
  total: number;
  fitness: number;
  selected: boolean;
}

export interface PatchInfo {
  patchedCode: string;
  patchApplied: boolean;
  aprStrategy?: string;
  ruleId: string;
  strategy: string;
  targetLine: number | null;
  bugType: string;
  rootCause: string;
  requiresHumanReview: boolean;
  evaluatedMutants?: AprMutantEvaluation[];
  durationMs: number;
}

export interface SideBySideDiffRow {
  type: 'equal' | 'replace' | 'delete' | 'insert';
  leftLine: number | null;
  leftText: string | null;
  rightLine: number | null;
  rightText: string | null;
}

export interface DiffData {
  unified: string;
  sideBySide: SideBySideDiffRow[];
  linesAdded: number;
  linesRemoved: number;
}

export interface ConfidenceFactor {
  label: string;
  points: number;
  maxPoints: number;
  detail: string;
}

export interface ConfidenceBreakdown {
  score: number;
  factors: ConfidenceFactor[];
}

export type TrustVerdict = 'verified' | 'blocked' | 'already_passing';

export interface Eli10Explanation {
  title: string;
  analogy: string;
  whatWentWrong: string;
  howWeFixedIt: string;
}

export type BugCategory = 'security' | 'runtime' | 'logic' | 'modern';
export type BugSeverity = 'critical' | 'warning' | 'info';
export type ExplanationMode = 'plain' | 'technical';

export interface UnifiedBugFinding {
  id: string;
  line: number;
  endLine: number;
  source: 'static-ast' | 'sandbox-runtime' | 'ai-latest';
  category: BugCategory;
  severity: BugSeverity;
  title: string;
  kind: string;
  plainEnglishExplanation: string;
  technicalExplanation: string;
  impactSummary: string;
  originalSnippet: string;
  suggestedReplacement: string | null;
  canAutoFix: boolean;
  cweOrRule?: string;
  isModernPattern?: boolean;
}

export interface AiScanStatus {
  status: 'ok' | 'skipped' | 'error';
  model?: string;
  findingsCount: number;
  durationMs?: number;
  message: string;
}

export interface VoiceNote {
  id: string;
  findingId: string;
  filename: string;
  line: number;
  bugTitle: string;
  createdAt: string;
  durationSec: number;
  mimeType: string;
  audioDataUrl: string;
  transcript: string;
  transcriptionStatus: 'transcribing' | 'completed' | 'failed' | 'manual';
  transcriptionError?: string;
}

export interface AnalysisResponse {
  analysisId?: string;
  filename: string;
  testFilename: string;
  language?: string;
  originalCode: string;
  patchedCode: string;
  generatedTestCode?: string;
  eli10?: Eli10Explanation;
  astReport: AstReport;
  baseline: TestRunResult;
  sbfl?: SbflSpectrum;
  patchInfo: PatchInfo;
  sandbox: TestRunResult;
  diff: DiffData;
  confidence: ConfidenceBreakdown;
  trustVerdict: TrustVerdict;
  verificationMode?: VerificationMode;
  verificationStatus?: VerificationStatus;
  originalSourceHash?: string;
  analysisKind?: AnalysisKind;
  testSynthesisStatus?: TestSynthesisStatus;
  sandboxIsolation?: SandboxIsolationInfo;
  remainingUncertainty?: string[];
  auditStorageMode?: 'client-local-only' | 'backend-append-only';
  graphRagContext?: {
    used: boolean;
    projectId?: string;
    relatedEntitiesCount: number;
    summary?: string;
  };
  unifiedFindings?: UnifiedBugFinding[];
  aiScanStatus?: AiScanStatus;
}

export type AuditDecision = 'accepted' | 'rejected' | 'override' | 'blocked';

export interface AuditEntry {
  id: string;
  timestamp: string;
  filename: string;
  line: number | null;
  bugType: string;
  ruleId: string;
  confidence: number;
  baselinePassed: number;
  baselineTotal: number;
  sandboxPassed: number;
  sandboxTotal: number;
  sandboxVerdict: TrustVerdict;
  decision: AuditDecision;
  summary: string;
  overrideReason?: string;
  linesAdded: number;
  linesRemoved: number;
  voiceNoteCount?: number;
  voiceNotesSummary?: string;
}

export interface DemoCase {
  id: string;
  title: string;
  language: string;
  category: string;
  expectedOutcome: 'auto-verified' | 'blocked-review';
  description: string;
  filename: string;
  testFilename: string;
  sourceCode: string;
  testCode: string;
  bugContext?: string;
}

export type AppView = 'dashboard' | 'projects' | 'history';
export type DashboardTab = 'inspector' | 'diff';

export type AutoPatchSeverity = 'Critical' | 'High' | 'Medium' | 'Low';
export type AutoPatchTestStatus = 'pass' | 'fail';

export type AutoPatchTestCaseType = 'normal' | 'boundary' | 'invalid';

export interface AutoPatchTestCase {
  input: string;
  expected_output: string;
  actual_output?: string;
  status: AutoPatchTestStatus;
  case_type?: AutoPatchTestCaseType;
}

export interface AutoPatchBug {
  id: string;
  title: string;
  severity: AutoPatchSeverity;
  confidence: number;
  errored_statement: string;
  root_cause: string;
  before_code: string;
  after_code: string;
  test_cases: AutoPatchTestCase[];
}

export interface AutoPatchSummary {
  health_score: number;
  overview: string;
  prioritized_actions: string[];
}

export interface AutoPatchReport {
  bugs: AutoPatchBug[];
  summary: AutoPatchSummary;
  detected_language: string;
  trace_logs: string[];
  execution_source: 'gemini' | 'local-sandbox';
  model?: string;
}

export type SafePatchDecision = 'Accepted' | 'Rejected';

export interface SafeChangeHistoryEntry {
  id: string;
  timestamp: string;
  filename: string;
  bugId: string;
  bugTitle: string;
  severity: AutoPatchSeverity;
  confidence: number;
  decision: SafePatchDecision;
  errored_statement: string;
  before_code: string;
  after_code: string;
  execution_source: 'gemini' | 'local-sandbox';
}

export type WorkflowStageId = 1 | 2 | 3 | 4 | 5;

export interface WorkspaceFileItem {
  id: string;
  filename: string;
  sourceCode: string;
  testCode: string;
  testFilename?: string;
  errorStatement: string;
  language: string;
}

export type BatchFileStatus = 'pending' | 'scanning' | 'completed' | 'error';

export interface BatchFileResult {
  fileId: string;
  filename: string;
  status: BatchFileStatus;
  currentStage: WorkflowStageId;
  report: AutoPatchReport | null;
  decisions: Record<string, SafePatchDecision>;
  errorMessage: string | null;
  errorCode: string | null;
}


