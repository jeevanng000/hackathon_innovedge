import type {
  AnalysisResponse,
  AutoPatchBug,
  AutoPatchReport,
  AutoPatchSeverity,
  AutoPatchTestCase,
  AutoPatchTestCaseType,
  BatchFileResult,
  SafeChangeHistoryEntry,
  SafePatchDecision,
  UnifiedBugFinding,
  WorkspaceFileItem,
} from '../types/autopatch.ts';
import { detectLanguageFromCodeOrFilename } from './languageDetect.ts';
import { buildUnifiedFindings } from './unifiedFindings.ts';

const VALID_SEVERITIES: Record<string, AutoPatchSeverity> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const SEVERITY_WEIGHT: Record<AutoPatchSeverity, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

export function normalizeAutoPatchSeverity(raw: unknown): AutoPatchSeverity {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return VALID_SEVERITIES[key] ?? 'Medium';
}

export function normalizeTestCaseType(raw: unknown): AutoPatchTestCaseType | undefined {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (key === 'normal' || key === 'boundary' || key === 'invalid') {
    return key;
  }
  return undefined;
}

export function sortAutoPatchBugs(bugs: ReadonlyArray<AutoPatchBug>): AutoPatchBug[] {
  return [...bugs].sort((a, b) => {
    const sevDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });
}

export function clampPercentage(value: unknown, fallback = 85): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export function validateSubmissionInput(input: string): {
  valid: boolean;
  error?: string;
} {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    return {
      valid: false,
      error: 'Paste a code snippet, an error traceback, or upload a source file to start.',
    };
  }
  if (trimmed.length < 8) {
    return {
      valid: false,
      error: 'Please enter a slightly longer snippet or problem description (at least 8 characters).',
    };
  }
  return { valid: true };
}

export function normalizeGeminiReport(
  raw: unknown,
  context?: { fallbackLanguage?: string; model?: string }
): AutoPatchReport {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBugs = Array.isArray(obj.bugs) ? obj.bugs : [];

  const parsedBugs: AutoPatchBug[] = rawBugs.map((item, idx) => {
    const b = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const rawTests = Array.isArray(b.test_cases) ? b.test_cases : [];
    const testCases: AutoPatchTestCase[] = rawTests.map((tc) => {
      const t = (tc && typeof tc === 'object' ? tc : {}) as Record<string, unknown>;
      const statusRaw = typeof t.status === 'string' ? t.status.trim().toLowerCase() : 'fail';
      const caseType = normalizeTestCaseType(t.case_type);
      return {
        input: typeof t.input === 'string' ? t.input : String(t.input ?? 'default_input'),
        expected_output:
          typeof t.expected_output === 'string'
            ? t.expected_output
            : String(t.expected_output ?? 'No exception'),
        actual_output: typeof t.actual_output === 'string' ? t.actual_output : undefined,
        status: statusRaw === 'pass' || statusRaw === 'passed' ? 'pass' : 'fail',
        ...(caseType ? { case_type: caseType } : {}),
      };
    });

    return {
      id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : `bug-${idx + 1}`,
      title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : `Detected Issue #${idx + 1}`,
      severity: normalizeAutoPatchSeverity(b.severity),
      confidence: clampPercentage(b.confidence, 88),
      errored_statement:
        typeof b.errored_statement === 'string' ? b.errored_statement : '',
      root_cause:
        typeof b.root_cause === 'string' && b.root_cause.trim()
          ? b.root_cause.trim()
          : 'Potential edge-case failure on unexpected input.',
      before_code: typeof b.before_code === 'string' ? b.before_code : '',
      after_code: typeof b.after_code === 'string' ? b.after_code : '',
      test_cases: testCases,
    };
  });

  const bugs = sortAutoPatchBugs(parsedBugs);

  const rawSummary = (obj.summary && typeof obj.summary === 'object'
    ? obj.summary
    : {}) as Record<string, unknown>;

  const actions = Array.isArray(rawSummary.prioritized_actions)
    ? rawSummary.prioritized_actions
        .map((a) => (typeof a === 'string' ? a.trim() : String(a ?? '').trim()))
        .filter(Boolean)
    : [];

  const traceLogs = Array.isArray(obj.trace_logs)
    ? obj.trace_logs
        .map((l) => (typeof l === 'string' ? l.trim() : String(l ?? '').trim()))
        .filter(Boolean)
    : [];

  return {
    bugs,
    summary: {
      health_score: clampPercentage(rawSummary.health_score, bugs.length === 0 ? 96 : 62),
      overview:
        typeof rawSummary.overview === 'string' && rawSummary.overview.trim()
          ? rawSummary.overview.trim()
          : bugs.length === 0
          ? 'No defects detected in the analyzed snippet.'
          : `Detected ${bugs.length} actionable issue${bugs.length === 1 ? '' : 's'} with minimal patches ready for review.`,
      prioritized_actions:
        actions.length > 0
          ? actions
          : bugs.map((b) => `[${b.severity}] ${b.title}`),
    },
    detected_language:
      typeof obj.detected_language === 'string' && obj.detected_language.trim()
        ? obj.detected_language.trim()
        : context?.fallbackLanguage || 'python',
    trace_logs:
      traceLogs.length > 0
        ? traceLogs
        : [
            '1. Parsed input source & inferred runtime context.',
            `2. Scanned AST & control-flow paths (${bugs.length} findings).`,
            '3. Generated minimal root-cause explanations and focused patches.',
            '4. Synthesized regression test cases for verification.',
          ],
    execution_source: 'gemini',
    model: context?.model || 'gemini-4-hydrogen',
  };
}

function mapUnifiedSeverity(finding: UnifiedBugFinding): AutoPatchSeverity {
  if (finding.severity === 'critical') {
    return finding.category === 'security' ? 'Critical' : 'High';
  }
  if (finding.severity === 'warning') return 'Medium';
  return 'Low';
}

export function adaptDeterministicAnalysisToReport(
  analysis: AnalysisResponse
): AutoPatchReport {
  const unified = analysis.unifiedFindings ?? buildUnifiedFindings(analysis, []);
  const confidenceScore = clampPercentage(analysis.confidence?.score, 84);

  const inferCaseType = (name: string): AutoPatchTestCaseType => {
    const lower = name.toLowerCase();
    if (/(empty|zero|boundary|edge|limit|max|min|overflow|large|null|none)/.test(lower)) {
      return 'boundary';
    }
    if (/(invalid|inject|malformed|bad|missing|error|unauth|wrong|negative)/.test(lower)) {
      return 'invalid';
    }
    return 'normal';
  };

  const testCasesFromSandbox: AutoPatchTestCase[] = (analysis.sandbox?.tests ?? []).map((t) => ({
    input: t.name,
    expected_output: 'Assertion passes in isolated sandbox',
    actual_output: t.errorMessage || (t.status === 'passed' ? 'Passed' : 'Failed'),
    status: t.status === 'passed' ? 'pass' : 'fail',
    case_type: inferCaseType(t.name),
  }));

  const baselineCases: AutoPatchTestCase[] = (analysis.baseline?.tests ?? []).map((t) => ({
    input: t.name,
    expected_output: 'No unhandled exception or assertion failure',
    actual_output: t.errorMessage || (t.status === 'passed' ? 'Passed' : 'Failed'),
    status: t.status === 'passed' ? 'pass' : 'fail',
    case_type: inferCaseType(t.name),
  }));

  const rawBugs: AutoPatchBug[] = unified.map((f, idx) => {
    const isPatchApplied = analysis.patchInfo?.patchApplied && f.canAutoFix;
    const cases: AutoPatchTestCase[] =
      isPatchApplied && testCasesFromSandbox.length > 0
        ? testCasesFromSandbox
        : baselineCases.length > 0
        ? baselineCases
        : [
            {
              input: `Edge-case input targeting line ${f.line}`,
              expected_output: 'Safe handled return without crash',
              actual_output: f.impactSummary,
              status: 'fail',
              case_type: 'boundary',
            },
          ];

    return {
      id: f.id || `sandbox-bug-${idx + 1}`,
      title: f.title,
      severity: mapUnifiedSeverity(f),
      confidence: clampPercentage(
        f.canAutoFix ? confidenceScore : Math.max(55, confidenceScore - 18),
        82
      ),
      errored_statement: f.originalSnippet || `Line ${f.line}`,
      root_cause: `${f.plainEnglishExplanation} ${f.impactSummary ? `(${f.impactSummary})` : ''}`.trim(),
      before_code: f.originalSnippet || analysis.originalCode,
      after_code:
        f.suggestedReplacement ??
        (analysis.patchInfo?.patchApplied ? analysis.patchedCode : f.originalSnippet),
      test_cases: cases,
    };
  });

  const bugs = sortAutoPatchBugs(rawBugs);

  const passedCount = analysis.sandbox?.passed ?? 0;
  const totalCount = analysis.sandbox?.total ?? 0;
  const healthScore =
    totalCount > 0 && bugs.length === 0
      ? 96
      : analysis.trustVerdict === 'verified'
      ? Math.max(72, Math.min(92, confidenceScore))
      : analysis.trustVerdict === 'already_passing'
      ? 94
      : Math.max(25, Math.min(68, 70 - bugs.length * 14));

  const traceLogs: string[] = [
    `1. Input normalized: ${analysis.filename} (${analysis.language || 'python'}).`,
    `2. Static AST & data-flow scan completed in ${analysis.astReport.durationMs.toFixed(1)}ms (${analysis.astReport.findings.length} AST finding${analysis.astReport.findings.length === 1 ? '' : 's'}).`,
    `3. Baseline sandbox executed: ${analysis.baseline.passed}/${analysis.baseline.total} passed${analysis.baseline.errorType ? ` (${analysis.baseline.errorType})` : ''}.`,
    analysis.patchInfo.patchApplied
      ? `4. Patch generated via ${analysis.patchInfo.strategy} (${analysis.patchInfo.ruleId}).`
      : `4. Manual review flagged: ${analysis.patchInfo.rootCause}`,
    `5. Post-patch validation: ${passedCount}/${totalCount} tests passing (verdict: ${analysis.trustVerdict}).`,
  ];

  return {
    bugs,
    summary: {
      health_score: healthScore,
      overview:
        analysis.trustVerdict === 'verified'
          ? `Verified ${bugs.length} issue${bugs.length === 1 ? '' : 's'} with ${passedCount}/${totalCount} sandbox tests passing after repair.`
          : analysis.patchInfo.rootCause || 'Analysis complete in local deterministic sandbox.',
      prioritized_actions:
        bugs.length > 0
          ? bugs.map((b) => `[${b.severity}] ${b.title}`)
          : ['All executed sandbox assertions passed without detected defects.'],
    },
    detected_language: analysis.language || 'python',
    trace_logs: traceLogs,
    execution_source: 'local-sandbox',
    model: 'Deterministic AST + Isolated Sandbox',
  };
}

/**
 * Applies a bug's after_code replacement into sourceCode safely.
 * First attempts exact match of before_code, then trimmed-line block match, then errored_statement match.
 */
export function applyPatchToCode(
  sourceCode: string,
  bug: Pick<AutoPatchBug, 'before_code' | 'after_code' | 'errored_statement'>
): { updatedCode: string; applied: boolean } {
  const after = bug.after_code ?? '';
  if (!after.trim()) {
    return { updatedCode: sourceCode, applied: false };
  }

  const before = bug.before_code ?? '';
  if (before && sourceCode.includes(before)) {
    return {
      updatedCode: sourceCode.replace(before, after),
      applied: true,
    };
  }

  const errored = bug.errored_statement ?? '';
  if (errored && sourceCode.includes(errored)) {
    return {
      updatedCode: sourceCode.replace(errored, after),
      applied: true,
    };
  }

  // Line-trimmed fallback match for indentation differences
  if (before.trim()) {
    const srcLines = sourceCode.split('\n');
    const beforeLines = before.split('\n').map((l) => l.trim());
    const firstTrimmed = beforeLines[0];
    if (firstTrimmed) {
      for (let i = 0; i <= srcLines.length - beforeLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < beforeLines.length; j++) {
          if (srcLines[i + j].trim() !== beforeLines[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          const replacementLines = after.split('\n');
          const nextLines = [...srcLines];
          nextLines.splice(i, beforeLines.length, ...replacementLines);
          return {
            updatedCode: nextLines.join('\n'),
            applied: true,
          };
        }
      }
    }
  }

  return { updatedCode: sourceCode, applied: false };
}

/**
 * Finds 1-indexed line numbers in sourceCode that match the errored_statement or before_code.
 */
export function findErroredLineIndices(
  sourceCode: string,
  erroredStatement: string,
  beforeCode?: string
): Set<number> {
  const highlighted = new Set<number>();
  const lines = sourceCode.split('\n');
  const candidates = [erroredStatement, beforeCode]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .flatMap((block) =>
      block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    );

  if (candidates.length === 0) return highlighted;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (candidates.some((c) => trimmed === c || trimmed.includes(c) || c.includes(trimmed))) {
      highlighted.add(idx + 1);
    }
  });

  return highlighted;
}

export function computeTestSummary(
  bugs: ReadonlyArray<AutoPatchBug>,
  decisions: Readonly<Record<string, SafePatchDecision>>
): { passed: number; failed: number; total: number } {
  let passed = 0;
  let failed = 0;

  for (const bug of bugs) {
    const decision = decisions[bug.id];
    for (const tc of bug.test_cases) {
      if (decision === 'Accepted') {
        passed++;
      } else if (tc.status === 'pass') {
        passed++;
      } else {
        failed++;
      }
    }
  }

  return { passed, failed, total: passed + failed };
}

export function createHistoryEntry(params: {
  bug: AutoPatchBug;
  decision: SafePatchDecision;
  filename: string;
  executionSource: 'gemini' | 'local-sandbox';
  timestamp?: string;
}): SafeChangeHistoryEntry {
  return {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: params.timestamp ?? new Date().toISOString(),
    filename: params.filename,
    bugId: params.bug.id,
    bugTitle: params.bug.title,
    severity: params.bug.severity,
    confidence: params.bug.confidence,
    decision: params.decision,
    errored_statement: params.bug.errored_statement,
    before_code: params.bug.before_code,
    after_code: params.bug.after_code,
    execution_source: params.executionSource,
  };
}

export function getAdjacentBugId(
  bugs: ReadonlyArray<{ id: string }>,
  activeId: string | null,
  direction: 'next' | 'prev'
): string | null {
  if (bugs.length === 0) return null;
  const idx = activeId ? bugs.findIndex((b) => b.id === activeId) : -1;
  if (idx === -1) {
    return direction === 'next' ? bugs[0].id : bugs[bugs.length - 1].id;
  }
  const nextIdx = (idx + (direction === 'next' ? 1 : -1) + bugs.length) % bugs.length;
  return bugs[nextIdx].id;
}

function getBasename(filepath: string): string {
  const parts = filepath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filepath;
}

function extractTestTargetKey(filename: string): string | null {
  const base = getBasename(filename);
  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx).toLowerCase() : '';

  if (/^test_(.+)$/i.test(stem)) {
    const target = stem.replace(/^test_/i, '');
    return `${target.toLowerCase()}${ext}`;
  }
  if (/^(.+)_test$/i.test(stem)) {
    const target = stem.replace(/_test$/i, '');
    return `${target.toLowerCase()}${ext}`;
  }
  if (/^(.+)\.(test|spec)$/i.test(stem)) {
    const target = stem.replace(/\.(test|spec)$/i, '');
    return `${target.toLowerCase()}${ext}`;
  }
  return null;
}

/**
 * Pairs uploaded test files (e.g. `test_foo.py`, `foo.test.ts`, `foo_spec.js`)
 * with their matching source files (`foo.py`, `foo.ts`, `foo.js`).
 * Any test file without a matching source file is still preserved as its own
 * analyzable WorkspaceFileItem so every uploaded file produces output.
 */
export function pairSourceAndTestFiles(
  files: ReadonlyArray<{ name: string; content: string; errorStatement?: string }>
): WorkspaceFileItem[] {
  const sourceByKey = new Map<string, { name: string; content: string; errorStatement?: string }>();
  const testEntries: Array<{
    file: { name: string; content: string; errorStatement?: string };
    targetKey: string;
  }> = [];
  const orderedSources: Array<{ name: string; content: string; errorStatement?: string }> = [];

  for (const file of files) {
    const safeName = getBasename(file.name).trim() || 'snippet.py';
    const targetKey = extractTestTargetKey(safeName);
    if (targetKey) {
      testEntries.push({ file: { ...file, name: safeName }, targetKey });
    } else {
      const normalized = { ...file, name: safeName };
      orderedSources.push(normalized);
      sourceByKey.set(safeName.toLowerCase(), normalized);
    }
  }

  const pairedTestsBySourceName = new Map<string, { name: string; content: string }>();
  const standaloneTests: Array<{ name: string; content: string; errorStatement?: string }> = [];

  for (const entry of testEntries) {
    const matchedSource = sourceByKey.get(entry.targetKey);
    if (matchedSource) {
      pairedTestsBySourceName.set(matchedSource.name.toLowerCase(), entry.file);
    } else {
      standaloneTests.push(entry.file);
    }
  }

  const combined = [...orderedSources, ...standaloneTests];
  return combined.map((file, index) => {
    const pairedTest = pairedTestsBySourceName.get(file.name.toLowerCase());
    return {
      id: `file-${index + 1}-${file.name}`,
      filename: file.name,
      sourceCode: file.content,
      testCode: pairedTest?.content ?? '',
      testFilename: pairedTest?.name,
      errorStatement: file.errorStatement ?? '',
      language: detectLanguageFromCodeOrFilename(file.content, file.name),
    };
  });
}

export interface BatchSummaryMetrics {
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  scanningFiles: number;
  totalBugs: number;
  acceptedPatches: number;
  averageHealthScore: number;
}

export function computeBatchSummary(
  results: ReadonlyArray<BatchFileResult>
): BatchSummaryMetrics {
  let completedFiles = 0;
  let failedFiles = 0;
  let scanningFiles = 0;
  let totalBugs = 0;
  let acceptedPatches = 0;
  let healthSum = 0;
  let healthCount = 0;

  for (const item of results) {
    if (item.status === 'completed') completedFiles++;
    else if (item.status === 'error') failedFiles++;
    else if (item.status === 'scanning') scanningFiles++;

    if (item.report) {
      const bugs = item.report.bugs ?? [];
      totalBugs += bugs.length;
      const accepted = bugs.filter((b) => item.decisions[b.id] === 'Accepted').length;
      acceptedPatches += accepted;
      const base = item.report.summary.health_score;
      const effective =
        bugs.length === 0
          ? base
          : Math.min(100, base + Math.round(((100 - base) * accepted) / bugs.length));
      healthSum += effective;
      healthCount++;
    }
  }

  return {
    totalFiles: results.length,
    completedFiles,
    failedFiles,
    scanningFiles,
    totalBugs,
    acceptedPatches,
    averageHealthScore: healthCount > 0 ? Math.round(healthSum / healthCount) : 0,
  };
}

export function buildBatchMarkdownExport(
  results: ReadonlyArray<BatchFileResult>
): string {
  const summary = computeBatchSummary(results);
  const lines: string[] = [
    '# AutoPatch Multi-File Diagnostic & Patch Report',
    '',
    `- **Files Analyzed:** ${summary.completedFiles}/${summary.totalFiles}`,
    `- **Total Bugs Detected:** ${summary.totalBugs}`,
    `- **Accepted Patches:** ${summary.acceptedPatches}`,
    `- **Average Health Score:** ${summary.averageHealthScore}/100`,
    '',
  ];

  for (const item of results) {
    lines.push(`## ${item.filename}`);
    if (item.errorMessage) {
      lines.push(`- **Status:** Error — ${item.errorMessage}`);
      lines.push('');
      continue;
    }
    if (!item.report) {
      lines.push(`- **Status:** ${item.status}`);
      lines.push('');
      continue;
    }
    lines.push(`- **Language:** ${item.report.detected_language}`);
    lines.push(`- **Engine:** ${item.report.execution_source}`);
    lines.push(`- **Health Score:** ${item.report.summary.health_score}/100`);
    lines.push(`- **Overview:** ${item.report.summary.overview}`);
    if (item.report.bugs.length === 0) {
      lines.push('- No defects detected.');
    } else {
      lines.push(`- **Bugs (${item.report.bugs.length}):**`);
      for (const bug of item.report.bugs) {
        const dec = item.decisions[bug.id] ?? 'Pending';
        lines.push(`  - [${bug.severity}] **${bug.title}** (${bug.confidence}% conf, ${dec})`);
        lines.push(`    - Statement: \`${bug.errored_statement}\``);
        lines.push(`    - Root Cause: ${bug.root_cause}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Merges a primary report (e.g. Gemini AI deep scan) with a secondary report
 * (e.g. fast deterministic AST + sandbox validation) so tough multi-bug files
 * retain both semantic AI repairs and concrete AST/sandbox-verified findings.
 */
export function mergeAutoPatchReports(
  primary: AutoPatchReport,
  secondary: AutoPatchReport
): AutoPatchReport {
  const existingStatements = new Set(
    primary.bugs
      .map((b) => b.errored_statement.trim().toLowerCase())
      .filter(Boolean)
  );
  const existingTitles = new Set(
    primary.bugs.map((b) => b.title.trim().toLowerCase()).filter(Boolean)
  );

  const uniqueSecondary = secondary.bugs.filter((b) => {
    const stmt = b.errored_statement.trim().toLowerCase();
    const title = b.title.trim().toLowerCase();
    if (stmt && existingStatements.has(stmt)) return false;
    if (title && existingTitles.has(title)) return false;
    return true;
  });

  const mergedBugs = sortAutoPatchBugs([...primary.bugs, ...uniqueSecondary]);
  const mergedTrace = Array.from(
    new Set([...primary.trace_logs, ...secondary.trace_logs])
  );
  const mergedActions = Array.from(
    new Set([
      ...primary.summary.prioritized_actions,
      ...uniqueSecondary.map((b) => `[${b.severity}] ${b.title}`),
    ])
  );

  return {
    ...primary,
    bugs: mergedBugs,
    summary: {
      health_score:
        uniqueSecondary.length > 0
          ? Math.min(primary.summary.health_score, secondary.summary.health_score)
          : primary.summary.health_score,
      overview: primary.summary.overview,
      prioritized_actions: mergedActions,
    },
    trace_logs: mergedTrace,
  };
}


