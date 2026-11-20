import type {
  AnalysisResponse,
  AstFinding,
  BugCategory,
  BugSeverity,
  SideBySideDiffRow,
  UnifiedBugFinding,
} from '../types/autopatch.ts';

interface LineReplacementHunk {
  startLine: number;
  endLine: number;
  originalText: string;
  replacementText: string;
}

/**
 * Groups contiguous changed rows in sideBySide diff into line-range replacement hunks
 * anchored to 1-indexed line numbers in the original source code.
 */
function extractDiffHunks(sideBySide: SideBySideDiffRow[]): LineReplacementHunk[] {
  const hunks: LineReplacementHunk[] = [];
  let i = 0;

  while (i < sideBySide.length) {
    const row = sideBySide[i];
    if (row.type === 'equal') {
      i++;
      continue;
    }

    let startLine: number | null = null;
    let endLine: number | null = null;
    const origLines: string[] = [];
    const newLines: string[] = [];

    while (i < sideBySide.length && sideBySide[i].type !== 'equal') {
      const cur = sideBySide[i];
      if (cur.leftLine !== null) {
        if (startLine === null) startLine = cur.leftLine;
        endLine = cur.leftLine;
        if (cur.leftText !== null) origLines.push(cur.leftText);
      }
      if (cur.rightText !== null) {
        newLines.push(cur.rightText);
      }
      i++;
    }

    // Handle pure insertion right before/after an existing line
    if (startLine === null && i < sideBySide.length && sideBySide[i].leftLine !== null) {
      const anchor = sideBySide[i].leftLine!;
      const anchorText = sideBySide[i].leftText ?? '';
      hunks.push({
        startLine: anchor,
        endLine: anchor,
        originalText: anchorText,
        replacementText: [...newLines, anchorText].join('\n'),
      });
    } else if (startLine !== null && endLine !== null) {
      hunks.push({
        startLine,
        endLine,
        originalText: origLines.join('\n'),
        replacementText: newLines.join('\n'),
      });
    }
  }

  return hunks;
}

function classifyCategory(kind: string, astCategory?: string): BugCategory {
  if (astCategory === 'security') return 'security';
  if (
    /Injection|Secret|Buffer|Eval|Taint|Xss|Ssrf|Traversal|Prototype|Deserial/i.test(kind)
  ) {
    return 'security';
  }
  if (
    /ZeroDivision|Null|None|KeyError|Index|Timeout|Loop|Unbound|TypeError|Syntax|Runtime/i.test(
      kind
    ) ||
    astCategory === 'runtime' ||
    astCategory === 'syntax'
  ) {
    return 'runtime';
  }
  if (/Modern|Async|Race|Memory|Leak|Deprecated|Concurrency/i.test(kind)) {
    return 'modern';
  }
  return 'logic';
}

function describeAstFindingPlainEnglish(finding: AstFinding): {
  title: string;
  plain: string;
  impact: string;
} {
  const kind = finding.kind;
  switch (kind) {
    case 'ZeroDivisionRisk':
      return {
        title: `Division by zero risk (${finding.denominator || 'denominator'})`,
        plain: `This line divides by "${finding.denominator || 'a number'}" without checking if it equals 0 first. If that value is ever zero, the program will crash immediately.`,
        impact: 'Crashes at runtime when input is empty or zero.',
      };
    case 'NullDereferenceRisk':
      return {
        title: `Missing empty/null check on "${finding.variable || 'value'}"`,
        plain: `The variable "${finding.variable || 'value'}" might be empty (None/null), and this line tries to read inside it directly. Checking if it exists first prevents a crash.`,
        impact: 'Throws a NoneType / NullPointer crash on missing records.',
      };
    case 'IndexBoundaryRisk':
      return {
        title: 'Loop goes one step past the end of the list',
        plain: `Using "<=" or an inclusive range reaches one index past the last item in "${finding.sequence || 'the list'}". Changing it to "<" keeps the loop safely inside bounds.`,
        impact: 'Reads past array bounds or crashes with undefined/out-of-range error.',
      };
    case 'KeyErrorRisk':
      return {
        title: 'Direct lookup on a key that may not exist',
        plain: `This line reads or writes a dictionary key directly without verifying the key is present first. If the key is missing, the program throws a KeyError.`,
        impact: 'Raises KeyError when given an unknown entry.',
      };
    case 'SqlInjectionRisk':
      return {
        title: 'Unsafe SQL query built with text joining',
        plain: `User input is glued directly into the SQL text. Someone could type special SQL characters to read or alter database rows. Use parameterized "?" placeholders instead.`,
        impact: 'Critical SQL injection vulnerability.',
      };
    case 'TaintInjectionRisk':
    case 'CommandInjectionRisk':
      return {
        title: `Dangerous dynamic execution (${finding.sink || 'sink'})`,
        plain: `Untrusted input flows into "${finding.sink || 'eval/shell'}", which runs arbitrary text as real code or system commands. Replace it with a safe parser or parameterized call.`,
        impact: 'Allows arbitrary code or command execution.',
      };
    case 'HardcodedSecretRisk':
      return {
        title: 'Secret or password written directly in code',
        plain: `A password, token, or API key is stored as plain text inside the source file. Move it to an environment variable so it is not leaked in version control.`,
        impact: 'Exposes credentials to anyone who can view the code.',
      };
    case 'InfiniteLoopRisk':
      return {
        title: 'Loop has no guaranteed exit condition',
        plain: `This loop can keep repeating forever if malformed or unexpected data keeps re-entering it, freezing the worker or hitting timeouts.`,
        impact: 'Hangs the program and triggers sandbox timeout.',
      };
    case 'DeadCodeRisk':
      return {
        title: 'Unreachable code after return',
        plain: `This line sits right after a return or exit statement, so the program will never run it. Removing it keeps the function clean and avoids confusion.`,
        impact: 'Misleading dead statement that never executes.',
      };
    case 'MutableDefaultRisk':
      return {
        title: 'Shared mutable default argument',
        plain: `Python creates default lists/dicts only once when the function is defined, so changes leak across future calls. Default to None and initialize inside the function.`,
        impact: 'Causes subtle state leaks between separate function calls.',
      };
    case 'UnboundLocalError':
      return {
        title: 'Variable used before it is assigned',
        plain: `This line reads a local variable on a path where it may not have been given a value yet.`,
        impact: 'Crashes with UnboundLocalError on certain branches.',
      };
    default:
      return {
        title: kind.replace(/([A-Z])/g, ' $1').trim(),
        plain: finding.message,
        impact: finding.severity === 'error' ? 'May crash or fail tests.' : 'Code quality or reliability warning.',
      };
  }
}

export function buildUnifiedFindings(
  analysis: AnalysisResponse,
  aiFindings: UnifiedBugFinding[] = []
): UnifiedBugFinding[] {
  const sourceLines = analysis.originalCode.split('\n');
  const hunks = extractDiffHunks(analysis.diff.sideBySide);
  const results: UnifiedBugFinding[] = [];
  const usedHunks = new Set<number>();

  const findMatchingHunk = (line: number): { hunk: LineReplacementHunk; index: number } | null => {
    // Exact or nearby match within +/- 2 lines
    for (let idx = 0; idx < hunks.length; idx++) {
      const h = hunks[idx];
      if (line >= h.startLine - 1 && line <= h.endLine + 1) {
        return { hunk: h, index: idx };
      }
    }
    return null;
  };

  // 1. Convert AST / Static findings
  for (const f of analysis.astReport.findings) {
    const line = Math.max(1, Math.min(sourceLines.length, f.line || 1));
    const match = findMatchingHunk(line);
    if (match) usedHunks.add(match.index);

    const category = classifyCategory(f.kind, f.category);
    const severity: BugSeverity =
      category === 'security'
        ? 'critical'
        : f.severity === 'error'
        ? 'critical'
        : 'warning';
    const plainDesc = describeAstFindingPlainEnglish(f);

    results.push({
      id: f.id || `ast-${line}-${f.kind}`,
      line: match ? match.hunk.startLine : line,
      endLine: match ? match.hunk.endLine : line,
      source: 'static-ast',
      category,
      severity,
      title: plainDesc.title,
      kind: f.kind,
      plainEnglishExplanation: plainDesc.plain,
      technicalExplanation: f.message,
      impactSummary: plainDesc.impact,
      originalSnippet: match ? match.hunk.originalText : sourceLines[line - 1] ?? f.snippet ?? '',
      suggestedReplacement: match ? match.hunk.replacementText : null,
      canAutoFix: Boolean(match),
      cweOrRule: f.kind,
    });
  }

  // 2. Include any remaining diff hunks (e.g. SBFL boundary mutation fixes like `>` -> `>=` or runtime traceback fixes)
  hunks.forEach((hunk, idx) => {
    if (usedHunks.has(idx)) return;
    const alreadyOnLine = results.some(
      (r) => r.line <= hunk.endLine && r.endLine >= hunk.startLine
    );
    if (alreadyOnLine) return;

    const category = classifyCategory(analysis.patchInfo.bugType);
    results.push({
      id: `patch-hunk-${hunk.startLine}-${idx}`,
      line: hunk.startLine,
      endLine: hunk.endLine,
      source: 'sandbox-runtime',
      category,
      severity: 'critical',
      title: `${analysis.patchInfo.bugType} detected via test trace`,
      kind: analysis.patchInfo.bugType,
      plainEnglishExplanation:
        analysis.patchInfo.rootCause ||
        `Tests failed when executing line ${hunk.startLine}. Applying the verified fix resolves the failing edge case.`,
      technicalExplanation: `${analysis.patchInfo.ruleId}: ${analysis.patchInfo.strategy}`,
      impactSummary: analysis.baseline.errorMessage || 'Fails automated test assertions.',
      originalSnippet: hunk.originalText,
      suggestedReplacement: hunk.replacementText,
      canAutoFix: true,
      cweOrRule: analysis.patchInfo.ruleId,
    });
  });

  // 3. If baseline failed/timed out and no finding covers that line yet, add a runtime finding
  if (
    (analysis.baseline.failed > 0 || analysis.baseline.timedOut) &&
    results.length === 0
  ) {
    const errLine = Math.max(
      1,
      Math.min(
        sourceLines.length,
        analysis.patchInfo.targetLine ?? analysis.baseline.errorLine ?? 1
      )
    );
    results.push({
      id: `runtime-${errLine}`,
      line: errLine,
      endLine: errLine,
      source: 'sandbox-runtime',
      category: 'runtime',
      severity: 'critical',
      title: analysis.baseline.timedOut
        ? 'Execution timed out (infinite loop or stall)'
        : `${analysis.patchInfo.bugType || analysis.baseline.errorType || 'Runtime Error'}`,
      kind: analysis.patchInfo.bugType || analysis.baseline.errorType || 'RuntimeError',
      plainEnglishExplanation: analysis.baseline.timedOut
        ? 'When running your program, this loop never finished within the 2-second safety limit. It needs a way to exit or skip bad items.'
        : analysis.patchInfo.rootCause ||
          analysis.baseline.errorMessage ||
          'A test failed while executing this line.',
      technicalExplanation:
        analysis.baseline.errorMessage || analysis.patchInfo.rootCause || 'Baseline execution failed.',
      impactSummary: analysis.baseline.timedOut
        ? 'Program hangs indefinitely; manual logic update required.'
        : 'Causes test suite failure.',
      originalSnippet: sourceLines[errLine - 1] ?? '',
      suggestedReplacement: null,
      canAutoFix: false,
      cweOrRule: analysis.patchInfo.ruleId,
    });
  }

  // 4. Merge Gemini latest-bug findings (deduplicate overlapping identical line issues, keep novel/modern ones)
  for (const ai of aiFindings) {
    const safeLine = Math.max(1, Math.min(sourceLines.length, ai.line || 1));
    const safeEnd = Math.max(safeLine, Math.min(sourceLines.length, ai.endLine || safeLine));
    const overlapsExisting = results.some(
      (r) =>
        Math.abs(r.line - safeLine) <= 1 &&
        (r.category === ai.category || r.canAutoFix)
    );

    if (overlapsExisting) {
      // Enrich existing finding's plain-English context if it lacks a rich explanation
      const existing = results.find((r) => Math.abs(r.line - safeLine) <= 1);
      if (existing && !existing.isModernPattern && ai.isModernPattern) {
        existing.isModernPattern = true;
      }
      continue;
    }

    results.push({
      ...ai,
      line: safeLine,
      endLine: safeEnd,
      originalSnippet:
        ai.originalSnippet || sourceLines.slice(safeLine - 1, safeEnd).join('\n'),
    });
  }

  return results.sort((a, b) => a.line - b.line || a.severity.localeCompare(b.severity));
}

/**
 * Applies a single finding's replacement cleanly to sourceCode.
 */
export function applyFindingFixToSource(
  sourceCode: string,
  finding: UnifiedBugFinding
): string {
  if (!finding.canAutoFix || finding.suggestedReplacement === null) {
    return sourceCode;
  }
  const lines = sourceCode.split('\n');
  const startIdx = Math.max(0, finding.line - 1);
  const deleteCount = Math.max(1, finding.endLine - finding.line + 1);
  const replacementLines =
    finding.suggestedReplacement === '' ? [] : finding.suggestedReplacement.split('\n');
  lines.splice(startIdx, deleteCount, ...replacementLines);
  return lines.join('\n');
}

/**
 * Applies all non-overlapping auto-fixable findings from bottom to top so line numbers stay accurate.
 */
export function applyAllSafeFixesToSource(
  sourceCode: string,
  findings: UnifiedBugFinding[]
): { updatedCode: string; appliedIds: string[] } {
  const fixable = findings
    .filter((f) => f.canAutoFix && f.suggestedReplacement !== null)
    .sort((a, b) => b.line - a.line);

  let lines = sourceCode.split('\n');
  const appliedIds: string[] = [];
  let minAppliedStart = Number.POSITIVE_INFINITY;

  for (const f of fixable) {
    if (f.endLine >= minAppliedStart) {
      continue; // Skip overlapping range to avoid corrupting earlier edit
    }
    const startIdx = Math.max(0, f.line - 1);
    const deleteCount = Math.max(1, f.endLine - f.line + 1);
    const replacementLines =
      f.suggestedReplacement === '' ? [] : f.suggestedReplacement!.split('\n');
    lines.splice(startIdx, deleteCount, ...replacementLines);
    minAppliedStart = f.line;
    appliedIds.push(f.id);
  }

  return {
    updatedCode: lines.join('\n'),
    appliedIds,
  };
}

/**
 * Computes the next or previous finding ID in the active list with wrap-around.
 */
export function getAdjacentFindingId(
  findings: ReadonlyArray<{ id: string }>,
  activeFindingId: string | null,
  direction: 'next' | 'prev'
): string | null {
  if (findings.length === 0) return null;
  const currentIdx = activeFindingId
    ? findings.findIndex((f) => f.id === activeFindingId)
    : -1;

  if (currentIdx === -1) {
    return direction === 'next'
      ? findings[0].id
      : findings[findings.length - 1].id;
  }

  const delta = direction === 'next' ? 1 : -1;
  const targetIdx = (currentIdx + delta + findings.length) % findings.length;
  return findings[targetIdx].id;
}

/**
 * Returns true if keyboard shortcuts should be ignored because the user is typing
 * inside a form field, editable region, or interacting with an audio/video control.
 */
export function isEditableTargetElement(
  target: { tagName?: string; isContentEditable?: boolean } | null
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'AUDIO' ||
    tag === 'VIDEO'
  );
}

const SEVERITY_PRIORITY: Record<BugSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Returns a new array of findings prioritized by severity (Critical -> Warning -> Info),
 * breaking ties by ascending line number.
 */
export function sortFindingsBySeverity<
  T extends Pick<UnifiedBugFinding, 'severity' | 'line'>,
>(findings: ReadonlyArray<T>): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity] ||
      a.line - b.line
  );
}


