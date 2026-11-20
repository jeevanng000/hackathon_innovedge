import crypto from 'node:crypto';
import { transform } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AnalysisKind,
  AnalysisResponse,
  AprMutantEvaluation,
  AstFinding,
  AstReport,
  CallGraphEdge,
  ConfidenceBreakdown,
  CoverageStatus,
  DiffData,
  FunctionMetric,
  PatchInfo,
  SbflLineRanking,
  SbflSpectrum,
  SideBySideDiffRow,
  TestCaseResult,
  TestRunResult,
  TestSynthesisStatus,
  TrustVerdict,
  VerificationMode,
  VerificationStatus,
} from '../src/types/autopatch.ts';
import {
  detectLanguageFromFilename,
  EXECUTABLE_SANDBOX_LANGUAGES,
  getLanguageMeta,
  type SupportedLanguage,
} from '../src/utils/languageDetect.ts';
import { computeOchiai, computeTarantula } from '../src/utils/sbfl.ts';
import { analyzeJsTsAst, instrumentJsTsForSbfl } from './js_ts_ast.ts';
import {
  createSandboxTempDir,
  getSandboxIsolationInfo,
  runInIsolatedSandbox,
  writeSandboxFile,
} from './sandbox_runner.ts';

export interface MultiLangRequest {
  action: 'analyze' | 'validate';
  language?: SupportedLanguage;
  filename: string;
  testFilename: string;
  sourceCode?: string;
  originalCode?: string;
  candidateCode?: string;
  testCode?: string;
  bugContext?: string;
  timeoutSeconds?: number;
  /**
   * Internal-only field set by server.ts ONLY after cryptographic SHA-256 verification
   * against ServerAnalysisStore. Raw client-supplied baselines are NEVER trusted.
   */
  _trustedServerBaseline?: TestRunResult | null;
  targetLine?: number | null;
  bugType?: string;
  rootCause?: string;
}

function sanitizeFileBase(name: string, fallback: string): string {
  const base = path.basename(name || fallback);
  const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '_');
  return cleaned || fallback;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips single-line and multi-line comments and string literals (preserving line breaks)
 * so heuristic scanners for languages without a local compiler NEVER flag text inside
 * comments or string literals.
 */
export function stripCommentsAndStringsPreservingLines(
  code: string,
  language: SupportedLanguage
): string {
  const hashCommentLangs = new Set<SupportedLanguage>(['python', 'ruby', 'bash', 'php']);
  const sqlLang = language === 'sql';
  const out: string[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    const next = i + 1 < n ? code[i + 1] : '';

    // Block comment /* ... */
    if (!sqlLang && ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < n) {
        if (code[i] === '*' && code[i + 1] === '/') {
          out.push('  ');
          i += 2;
          break;
        }
        out.push(code[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    // SQL block comment /* ... */ or line comment --
    if (sqlLang && ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < n) {
        if (code[i] === '*' && code[i + 1] === '/') {
          out.push('  ');
          i += 2;
          break;
        }
        out.push(code[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    if (sqlLang && ch === '-' && next === '-') {
      while (i < n && code[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    // C-style line comment //
    if (!sqlLang && ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    // Hash line comment # (for Bash / Ruby / PHP / Python)
    if (hashCommentLangs.has(language) && ch === '#') {
      while (i < n && code[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    // String literals: preserve quotes as empty "" or '' so syntax structure remains intact
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out.push(quote);
      i++;
      while (i < n) {
        if (code[i] === '\\' && i + 1 < n) {
          out.push(' ');
          out.push(code[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          out.push(quote);
          i++;
          break;
        }
        out.push(code[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}

/**
 * Memory-bounded diff generator producing side-by-side rows and unified diff text.
 *
 * 1. Trims identical prefix and suffix in O(n + m) time & O(1) extra memory.
 * 2. Uses exact LCS DP only when the changed middle region satisfies midN * midM <= 400,000 (~1.6MB cap).
 * 3. For massive diffs exceeding the DP cell budget, falls back to an O(n + m) linear
 *    hash-anchored diff so large files never suffer quadratic memory blowup.
 */
export function computeTextDiff(original: string, patched: string, filename: string): DiffData {
  const a = original.split('\n');
  const b = patched.split('\n');
  const n = a.length;
  const m = b.length;

  type Op = { kind: 'equal' | 'delete' | 'insert'; leftLine?: number; rightLine?: number; text: string };
  const ops: Op[] = [];

  // 1. Strip identical prefix in O(min(n, m))
  let prefix = 0;
  const minLen = Math.min(n, m);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    ops.push({ kind: 'equal', leftLine: prefix + 1, rightLine: prefix + 1, text: a[prefix] });
    prefix++;
  }

  // 2. Strip identical suffix in O(min(n, m))
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix++;
  }

  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;
  const MAX_DP_CELLS = 400_000;

  if (midN > 0 || midM > 0) {
    if (midN === 0) {
      for (let j = 0; j < midM; j++) {
        ops.push({ kind: 'insert', rightLine: prefix + j + 1, text: b[prefix + j] });
      }
    } else if (midM === 0) {
      for (let i = 0; i < midN; i++) {
        ops.push({ kind: 'delete', leftLine: prefix + i + 1, text: a[prefix + i] });
      }
    } else if (midN * midM <= MAX_DP_CELLS) {
      // Exact LCS on the trimmed changed middle window only
      const dp: Uint32Array[] = Array.from({ length: midN + 1 }, () => new Uint32Array(midM + 1));
      for (let i = midN - 1; i >= 0; i--) {
        const aLine = a[prefix + i];
        for (let j = midM - 1; j >= 0; j--) {
          if (aLine === b[prefix + j]) {
            dp[i][j] = dp[i + 1][j + 1] + 1;
          } else {
            dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
          }
        }
      }
      let i = 0;
      let j = 0;
      while (i < midN && j < midM) {
        if (a[prefix + i] === b[prefix + j]) {
          ops.push({
            kind: 'equal',
            leftLine: prefix + i + 1,
            rightLine: prefix + j + 1,
            text: a[prefix + i],
          });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          ops.push({ kind: 'delete', leftLine: prefix + i + 1, text: a[prefix + i] });
          i++;
        } else {
          ops.push({ kind: 'insert', rightLine: prefix + j + 1, text: b[prefix + j] });
          j++;
        }
      }
      while (i < midN) {
        ops.push({ kind: 'delete', leftLine: prefix + i + 1, text: a[prefix + i] });
        i++;
      }
      while (j < midM) {
        ops.push({ kind: 'insert', rightLine: prefix + j + 1, text: b[prefix + j] });
        j++;
      }
    } else {
      // Linear O(midN + midM) fallback for massive rewrites using bounded lookahead sync
      const bPositions = new Map<string, number[]>();
      for (let j = 0; j < midM; j++) {
        const line = b[prefix + j];
        const arr = bPositions.get(line);
        if (arr) {
          if (arr.length < 8) arr.push(j);
        } else {
          bPositions.set(line, [j]);
        }
      }
      let i = 0;
      let j = 0;
      const LOOKAHEAD = 64;
      while (i < midN && j < midM) {
        if (a[prefix + i] === b[prefix + j]) {
          ops.push({
            kind: 'equal',
            leftLine: prefix + i + 1,
            rightLine: prefix + j + 1,
            text: a[prefix + i],
          });
          i++;
          j++;
          continue;
        }
        const candidates = bPositions.get(a[prefix + i]);
        const matchJ = candidates?.find((pos) => pos >= j && pos <= j + LOOKAHEAD);
        if (matchJ !== undefined) {
          while (j < matchJ) {
            ops.push({ kind: 'insert', rightLine: prefix + j + 1, text: b[prefix + j] });
            j++;
          }
        } else {
          ops.push({ kind: 'delete', leftLine: prefix + i + 1, text: a[prefix + i] });
          i++;
        }
      }
      while (i < midN) {
        ops.push({ kind: 'delete', leftLine: prefix + i + 1, text: a[prefix + i] });
        i++;
      }
      while (j < midM) {
        ops.push({ kind: 'insert', rightLine: prefix + j + 1, text: b[prefix + j] });
        j++;
      }
    }
  }

  for (let k = suffix - 1; k >= 0; k--) {
    const li = n - 1 - k;
    const ri = m - 1 - k;
    ops.push({ kind: 'equal', leftLine: li + 1, rightLine: ri + 1, text: a[li] });
  }

  const sideBySide: SideBySideDiffRow[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let idx = 0;
  while (idx < ops.length) {
    const cur = ops[idx];
    if (cur.kind === 'equal') {
      sideBySide.push({
        type: 'equal',
        leftLine: cur.leftLine ?? null,
        leftText: cur.text,
        rightLine: cur.rightLine ?? null,
        rightText: cur.text,
      });
      idx++;
    } else {
      const dels: Op[] = [];
      const ins: Op[] = [];
      while (idx < ops.length && ops[idx].kind !== 'equal') {
        if (ops[idx].kind === 'delete') dels.push(ops[idx]);
        else ins.push(ops[idx]);
        idx++;
      }
      const span = Math.max(dels.length, ins.length);
      for (let k = 0; k < span; k++) {
        const d = dels[k];
        const insOp = ins[k];
        if (d) linesRemoved++;
        if (insOp) linesAdded++;
        const rowType: SideBySideDiffRow['type'] =
          d && insOp ? 'replace' : d ? 'delete' : 'insert';
        sideBySide.push({
          type: rowType,
          leftLine: d?.leftLine ?? null,
          leftText: d ? d.text : null,
          rightLine: insOp?.rightLine ?? null,
          rightText: insOp ? insOp.text : null,
        });
      }
    }
  }

  const unifiedLines: string[] = [];
  if (linesAdded > 0 || linesRemoved > 0) {
    unifiedLines.push(`--- a/${filename}`);
    unifiedLines.push(`+++ b/${filename}`);
    unifiedLines.push(`@@ -1,${n} +1,${m} @@`);
    for (const op of ops) {
      if (op.kind === 'equal') unifiedLines.push(` ${op.text}`);
      else if (op.kind === 'delete') unifiedLines.push(`-${op.text}`);
      else unifiedLines.push(`+${op.text}`);
    }
  }

  return {
    unified: unifiedLines.join('\n'),
    sideBySide,
    linesAdded,
    linesRemoved,
  };
}

/**
 * Runs genuine GCC / G++ syntax-only compiler diagnostics inside the isolated sandbox.
 */
async function runCCppSyntaxDiagnostics(
  sourceCode: string,
  filename: string,
  language: 'c' | 'cpp'
): Promise<{ syntaxValid: boolean; diagnostics: AstFinding[] }> {
  const tmpdir = await createSandboxTempDir('autopatch_csyn_');
  try {
    const ext = language === 'cpp' ? '.cpp' : '.c';
    const safeSrc = sanitizeFileBase(filename, `module${ext}`);
    const srcPath = await writeSandboxFile(tmpdir, safeSrc, sourceCode);
    const compiler = language === 'cpp' ? 'g++' : 'gcc';
    const run = await runInIsolatedSandbox(
      compiler,
      ['-fsyntax-only', '-Wall', '-Wextra', srcPath],
      { cwd: tmpdir, timeoutMs: 3500, mode: 'compile' }
    );

    if (run.executionUnavailable) {
      return { syntaxValid: true, diagnostics: [] };
    }

    const diagnostics: AstFinding[] = [];
    const srcLines = sourceCode.split('\n');
    const escaped = safeSrc.replace(/\./g, '\\.');
    const diagRegex = new RegExp(`${escaped}:(\\d+):(\\d+):\\s*(error|warning):\\s*(.+)`);
    let hasError = run.code !== 0;

    for (const rawLine of run.stderr.split('\n')) {
      const m = rawLine.match(diagRegex);
      if (!m) continue;
      const lineNum = Number(m[1]) || 1;
      const colNum = Number(m[2]) || 1;
      const sev = m[3] === 'error' ? 'error' : 'warning';
      const msg = m[4].trim();
      if (sev === 'error') hasError = true;
      diagnostics.push({
        id: `cc-diag-${sev}-${lineNum}-${colNum}`,
        kind: sev === 'error' ? 'SyntaxError' : 'CompilerWarning',
        category: sev === 'error' ? 'syntax' : 'quality',
        severity: sev,
        line: lineNum,
        col: colNum,
        function: '<module>',
        message: `${compiler}: ${msg}`,
        snippet: (srcLines[lineNum - 1] || '').trim(),
      });
    }

    return { syntaxValid: !hasError, diagnostics };
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Runs genuine `bash -n` syntax validation inside the isolated sandbox.
 */
async function runBashSyntaxDiagnostics(
  sourceCode: string,
  filename: string
): Promise<{ syntaxValid: boolean; diagnostics: AstFinding[] }> {
  const tmpdir = await createSandboxTempDir('autopatch_shsyn_');
  try {
    const safeSrc = sanitizeFileBase(filename, 'script.sh');
    const srcPath = await writeSandboxFile(tmpdir, safeSrc, sourceCode);
    const run = await runInIsolatedSandbox('bash', ['-n', srcPath], {
      cwd: tmpdir,
      timeoutMs: 2000,
      mode: 'run',
    });

    if (run.executionUnavailable || run.code === 0) {
      return { syntaxValid: true, diagnostics: [] };
    }

    const srcLines = sourceCode.split('\n');
    const m = run.stderr.match(/line\s+(\d+)/i);
    const lineNum = m ? Number(m[1]) : 1;
    return {
      syntaxValid: false,
      diagnostics: [
        {
          id: `bash-syntax-${lineNum}`,
          kind: 'SyntaxError',
          category: 'syntax',
          severity: 'error',
          line: lineNum,
          function: '<module>',
          message: `bash -n: ${run.stderr.trim() || 'Shell syntax error'}`,
          snippet: (srcLines[lineNum - 1] || '').trim(),
        },
      ],
    };
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Honest Multi-Language Static Analyzer:
 * - JavaScript / TypeScript: Genuine esbuild + Acorn ESTree AST parser (`analysisKind: 'ast-parser'`)
 * - C / C++: Genuine GCC / G++ `-fsyntax-only -Wall -Wextra` compiler diagnostics (`analysisKind: 'compiler-diagnostics'`) + comment-stripped static checks
 * - Bash: Genuine `bash -n` syntax check (`analysisKind: 'compiler-diagnostics'`) + comment-stripped static checks
 * - Java, Go, Rust, C#, PHP, Ruby, SQL, Generic: Clearly classified comment/string-stripped heuristic static checks (`analysisKind: 'heuristic'`), never mislabeled as an AST parser.
 */
export async function analyzeStaticMultiLang(
  sourceCode: string,
  filename: string,
  language: SupportedLanguage
): Promise<AstReport> {
  // 1. Genuine AST parser for JS / TS
  if (language === 'javascript' || language === 'typescript') {
    return analyzeJsTsAst(sourceCode, filename, language);
  }

  const t0 = performance.now();
  const rawLines = sourceCode.split('\n');
  const strippedSource = stripCommentsAndStringsPreservingLines(sourceCode, language);
  const cleanLines = strippedSource.split('\n');
  const findings: AstFinding[] = [];
  const functions: FunctionMetric[] = [];
  const callGraph: CallGraphEdge[] = [];
  let syntaxValid = true;
  let analysisKind: AnalysisKind = 'heuristic';
  let parserTool = 'comment-stripped-heuristic';

  // 2. Genuine compiler/syntax diagnostics for C, C++, Bash
  if (language === 'c' || language === 'cpp') {
    analysisKind = 'compiler-diagnostics';
    parserTool = language === 'cpp' ? 'g++ -fsyntax-only -Wall -Wextra' : 'gcc -fsyntax-only -Wall -Wextra';
    const cc = await runCCppSyntaxDiagnostics(sourceCode, filename, language);
    syntaxValid = cc.syntaxValid;
    for (const d of cc.diagnostics) {
      // Only include error diagnostics as hard findings; keep meaningful warnings cleanly
      if (d.severity === 'error') {
        findings.push(d);
      }
    }
  } else if (language === 'bash') {
    analysisKind = 'compiler-diagnostics';
    parserTool = 'bash -n';
    const sh = await runBashSyntaxDiagnostics(sourceCode, filename);
    syntaxValid = sh.syntaxValid;
    findings.push(...sh.diagnostics);
  }

  // 3. Balanced delimiter check for brace-based heuristic languages (already stripped of comments & strings)
  const heuristicBraceLanguages: SupportedLanguage[] = ['java', 'go', 'rust', 'csharp', 'php'];
  if (heuristicBraceLanguages.includes(language)) {
    let braceDepth = 0;
    let parenDepth = 0;
    for (let i = 0; i < cleanLines.length; i++) {
      for (const ch of cleanLines[i]) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }
      if (braceDepth < 0 || parenDepth < 0) {
        syntaxValid = false;
        findings.push({
          id: `heur-brace-${i + 1}`,
          kind: 'SyntaxError',
          category: 'syntax',
          severity: 'error',
          line: i + 1,
          function: '<module>',
          message: `Heuristic delimiter check: unmatched closing delimiter on line ${i + 1}.`,
          snippet: rawLines[i].trim(),
        });
        break;
      }
    }
    if (syntaxValid && (braceDepth > 0 || parenDepth > 0)) {
      syntaxValid = false;
      findings.push({
        id: `heur-unclosed-${rawLines.length}`,
        kind: 'SyntaxError',
        category: 'syntax',
        severity: 'error',
        line: rawLines.length,
        function: '<module>',
        message: `Heuristic delimiter check: unclosed ${braceDepth > 0 ? "'{'" : "'('"} detected before EOF.`,
        snippet: (rawLines[rawLines.length - 1] || '').trim(),
      });
    }
  }

  // 4. Function extraction & static heuristic checks on comment/string-stripped lines
  const funcHeaderPatterns: RegExp[] = [
    /^\s*(?:public|private|protected|static|final|inline|virtual|extern|\s)*[A-Za-z_][\w<>\[\]*&\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/,
    /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/,
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/,
    /^\s*def\s+([A-Za-z_]\w*)\s*(?:\(|$)/,
    /^\s*([A-Za-z_]\w*)\s*\(\)\s*\{/,
  ];
  const controlKeywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'elif', 'try', 'match', 'sizeof', 'typeof',
  ]);

  let currentFuncName = '<module>';
  let currentFuncStart = 1;
  let currentFuncDepth = 0;
  let currentFuncLines: string[] = [];

  const flushFunction = (endLine: number) => {
    if (currentFuncName === '<module>' || currentFuncLines.length === 0) return;
    const bodyText = currentFuncLines.join('\n');
    const decisionMatches = bodyText.match(/\b(if|else\s+if|elif|for|while|case|catch)\b|&&|\|\||\?/g);
    const complexity = 1 + (decisionMatches ? decisionMatches.length : 0);
    const callMatches = bodyText.match(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/g) ?? [];
    const calls: string[] = [];
    for (const raw of callMatches) {
      const name = raw.replace(/\($/, '').trim();
      const base = name.split('.')[0];
      if (!controlKeywords.has(base) && name !== currentFuncName && !calls.includes(name)) {
        calls.push(name);
        callGraph.push({ caller: currentFuncName, callee: name });
      }
    }
    functions.push({
      name: currentFuncName,
      startLine: currentFuncStart,
      endLine,
      cyclomaticComplexity: complexity,
      calls: calls.slice(0, 8),
    });
  };

  for (let i = 0; i < rawLines.length; i++) {
    const rawLn = rawLines[i];
    const cleanLn = cleanLines[i] || '';
    const trimmedClean = cleanLn.trim();
    const trimmedRaw = rawLn.trim();

    let matchedName: string | null = null;
    for (const rx of funcHeaderPatterns) {
      const m = cleanLn.match(rx);
      if (m && m[1] && !controlKeywords.has(m[1])) {
        matchedName = m[1];
        break;
      }
    }
    if (matchedName && (currentFuncName === '<module>' || currentFuncDepth <= 0)) {
      flushFunction(i);
      currentFuncName = matchedName;
      currentFuncStart = i + 1;
      currentFuncLines = [cleanLn];
      currentFuncDepth = (cleanLn.match(/\{/g)?.length ?? 0) - (cleanLn.match(/\}/g)?.length ?? 0);
    } else if (currentFuncName !== '<module>') {
      currentFuncLines.push(cleanLn);
      currentFuncDepth += (cleanLn.match(/\{/g)?.length ?? 0) - (cleanLn.match(/\}/g)?.length ?? 0);
      if (currentFuncDepth <= 0 && (trimmedClean === '}' || trimmedClean === 'end' || trimmedClean === '};')) {
        flushFunction(i + 1);
        currentFuncName = '<module>';
        currentFuncLines = [];
      }
    }

    if (!trimmedClean) continue;
    const fnLabel = currentFuncName;

    // Off-by-one loop boundary: for (...; i <= arr.length; ...)
    const idxMatch = cleanLn.match(/for\s*\([^;]*;\s*[A-Za-z_]\w*\s*<=\s*([A-Za-z_][\w.]*(?:\(\))?)\s*;/);
    if (idxMatch && /(length|size\(\)|count|len|n\b)/i.test(idxMatch[1])) {
      findings.push({
        id: `static-idx-${i + 1}`,
        kind: 'IndexBoundaryRisk',
        category: 'runtime',
        severity: 'error',
        line: i + 1,
        function: fnLabel,
        sequence: idxMatch[1],
        message: `Loop condition '<= ${idxMatch[1]}' exceeds valid 0-based index bounds (0..len-1).`,
        snippet: trimmedRaw,
      });
    }

    // Rust / Ruby inclusive range: 0..=arr.len()
    const rustRange = cleanLn.match(/0\.\.=([A-Za-z_]\w*\.len\(\))/);
    if (rustRange) {
      findings.push({
        id: `static-idx-rust-${i + 1}`,
        kind: 'IndexBoundaryRisk',
        category: 'runtime',
        severity: 'error',
        line: i + 1,
        function: fnLabel,
        sequence: rustRange[1],
        message: `Inclusive range '0..=${rustRange[1]}' panics with index-out-of-bounds on the final iteration.`,
        snippet: trimmedRaw,
      });
    }

    // Unprotected division by variable denominator (evaluated on comment/string-stripped line)
    const divMatch = cleanLn.match(/[^/]\s*\/\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\b/);
    if (divMatch && !/^\s*(if|while|for)\b/.test(cleanLn)) {
      const denom = divMatch[1];
      const prevContext = cleanLines.slice(Math.max(0, i - 6), i).join('\n');
      const guarded =
        prevContext.includes(`${denom} == 0`) ||
        prevContext.includes(`${denom} === 0`) ||
        prevContext.includes(`${denom} != 0`) ||
        prevContext.includes(`${denom} !== 0`) ||
        prevContext.includes(`!${denom}`) ||
        prevContext.includes(`${denom} <= 0`) ||
        prevContext.includes(`-eq 0`);
      if (!guarded && !/^(Math|Number|parseFloat|parseInt|double|float|int|long|size_t)$/.test(denom)) {
        findings.push({
          id: `static-div-${i + 1}`,
          kind: 'ZeroDivisionRisk',
          category: 'runtime',
          severity: 'error',
          line: i + 1,
          function: fnLabel,
          denominator: denom,
          message: `Unprotected division by '${denom}' without a zero-denominator guard.`,
          snippet: trimmedRaw,
        });
      }
    }

    // Dynamic code execution sinks (evaluated on stripped code, never comments/strings)
    if (/\beval\s*\(/.test(cleanLn)) {
      findings.push({
        id: `taint-eval-${i + 1}`,
        kind: 'TaintInjectionRisk',
        category: 'security',
        severity: 'error',
        line: i + 1,
        function: fnLabel,
        sink: 'eval',
        message: `Dynamic code execution sink 'eval()' detected on line ${i + 1}.`,
        snippet: trimmedRaw,
      });
    }

    // SQL injection: check raw code where non-comment portion contains SQL string joined with variable
    if (
      trimmedClean &&
      /(SELECT|INSERT|UPDATE|DELETE)\b/i.test(rawLn) &&
      /(\$\{[^}]+\}|"\s*\+\s*[A-Za-z_]\w*|'\s*\+\s*[A-Za-z_]\w*)/.test(rawLn) &&
      !trimmedRaw.startsWith('//') &&
      !trimmedRaw.startsWith('#') &&
      !trimmedRaw.startsWith('--')
    ) {
      findings.push({
        id: `taint-sql-${i + 1}`,
        kind: 'SqlInjectionRisk',
        category: 'security',
        severity: 'error',
        line: i + 1,
        function: fnLabel,
        sink: 'SQL query',
        message: `Dynamic string concatenation/interpolation in SQL query exposes SQL injection risk on line ${i + 1}.`,
        snippet: trimmedRaw,
      });
    }

    // SQL unbounded SELECT * without LIMIT in .sql files
    if (
      language === 'sql' &&
      /\bSELECT\s+\*\s+FROM\s+\w+/i.test(rawLn) &&
      !/\bLIMIT\b/i.test(rawLn) &&
      !trimmedRaw.startsWith('--')
    ) {
      findings.push({
        id: `sql-unbounded-${i + 1}`,
        kind: 'UnboundedQueryRisk',
        category: 'runtime',
        severity: 'warning',
        line: i + 1,
        function: '<query>',
        message: `Unbounded 'SELECT *' query on line ${i + 1} lacks a LIMIT clause.`,
        snippet: trimmedRaw,
      });
    }

    // Unsafe C/C++ buffer functions
    if (/\b(strcpy|gets|sprintf)\s*\(/.test(cleanLn) && (language === 'c' || language === 'cpp')) {
      findings.push({
        id: `taint-buf-${i + 1}`,
        kind: 'BufferOverflowRisk',
        category: 'security',
        severity: 'error',
        line: i + 1,
        function: fnLabel,
        sink: cleanLn.match(/\b(strcpy|gets|sprintf)\b/)?.[1],
        message: `Unbounded C buffer function detected on line ${i + 1}; use bounded alternatives (strncpy/snprintf).`,
        snippet: trimmedRaw,
      });
    }

    // Hardcoded secret literal (checked against raw assignment only when line is not a comment)
    if (
      !trimmedRaw.startsWith('//') &&
      !trimmedRaw.startsWith('#') &&
      !trimmedRaw.startsWith('*') &&
      /(password|api_key|apiKey|secret|token)\s*[:=]\s*["'`][^"'`]{6,}["'`]/i.test(rawLn)
    ) {
      findings.push({
        id: `taint-secret-${i + 1}`,
        kind: 'HardcodedSecretRisk',
        category: 'security',
        severity: 'warning',
        line: i + 1,
        function: fnLabel,
        message: `Potential hardcoded secret literal detected on line ${i + 1}.`,
        snippet: trimmedRaw,
      });
    }

    // Infinite loop check on stripped code
    if (/^\s*(while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)|loop\s*\{|while\s+true\b)/.test(cleanLn)) {
      const lookahead = cleanLines.slice(i + 1, i + 12).join('\n');
      if (!/\b(break|return|throw|exit|panic)\b/.test(lookahead)) {
        findings.push({
          id: `cfg-loop-${i + 1}`,
          kind: 'InfiniteLoopRisk',
          category: 'cfg',
          severity: 'error',
          line: i + 1,
          function: fnLabel,
          message: `Unbounded loop on line ${i + 1} has no reachable break or return exit.`,
          snippet: trimmedRaw,
        });
      }
    }

    // Unreachable dead code right after unconditional return (checked on stripped code)
    if (/^\s*return\b[^;]*;?\s*$/.test(cleanLn) && i + 1 < cleanLines.length) {
      const nextClean = cleanLines[i + 1];
      const nextTrimmed = nextClean.trim();
      const curIndent = cleanLn.length - cleanLn.trimStart().length;
      const nextIndent = nextClean.length - nextClean.trimStart().length;
      if (
        nextTrimmed &&
        !nextTrimmed.startsWith('}') &&
        !nextTrimmed.startsWith('case ') &&
        !nextTrimmed.startsWith('default:') &&
        nextIndent === curIndent
      ) {
        findings.push({
          id: `cfg-dead-${i + 2}`,
          kind: 'DeadCodeRisk',
          category: 'cfg',
          severity: 'warning',
          line: i + 2,
          function: fnLabel,
          message: `Unreachable statement on line ${i + 2} immediately follows an unconditional return.`,
          snippet: rawLines[i + 1].trim(),
        });
      }
    }

    // Nullable lookup (.get(...) / .find(...)) dereferenced without null check
    const nullGetMatch = cleanLn.match(
      /^\s*(?:const|let|var|auto|[A-Za-z_][\w<>[\]*\s]*)\s+([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*\.(?:get|find)\s*\(/
    );
    if (nullGetMatch) {
      const nullableVar = nullGetMatch[1];
      for (let k = i + 1; k < Math.min(cleanLines.length, i + 10); k++) {
        const nextLn = cleanLines[k];
        if (
          nextLn.includes(`${nullableVar} != null`) ||
          nextLn.includes(`${nullableVar} !== null`) ||
          nextLn.includes(`${nullableVar} !== undefined`) ||
          nextLn.includes(`!${nullableVar}`) ||
          nextLn.includes(`${nullableVar}?.`)
        ) {
          break;
        }
        const derefMatch = nextLn.match(
          new RegExp(`^\\s*if\\s*\\(\\s*(${nullableVar}(?:\\[[^\\]]+\\]|\\.[A-Za-z_]\\w*)[^)]*)\\)`)
        );
        if (derefMatch) {
          findings.push({
            id: `static-null-${k + 1}-${nullableVar}`,
            kind: 'NullDereferenceRisk',
            category: 'runtime',
            severity: 'error',
            line: k + 1,
            function: fnLabel,
            variable: nullableVar,
            message: `Nullable lookup variable '${nullableVar}' is dereferenced on line ${k + 1} without a null/undefined guard.`,
            snippet: rawLines[k].trim(),
          });
          break;
        }
      }
    }
  }
  flushFunction(rawLines.length);

  return {
    syntaxValid,
    durationMs: Number((performance.now() - t0).toFixed(2)),
    findings,
    functions,
    callGraph,
    analysisKind,
    parserTool,
  };
}

function makeExecutionUnavailableRun(reason: string, durationMs: number): TestRunResult {
  return {
    timedOut: false,
    importError: false,
    passed: 0,
    failed: 0,
    total: 0,
    durationMs,
    errorType: 'ExecutionUnavailable',
    errorMessage: reason,
    errorLine: null,
    traceback: reason,
    tests: [],
    executionKind: 'execution-unavailable',
  };
}

/**
 * Isolated Node.js sandbox runner for JavaScript & TypeScript:
 * - Uses genuine Acorn AST statement instrumentation mapped to original TS/JS lines for REAL SBFL.
 * - NEVER fabricates coverage lines!
 * - Executes inside isolated Linux namespaces as UID nobody with stripped env & prlimit.
 */
async function runJsTsSandbox(
  sourceCode: string,
  testCode: string,
  filename: string,
  testFilename: string,
  language: 'javascript' | 'typescript',
  timeoutSec: number
): Promise<TestRunResult> {
  const tmpdir = await createSandboxTempDir('autopatch_js_');
  const t0 = performance.now();
  try {
    const safeSrc = sanitizeFileBase(filename, language === 'typescript' ? 'module.ts' : 'module.js');
    const jsSrcName = safeSrc.replace(/\.(ts|tsx|mts|jsx)$/, '.mjs').replace(/\.js$/, '.mjs');
    const jsTestName = sanitizeFileBase(testFilename, 'test_module.mjs').replace(
      /\.(ts|tsx|mts|jsx|js)$/,
      '.mjs'
    );

    let instrumentedSrc: string;
    let compiledTest: string;
    let lineMap = new Map<number, number>();
    try {
      const inst = await instrumentJsTsForSbfl(sourceCode, safeSrc, language);
      instrumentedSrc = inst.code;
      lineMap = inst.lineMap;

      const baseNoExt = safeSrc.replace(/\.[^.]+$/, '');
      const rewrittenTest = testCode.replace(
        new RegExp(`(['"])(\\.\\/${escapeRegex(baseNoExt)})(\\.(?:ts|tsx|js|jsx|mjs))?\\1`, 'g'),
        `$1./${jsSrcName}$1`
      );
      const testRes = await transform(rewrittenTest, {
        loader: language === 'typescript' ? 'ts' : 'js',
        format: 'esm',
        sourcefile: testFilename,
      });
      compiledTest = testRes.code;
    } catch (err) {
      const errAny = err as { errors?: Array<{ text: string; location?: { line: number } }> };
      const first = errAny.errors?.[0];
      const msg = first?.text || (err instanceof Error ? err.message : 'Compile error');
      const line = first?.location?.line ?? 1;
      const durationMs = Number((performance.now() - t0).toFixed(2));
      return {
        timedOut: false,
        importError: true,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs,
        errorType: 'SyntaxError',
        errorMessage: msg,
        errorLine: line,
        traceback: `${safeSrc}:${line}\nSyntaxError: ${msg}`,
        executionKind: 'dynamic-sandbox',
        tests: [
          {
            name: 'compile_and_parse',
            status: 'failed',
            durationMs,
            errorType: 'SyntaxError',
            errorMessage: msg,
            errorLine: line,
            traceback: `${safeSrc}:${line}\nSyntaxError: ${msg}`,
            executedLines: [],
          },
        ],
      };
    }

    await writeSandboxFile(tmpdir, jsSrcName, instrumentedSrc);
    await writeSandboxFile(tmpdir, jsTestName, compiledTest);

    const lineMapObj = Object.fromEntries(lineMap.entries());
    const runnerScript = `
import * as mod from './${jsTestName}';
const LINE_MAP = ${JSON.stringify(lineMapObj)};
const results = [];
const tAll = performance.now();
const entries = Object.entries(mod).filter(([k, v]) => k.startsWith('test') && typeof v === 'function');
for (const [name, fn] of entries) {
  const t0 = performance.now();
  const hitSet = new Set();
  globalThis.__AP_SET__ = hitSet;
  try {
    await fn();
    globalThis.__AP_SET__ = null;
    results.push({
      name,
      status: 'passed',
      durationMs: Number((performance.now() - t0).toFixed(2)),
      executedLines: Array.from(hitSet).sort((a, b) => a - b),
    });
  } catch (err) {
    globalThis.__AP_SET__ = null;
    const stack = String(err?.stack || err);
    const lineMatch = stack.match(/${escapeRegex(jsSrcName)}:(\\d+)/);
    const genLine = lineMatch ? Math.max(1, Number(lineMatch[1]) - 1) : null;
    const errLine = genLine ? (LINE_MAP[String(genLine)] || genLine) : null;
    if (errLine) hitSet.add(errLine);
    results.push({
      name,
      status: 'failed',
      durationMs: Number((performance.now() - t0).toFixed(2)),
      errorType: err?.name || 'Error',
      errorMessage: err?.message || String(err),
      errorLine: errLine,
      traceback: stack,
      executedLines: Array.from(hitSet).sort((a, b) => a - b),
    });
  }
}
const passed = results.filter(r => r.status === 'passed').length;
const failed = results.filter(r => r.status === 'failed').length;
const firstFail = results.find(r => r.status === 'failed') || null;
process.stdout.write('\\n__AP_RESULT__:' + JSON.stringify({
  timedOut: false,
  importError: false,
  passed,
  failed,
  total: results.length,
  durationMs: Number((performance.now() - tAll).toFixed(2)),
  errorType: firstFail?.errorType || null,
  errorMessage: firstFail?.errorMessage || null,
  errorLine: firstFail?.errorLine || null,
  traceback: firstFail?.traceback || null,
  tests: results,
}) + '\\n');
`;
    const runnerPath = await writeSandboxFile(tmpdir, '_ap_runner.mjs', runnerScript);

    const run = await runInIsolatedSandbox('node', [runnerPath], {
      cwd: tmpdir,
      timeoutMs: Math.round(timeoutSec * 1000),
      mode: 'node',
    });

    if (run.executionUnavailable) {
      return makeExecutionUnavailableRun(
        run.unavailableReason || run.stderr,
        run.durationMs
      );
    }

    if (run.timedOut) {
      return {
        timedOut: true,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'TimeoutError',
        errorMessage: `Isolated Node.js sandbox exceeded ${timeoutSec.toFixed(1)}s limit (probable infinite loop).`,
        errorLine: null,
        traceback: `SandboxTimeoutError: Isolated Node.js process tree terminated after ${timeoutSec.toFixed(1)}s.`,
        executionKind: 'dynamic-sandbox',
        outputTruncated: run.outputTruncated,
        tests: [
          {
            name: 'sandbox_execution_budget',
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'TimeoutError',
            errorMessage: `Terminated after ${timeoutSec.toFixed(1)}s timeout.`,
            errorLine: null,
            executedLines: [],
          },
        ],
      };
    }

    if (run.outputTruncated) {
      return {
        timedOut: false,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'OutputLimitExceeded',
        errorMessage: 'Sandbox process exceeded maximum allowed stdout/stderr byte limit and was terminated.',
        errorLine: null,
        traceback: 'OutputLimitExceeded: Process output exceeded sandbox buffer cap.',
        executionKind: 'dynamic-sandbox',
        outputTruncated: true,
        tests: [
          {
            name: 'sandbox_output_budget',
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'OutputLimitExceeded',
            errorMessage: 'Exceeded sandbox output cap.',
            executedLines: [],
          },
        ],
      };
    }

    const markerPrefix = '__AP_RESULT__:';
    const resultLine = run.stdout
      .split('\n')
      .reverse()
      .find((l) => l.startsWith(markerPrefix));

    if (resultLine) {
      try {
        const parsed = JSON.parse(resultLine.slice(markerPrefix.length)) as TestRunResult;
        parsed.executionKind = 'dynamic-sandbox';
        // Strictly honest: if 0 exported test functions ran, do NOT fabricate passes or coverage!
        if (parsed.total === 0) {
          parsed.errorType = 'NoTestsExecuted';
          parsed.errorMessage =
            'No exported test functions (export function test_...) were found or executed in the test file.';
        }
        return parsed;
      } catch {
        // Fall through to error return
      }
    }

    return {
      timedOut: false,
      importError: true,
      passed: 0,
      failed: 1,
      total: 1,
      durationMs: run.durationMs,
      errorType: 'RuntimeError',
      errorMessage: run.stderr.trim() || 'Isolated Node.js sandbox failed to execute test module.',
      errorLine: null,
      traceback: run.stderr.trim() || run.stdout.trim(),
      executionKind: 'dynamic-sandbox',
      tests: [
        {
          name: 'module_execution',
          status: 'failed',
          durationMs: run.durationMs,
          errorType: 'RuntimeError',
          errorMessage: run.stderr.trim() || 'Execution error',
          traceback: run.stderr.trim(),
          executedLines: [],
        },
      ],
    };
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Isolated GCC / G++ compile & native binary execution sandbox for C and C++.
 *
 * STRICT PASS RULE:
 * A C/C++ test run ONLY counts as passed when the compiled binary exits 0 AND emits
 * at least one explicit `PASS:<test_name>` (or `PASS` line) assertion result on stdout.
 * Exiting 0 with no test output is NEVER treated as a passed verification!
 */
async function runCCppSandbox(
  sourceCode: string,
  testCode: string,
  filename: string,
  testFilename: string,
  language: 'c' | 'cpp',
  timeoutSec: number
): Promise<TestRunResult> {
  const tmpdir = await createSandboxTempDir('autopatch_c_');
  const t0 = performance.now();
  try {
    const ext = language === 'cpp' ? '.cpp' : '.c';
    const safeSrc = sanitizeFileBase(filename, `module${ext}`);
    const safeTest = sanitizeFileBase(testFilename, `test_module${ext}`);
    const srcPath = await writeSandboxFile(tmpdir, safeSrc, sourceCode);
    const testPath = await writeSandboxFile(tmpdir, safeTest, testCode);
    const binPath = path.join(tmpdir, 'sandbox_runner');

    const compiler = language === 'cpp' ? 'g++' : 'gcc';
    const includesSource = testCode.includes(`"${safeSrc}"`);
    const compileArgs = includesSource
      ? ['-Wall', '-Wextra', testPath, '-o', binPath, '-lm']
      : ['-Wall', '-Wextra', srcPath, testPath, '-o', binPath, '-lm'];

    const comp = await runInIsolatedSandbox(compiler, compileArgs, {
      cwd: tmpdir,
      timeoutMs: 4500,
      mode: 'compile',
    });

    if (comp.executionUnavailable) {
      return makeExecutionUnavailableRun(
        comp.unavailableReason || comp.stderr,
        comp.durationMs
      );
    }

    if (comp.code !== 0) {
      const errLineMatch = comp.stderr.match(new RegExp(`${escapeRegex(safeSrc)}:(\\d+):`));
      const errLine = errLineMatch ? Number(errLineMatch[1]) : 1;
      const firstErr =
        comp.stderr
          .split('\n')
          .find((l) => l.includes('error:'))
          ?.trim() || comp.stderr.trim();
      return {
        timedOut: comp.timedOut,
        importError: true,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: comp.durationMs,
        errorType: comp.timedOut ? 'TimeoutError' : 'CompileError',
        errorMessage: firstErr || `${compiler} compilation failed.`,
        errorLine: errLine,
        traceback: comp.stderr.trim(),
        executionKind: 'dynamic-sandbox',
        tests: [
          {
            name: `${compiler}_compilation`,
            status: 'failed',
            durationMs: comp.durationMs,
            errorType: comp.timedOut ? 'TimeoutError' : 'CompileError',
            errorMessage: firstErr || `${compiler} compilation failed.`,
            errorLine: errLine,
            traceback: comp.stderr.trim(),
          },
        ],
      };
    }

    const run = await runInIsolatedSandbox(binPath, [], {
      cwd: tmpdir,
      timeoutMs: Math.round(timeoutSec * 1000),
      mode: 'run',
    });

    if (run.executionUnavailable) {
      return makeExecutionUnavailableRun(
        run.unavailableReason || run.stderr,
        run.durationMs
      );
    }

    if (run.timedOut) {
      return {
        timedOut: true,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'TimeoutError',
        errorMessage: `Compiled ${language.toUpperCase()} binary exceeded ${timeoutSec.toFixed(1)}s sandbox limit.`,
        errorLine: null,
        traceback: `SandboxTimeoutError: Process tree terminated after ${timeoutSec.toFixed(1)}s.`,
        executionKind: 'dynamic-sandbox',
        outputTruncated: run.outputTruncated,
        tests: [
          {
            name: 'sandbox_binary_budget',
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'TimeoutError',
            errorMessage: `Exceeded ${timeoutSec.toFixed(1)}s timeout.`,
          },
        ],
      };
    }

    if (run.outputTruncated) {
      return {
        timedOut: false,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'OutputLimitExceeded',
        errorMessage: 'Compiled binary exceeded stdout/stderr cap and was terminated.',
        errorLine: null,
        traceback: 'OutputLimitExceeded: Process output exceeded sandbox buffer cap.',
        executionKind: 'dynamic-sandbox',
        outputTruncated: true,
        tests: [
          {
            name: 'sandbox_output_budget',
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'OutputLimitExceeded',
            errorMessage: 'Exceeded sandbox output cap.',
          },
        ],
      };
    }

    // Parse explicit PASS:<name> / PASS / FAIL:<name>:<msg> lines printed by test harness
    const outLines = run.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const parsedTests: TestCaseResult[] = [];
    for (const line of outLines) {
      if (line.startsWith('PASS:')) {
        parsedTests.push({
          name: line.slice(5).trim() || 'c_test_case',
          status: 'passed',
          durationMs: Number((run.durationMs / Math.max(1, outLines.length)).toFixed(2)),
        });
      } else if (/^PASS\b/.test(line)) {
        parsedTests.push({
          name: line.replace(/^PASS\s*:?\s*/, '').trim() || 'c_test_case',
          status: 'passed',
          durationMs: Number((run.durationMs / Math.max(1, outLines.length)).toFixed(2)),
        });
      } else if (line.startsWith('FAIL:')) {
        const [, name, ...rest] = line.split(':');
        parsedTests.push({
          name: (name || 'test_case').trim(),
          status: 'failed',
          durationMs: Number((run.durationMs / Math.max(1, outLines.length)).toFixed(2)),
          errorType: 'AssertionError',
          errorMessage: rest.join(':').trim() || 'Assertion failed',
          traceback: run.stderr.trim() || line,
        });
      } else if (/^FAIL\b/.test(line)) {
        parsedTests.push({
          name: 'c_test_case',
          status: 'failed',
          durationMs: Number((run.durationMs / Math.max(1, outLines.length)).toFixed(2)),
          errorType: 'AssertionError',
          errorMessage: line,
          traceback: run.stderr.trim() || line,
        });
      }
    }

    if (run.code !== 0) {
      const crashedSignal =
        run.stderr.includes('Floating point') || run.code === 136
          ? 'ZeroDivisionError'
          : run.stderr.includes('Segmentation') || run.code === 139
          ? 'SegmentationFault'
          : 'AssertionError';
      if (!parsedTests.some((t) => t.status === 'failed')) {
        parsedTests.push({
          name: 'binary_runtime_check',
          status: 'failed',
          durationMs: run.durationMs,
          errorType: crashedSignal,
          errorMessage: run.stderr.trim() || `Process exited with code ${run.code}`,
          traceback: run.stderr.trim() || `Exit code ${run.code} (${crashedSignal})`,
        });
      }
    } else if (parsedTests.filter((t) => t.status === 'passed').length === 0) {
      // STRICT C/C++ RULE: exiting 0 without printing an explicit PASS result does NOT count as passed!
      parsedTests.push({
        name: 'c_pass_assertion_protocol',
        status: 'failed',
        durationMs: run.durationMs,
        errorType: 'NoTestAssertions',
        errorMessage:
          'Binary exited 0 without printing any explicit PASS:<test_name> result. C/C++ tests must emit PASS output to be verified.',
        traceback:
          'NoTestAssertions: Exiting with status 0 alone does not prove test assertions ran. Print "PASS:<test_name>" per verified assertion.',
      });
    }

    const passed = parsedTests.filter((t) => t.status === 'passed').length;
    const failed = parsedTests.filter((t) => t.status === 'failed').length;
    const firstFail = parsedTests.find((t) => t.status === 'failed');

    return {
      timedOut: false,
      importError: false,
      passed,
      failed,
      total: parsedTests.length,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      errorType: firstFail?.errorType ?? null,
      errorMessage: firstFail?.errorMessage ?? null,
      errorLine: firstFail?.errorLine ?? null,
      traceback: firstFail?.traceback ?? null,
      executionKind: 'dynamic-sandbox',
      tests: parsedTests,
    };
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Isolated Bash syntax + execution sandbox.
 */
async function runBashSandbox(
  sourceCode: string,
  testCode: string,
  filename: string,
  testFilename: string,
  timeoutSec: number
): Promise<TestRunResult> {
  const tmpdir = await createSandboxTempDir('autopatch_sh_');
  try {
    const safeSrc = sanitizeFileBase(filename, 'script.sh');
    const safeTest = sanitizeFileBase(testFilename, 'test_script.sh');
    const srcPath = await writeSandboxFile(tmpdir, safeSrc, sourceCode);
    const testPath = await writeSandboxFile(tmpdir, safeTest, testCode);

    const check = await runInIsolatedSandbox('bash', ['-n', srcPath], {
      cwd: tmpdir,
      timeoutMs: 2000,
      mode: 'run',
    });
    if (check.executionUnavailable) {
      return makeExecutionUnavailableRun(
        check.unavailableReason || check.stderr,
        check.durationMs
      );
    }

    if (check.code !== 0) {
      const m = check.stderr.match(/line (\d+)/);
      const line = m ? Number(m[1]) : 1;
      return {
        timedOut: false,
        importError: true,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: check.durationMs,
        errorType: 'SyntaxError',
        errorMessage: check.stderr.trim(),
        errorLine: line,
        traceback: check.stderr.trim(),
        executionKind: 'dynamic-sandbox',
        tests: [
          {
            name: 'bash_syntax_check',
            status: 'failed',
            durationMs: check.durationMs,
            errorType: 'SyntaxError',
            errorMessage: check.stderr.trim(),
            errorLine: line,
            traceback: check.stderr.trim(),
          },
        ],
      };
    }

    const run = await runInIsolatedSandbox('bash', [testPath], {
      cwd: tmpdir,
      timeoutMs: Math.round(timeoutSec * 1000),
      mode: 'run',
    });

    if (run.executionUnavailable) {
      return makeExecutionUnavailableRun(
        run.unavailableReason || run.stderr,
        run.durationMs
      );
    }

    if (run.timedOut) {
      return {
        timedOut: true,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'TimeoutError',
        errorMessage: `Isolated Bash sandbox exceeded ${timeoutSec.toFixed(1)}s timeout.`,
        errorLine: null,
        traceback: `SandboxTimeoutError: bash process tree terminated after ${timeoutSec.toFixed(1)}s.`,
        executionKind: 'dynamic-sandbox',
        outputTruncated: run.outputTruncated,
        tests: [
          {
            name: 'bash_execution_budget',
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'TimeoutError',
            errorMessage: 'Timeout',
          },
        ],
      };
    }

    if (run.outputTruncated) {
      return {
        timedOut: false,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'OutputLimitExceeded',
        errorMessage: 'Bash script exceeded sandbox stdout/stderr byte limit.',
        errorLine: null,
        traceback: 'OutputLimitExceeded: Process output exceeded sandbox buffer cap.',
        executionKind: 'dynamic-sandbox',
        outputTruncated: true,
        tests: [
          {
            name: 'bash_output_budget',
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'OutputLimitExceeded',
            errorMessage: 'Exceeded sandbox output cap.',
          },
        ],
      };
    }

    // Check that the bash test script actually contains executable non-comment commands
    const meaningfulLines = testCode
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (meaningfulLines.length === 0) {
      return {
        timedOut: false,
        importError: false,
        passed: 0,
        failed: 1,
        total: 1,
        durationMs: run.durationMs,
        errorType: 'NoTestsExecuted',
        errorMessage: 'Bash test script contains no executable assertions.',
        errorLine: null,
        traceback: 'NoTestsExecuted: Provide runnable bash test assertions.',
        executionKind: 'dynamic-sandbox',
        tests: [
          {
            name: safeTest,
            status: 'failed',
            durationMs: run.durationMs,
            errorType: 'NoTestsExecuted',
            errorMessage: 'No executable assertions in test script.',
          },
        ],
      };
    }

    const ok = run.code === 0;
    return {
      timedOut: false,
      importError: false,
      passed: ok ? 1 : 0,
      failed: ok ? 0 : 1,
      total: 1,
      durationMs: run.durationMs,
      errorType: ok ? null : 'AssertionError',
      errorMessage: ok ? null : run.stderr.trim() || run.stdout.trim() || `Exit code ${run.code}`,
      errorLine: null,
      traceback: ok ? null : run.stderr.trim() || run.stdout.trim(),
      executionKind: 'dynamic-sandbox',
      tests: [
        {
          name: safeTest,
          status: ok ? 'passed' : 'failed',
          durationMs: run.durationMs,
          errorType: ok ? undefined : 'AssertionError',
          errorMessage: ok ? undefined : run.stderr.trim() || `Exit code ${run.code}`,
          traceback: ok ? undefined : run.stderr.trim() || run.stdout.trim(),
        },
      ],
    };
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Honest Static-Only Report for languages without a local compiler/runtime
 * (Java, Go, Rust, C#, PHP, Ruby, SQL, Generic) OR when no executable test suite was provided.
 * Clearly marks `executionKind: 'static-only'` so downstream trust-gate & confidence
 * NEVER falsely report runtime verification.
 */
function buildStaticOnlyCheckRun(astReport: AstReport, language: SupportedLanguage): TestRunResult {
  const errors = astReport.findings.filter((f) => f.severity === 'error');
  const checks: TestCaseResult[] = [
    {
      name: `${language}_static_syntax_check`,
      status: astReport.syntaxValid ? 'passed' : 'failed',
      durationMs: Number((astReport.durationMs * 0.4).toFixed(2)),
      errorType: astReport.syntaxValid ? undefined : 'SyntaxError',
      errorMessage: astReport.syntaxValid ? undefined : astReport.findings[0]?.message,
      errorLine: astReport.syntaxValid ? undefined : astReport.findings[0]?.line,
    },
    {
      name: `${language}_static_bounds_and_zero_div_heuristic`,
      status: errors.some((e) => e.kind === 'IndexBoundaryRisk' || e.kind === 'ZeroDivisionRisk')
        ? 'failed'
        : 'passed',
      durationMs: Number((astReport.durationMs * 0.3).toFixed(2)),
      errorType: errors.find((e) => e.kind === 'IndexBoundaryRisk' || e.kind === 'ZeroDivisionRisk')?.kind,
      errorMessage: errors.find((e) => e.kind === 'IndexBoundaryRisk' || e.kind === 'ZeroDivisionRisk')?.message,
      errorLine: errors.find((e) => e.kind === 'IndexBoundaryRisk' || e.kind === 'ZeroDivisionRisk')?.line,
    },
    {
      name: `${language}_static_security_and_cfg_heuristic`,
      status: errors.some(
        (e) =>
          e.kind === 'TaintInjectionRisk' ||
          e.kind === 'SqlInjectionRisk' ||
          e.kind === 'BufferOverflowRisk' ||
          e.kind === 'InfiniteLoopRisk'
      )
        ? 'failed'
        : 'passed',
      durationMs: Number((astReport.durationMs * 0.3).toFixed(2)),
      errorType: errors.find(
        (e) =>
          e.kind === 'TaintInjectionRisk' ||
          e.kind === 'SqlInjectionRisk' ||
          e.kind === 'BufferOverflowRisk' ||
          e.kind === 'InfiniteLoopRisk'
      )?.kind,
      errorMessage: errors.find(
        (e) =>
          e.kind === 'TaintInjectionRisk' ||
          e.kind === 'SqlInjectionRisk' ||
          e.kind === 'BufferOverflowRisk' ||
          e.kind === 'InfiniteLoopRisk'
      )?.message,
      errorLine: errors.find(
        (e) =>
          e.kind === 'TaintInjectionRisk' ||
          e.kind === 'SqlInjectionRisk' ||
          e.kind === 'BufferOverflowRisk' ||
          e.kind === 'InfiniteLoopRisk'
      )?.line,
    },
  ];

  const passed = checks.filter((c) => c.status === 'passed').length;
  const failed = checks.filter((c) => c.status === 'failed').length;
  const firstFail = checks.find((c) => c.status === 'failed');

  return {
    timedOut: false,
    importError: !astReport.syntaxValid,
    passed,
    failed,
    total: checks.length,
    durationMs: astReport.durationMs,
    errorType: firstFail?.errorType ?? null,
    errorMessage: firstFail?.errorMessage ?? null,
    errorLine: firstFail?.errorLine ?? null,
    traceback: firstFail ? `${firstFail.errorType}: ${firstFail.errorMessage}` : null,
    executionKind: 'static-only',
    tests: checks,
  };
}

function buildSbflFromRun(sourceCode: string, baseline: TestRunResult): SbflSpectrum {
  const lines = sourceCode.split('\n');
  const tests = baseline.tests;
  const totalFailed = tests.filter((t) => t.status === 'failed').length;
  const totalPassed = tests.filter((t) => t.status === 'passed').length;

  if (baseline.executionKind !== 'dynamic-sandbox') {
    return {
      totalPassed,
      totalFailed,
      tests: tests.map((t) => ({ name: t.name, status: t.status })),
      rankings: [],
      coverageStatus: 'unavailable',
      coverageNote:
        baseline.executionKind === 'execution-unavailable'
          ? 'Dynamic coverage unavailable because isolated sandbox execution is disabled or unavailable.'
          : 'Dynamic line coverage unavailable for static-only analysis (no runtime tests executed).',
    };
  }

  const covered = new Set<number>();
  for (const t of tests) {
    for (const ln of t.executedLines ?? []) {
      if (ln >= 1 && ln <= lines.length) covered.add(ln);
    }
  }

  if (covered.size === 0) {
    return {
      totalPassed,
      totalFailed,
      tests: tests.map((t) => ({ name: t.name, status: t.status })),
      rankings: [],
      coverageStatus: tests.length > 0 ? 'empty' : 'unavailable',
      coverageNote:
        tests.length > 0
          ? 'No per-line runtime coverage probes were recorded for this runtime (e.g., native C/C++ or Bash binary execution).'
          : 'No dynamic tests executed; SBFL rankings unavailable.',
    };
  }

  const rankings: SbflLineRanking[] = Array.from(covered)
    .sort((a, b) => a - b)
    .map((ln) => {
      let failedCovering = 0;
      let passedCovering = 0;
      const testHits = tests.map((t) => {
        const hit = (t.executedLines ?? []).includes(ln);
        if (hit) {
          if (t.status === 'failed') failedCovering++;
          else passedCovering++;
        }
        return hit;
      });
      return {
        line: ln,
        code: lines[ln - 1] ?? '',
        failedCovering,
        passedCovering,
        ochiai: computeOchiai(failedCovering, passedCovering, totalFailed),
        tarantula: computeTarantula(failedCovering, passedCovering, totalFailed, totalPassed),
        testHits,
      };
    })
    .sort((a, b) => b.ochiai - a.ochiai || b.tarantula - a.tarantula || a.line - b.line);

  const coverageStatus: CoverageStatus = 'collected';
  return {
    totalPassed,
    totalFailed,
    tests: tests.map((t) => ({ name: t.name, status: t.status })),
    rankings,
    coverageStatus,
    coverageNote: `Collected genuine per-test statement coverage across ${rankings.length} executed line(s).`,
  };
}

function makeZeroGuard(language: SupportedLanguage, indent: string, denom: string): string[] {
  if (language === 'go') {
    return [`${indent}if ${denom} == 0 {`, `${indent}    return 0`, `${indent}}`];
  }
  if (language === 'rust') {
    return [`${indent}if ${denom} == 0 {`, `${indent}    return 0.0;`, `${indent}}`];
  }
  if (language === 'ruby') {
    return [`${indent}return 0.0 if ${denom} == 0`];
  }
  if (language === 'bash') {
    return [`${indent}if [ "$${denom}" -eq 0 ]; then echo 0; return 0; fi`];
  }
  if (language === 'c' || language === 'cpp') {
    return [`${indent}if (${denom} == 0) {`, `${indent}    return 0.0;`, `${indent}}`];
  }
  if (language === 'java' || language === 'csharp') {
    return [`${indent}if (${denom} == 0) {`, `${indent}    return 0.0;`, `${indent}}`];
  }
  return [`${indent}if (${denom} === 0) {`, `${indent}  return 0;`, `${indent}}`];
}

/**
 * Multi-language Patch Generator (Template-Based APR + SBFL-guided Search-Based Mutation APR for JS/TS).
 * Re-verifies candidate syntax before returning any patch; discards syntax-breaking patches cleanly.
 */
async function generateMultiLangPatch(params: {
  sourceCode: string;
  testCode: string;
  filename: string;
  testFilename: string;
  language: SupportedLanguage;
  astReport: AstReport;
  baseline: TestRunResult;
  sbfl: SbflSpectrum;
  timeoutSec: number;
}): Promise<{ patchInfo: PatchInfo; precomputedSandbox?: TestRunResult }> {
  const t0 = performance.now();
  const { sourceCode, testCode, filename, testFilename, language, astReport, baseline, sbfl, timeoutSec } = params;
  const lines = sourceCode.split('\n');
  const findings = astReport.findings;

  const hasBlockingError =
    baseline.failed > 0 ||
    baseline.timedOut ||
    findings.some((f) => f.severity === 'error');

  if (!hasBlockingError) {
    return {
      patchInfo: {
        patchedCode: sourceCode,
        patchApplied: false,
        aprStrategy: 'None Required',
        ruleId: 'NO_DEFECT_DETECTED',
        strategy: 'No blocking static defects or test failures detected.',
        targetLine: null,
        bugType: 'None',
        rootCause: 'No blocking syntax, security, or runtime defects detected.',
        requiresHumanReview: false,
        evaluatedMutants: [],
        durationMs: Number((performance.now() - t0).toFixed(2)),
      },
    };
  }

  // 1. Infinite Loop / Timeout -> Trust Gate blocks unsafe auto-rewrite
  if (baseline.timedOut || findings.some((f) => f.kind === 'InfiniteLoopRisk')) {
    const loopFinding = findings.find((f) => f.kind === 'InfiniteLoopRisk');
    const targetLine = loopFinding?.line ?? 1;
    return {
      patchInfo: {
        patchedCode: sourceCode,
        patchApplied: false,
        aprStrategy: 'Trust Gate — Human Review Required',
        ruleId: 'TRUST_GATE_HUMAN_REVIEW',
        strategy:
          'Detected unbounded loop / timeout. Original source preserved unmodified until developer specifies loop exit policy.',
        targetLine,
        bugType: 'InfiniteLoopTimeout',
        rootCause: `Execution timed out or static analysis identified an unbounded loop at line ${targetLine}.`,
        requiresHumanReview: true,
        evaluatedMutants: [],
        durationMs: Number((performance.now() - t0).toFixed(2)),
      },
    };
  }

  // 2. Apply deterministic template repairs
  const repaired = [...lines];
  const appliedNotes: string[] = [];
  let primaryBugType = baseline.errorType || findings[0]?.kind || 'Defect';
  let primaryRuleId = 'MULTI_LANG_TEMPLATE_REPAIR';
  let primaryTargetLine: number | null = baseline.errorLine ?? findings[0]?.line ?? null;
  let lineOffset = 0;

  // 2a. Missing semicolon in C / C++
  if (
    baseline.errorType === 'CompileError' &&
    baseline.errorMessage &&
    /expected ['"];['"]/.test(baseline.errorMessage) &&
    baseline.errorLine
  ) {
    const idx = Math.max(0, Math.min(repaired.length - 1, baseline.errorLine - 2));
    if (repaired[idx] && !repaired[idx].trimEnd().endsWith(';')) {
      repaired[idx] = repaired[idx].trimEnd() + ';';
      appliedNotes.push(`Inserted missing semicolon ';' on line ${idx + 1}.`);
      primaryBugType = 'SyntaxError';
      primaryRuleId = 'AST_SYNTAX_SEMICOLON';
      primaryTargetLine = idx + 1;
    }
  }

  // 2b. IndexBoundaryRisk: <= len -> < len or 0..=len() -> 0..len()
  for (const f of findings.filter((x) => x.kind === 'IndexBoundaryRisk')) {
    const idx = f.line - 1 + lineOffset;
    if (idx >= 0 && idx < repaired.length) {
      if (repaired[idx].includes('<=')) {
        repaired[idx] = repaired[idx].replace('<=', '<');
        appliedNotes.push(`Tightened off-by-one loop condition '<=' to '<' on line ${f.line}.`);
        primaryBugType = 'IndexError';
        primaryRuleId = 'AST_INDEX_BOUNDARY_FIX';
        primaryTargetLine = f.line;
      } else if (repaired[idx].includes('0..=')) {
        repaired[idx] = repaired[idx].replace('0..=', '0..');
        appliedNotes.push(`Changed inclusive range '0..=' to exclusive '0..' on line ${f.line}.`);
        primaryBugType = 'IndexError';
        primaryRuleId = 'AST_INDEX_BOUNDARY_FIX';
        primaryTargetLine = f.line;
      }
    }
  }

  // 2c. ZeroDivisionRisk
  for (const f of findings.filter((x) => x.kind === 'ZeroDivisionRisk')) {
    const idx = f.line - 1 + lineOffset;
    if (idx >= 0 && idx < repaired.length && f.denominator) {
      const indent = repaired[idx].match(/^\s*/)?.[0] ?? '';
      const guardLines = makeZeroGuard(language, indent, f.denominator);
      repaired.splice(idx, 0, ...guardLines);
      lineOffset += guardLines.length;
      appliedNotes.push(`Inserted zero-denominator guard for '${f.denominator}' before line ${f.line}.`);
      primaryBugType = 'ZeroDivisionError';
      primaryRuleId = 'AST_ZERO_DIV_GUARD';
      primaryTargetLine = f.line;
    }
  }

  // 2d. TaintInjectionRisk (eval -> JSON.parse in JS/TS)
  for (const f of findings.filter((x) => x.kind === 'TaintInjectionRisk' && x.sink === 'eval')) {
    const idx = f.line - 1 + lineOffset;
    if (idx >= 0 && idx < repaired.length && (language === 'javascript' || language === 'typescript')) {
      repaired[idx] = repaired[idx].replace(/\beval\s*\(/, 'JSON.parse(');
      appliedNotes.push(`Replaced unsafe 'eval()' sink with 'JSON.parse()' on line ${f.line}.`);
      primaryBugType = 'TaintInjectionRisk';
      primaryRuleId = 'AST_TAINT_SAFE_PARSE';
      primaryTargetLine = f.line;
    }
  }

  // 2e. SqlInjectionRisk -> parameterized placeholder
  for (const f of findings.filter((x) => x.kind === 'SqlInjectionRisk')) {
    const idx = f.line - 1 + lineOffset;
    if (idx >= 0 && idx < repaired.length) {
      const orig = repaired[idx];
      const parameterized = orig
        .replace(/"\s*\+\s*[A-Za-z_]\w*(?:\s*\+\s*"'?")?/g, '?"')
        .replace(/'\$\{[^}]+\}'/g, '?')
        .replace(/\$\{[^}]+\}/g, '?');
      if (parameterized !== orig) {
        repaired[idx] = parameterized;
        appliedNotes.push(
          `Replaced string-interpolated SQL query with parameterized '?' placeholder on line ${f.line}.`
        );
        primaryBugType = 'SqlInjectionRisk';
        primaryRuleId = 'AST_TAINT_SQL_PARAMETERIZE';
        primaryTargetLine = f.line;
      }
    }
  }

  // 2f. NullDereferenceRisk
  for (const f of findings.filter((x) => x.kind === 'NullDereferenceRisk')) {
    const idx = f.line - 1 + lineOffset;
    const varName = f.variable || 'item';
    if (idx >= 0 && idx < repaired.length) {
      const orig = repaired[idx];
      const nullCheck = language === 'ruby' ? `${varName}` : `${varName} != null`;
      const updated = orig.replace(
        new RegExp(`^(\\s*if\\s*\\()\\s*(${escapeRegex(varName)}\\b)`),
        `$1${nullCheck} && $2`
      );
      if (updated !== orig) {
        repaired[idx] = updated;
        appliedNotes.push(`Inserted null-safety guard '${nullCheck} && ...' on line ${f.line}.`);
        primaryBugType = 'NullDereferenceError';
        primaryRuleId = 'AST_NULL_DEREF_GUARD';
        primaryTargetLine = f.line;
      }
    }
  }

  // 2g. Remove DeadCodeRisk
  for (const f of findings.filter((x) => x.kind === 'DeadCodeRisk')) {
    const idx = f.line - 1 + lineOffset;
    if (idx >= 0 && idx < repaired.length) {
      repaired.splice(idx, 1);
      lineOffset -= 1;
      appliedNotes.push(`Removed unreachable dead code at line ${f.line}.`);
    }
  }

  if (appliedNotes.length > 0) {
    const candidateCode = repaired.join('\n');
    // Re-validate candidate syntax before proposing!
    const postCheck = await analyzeStaticMultiLang(candidateCode, filename, language);
    if (postCheck.syntaxValid) {
      return {
        patchInfo: {
          patchedCode: candidateCode,
          patchApplied: candidateCode !== sourceCode,
          aprStrategy: `Template-Based APR (${getLanguageMeta(language).label})`,
          ruleId: primaryRuleId,
          strategy: appliedNotes.join(' '),
          targetLine: primaryTargetLine,
          bugType: primaryBugType,
          rootCause:
            findings[0]?.message ||
            baseline.errorMessage ||
            `Detected ${primaryBugType} on line ${primaryTargetLine ?? 1}.`,
          requiresHumanReview: false,
          evaluatedMutants: [],
          durationMs: Number((performance.now() - t0).toFixed(2)),
        },
      };
    }
  }

  // 3. SBFL-guided Search-Based Mutation APR for JS / TS runtime AssertionErrors
  if (
    (language === 'javascript' || language === 'typescript') &&
    baseline.executionKind === 'dynamic-sandbox' &&
    baseline.failed > 0 &&
    testCode.trim().length > 0
  ) {
    const mutationOps: Array<[RegExp, string, string]> = [
      [/(?<!>)>(?!=)/, '>=', "Relational operator '>' -> '>='"],
      [/(?<!<)<(?!=)/, '<=', "Relational operator '<' -> '<='"],
      [/>=/, '>', "Relational operator '>=' -> '>'"],
      [/<=/, '<', "Relational operator '<=' -> '<'"],
      [/\s\+\s/, ' - ', "Arithmetic operator '+' -> '-'"],
      [/\s-\s/, ' + ', "Arithmetic operator '-' -> '+'"],
    ];
    const evaluatedMutants: AprMutantEvaluation[] = [];

    // Order candidate lines by real SBFL Ochiai ranking when available; otherwise scan executable lines
    const candidateIndices: Array<{ idx: number; ochiai: number }> =
      sbfl.rankings.length > 0
        ? sbfl.rankings
            .filter((r) => r.ochiai > 0 && r.line >= 1 && r.line <= lines.length)
            .slice(0, 6)
            .map((r) => ({ idx: r.line - 1, ochiai: r.ochiai }))
        : lines.map((_, idx) => ({ idx, ochiai: 0 }));

    for (const { idx, ochiai } of candidateIndices) {
      if (evaluatedMutants.length >= 6) break;
      const ln = lines[idx];
      if (!ln || !ln.trim() || /^\s*(\/\/|import|export|function|interface|type)/.test(ln)) continue;
      for (const [rx, rep, desc] of mutationOps) {
        if (evaluatedMutants.length >= 6) break;
        if (!rx.test(ln)) continue;
        const mutatedLine = ln.replace(rx, rep);
        if (mutatedLine === ln) continue;
        const candidateLines = [...lines];
        candidateLines[idx] = mutatedLine;
        const candidateCode = candidateLines.join('\n');

        // Verify candidate parses cleanly before executing
        const synCheck = await analyzeJsTsAst(candidateCode, filename, language);
        if (!synCheck.syntaxValid) continue;

        const sandboxRes = await runJsTsSandbox(
          candidateCode,
          testCode,
          filename,
          testFilename,
          language,
          Math.min(timeoutSec, 1.5)
        );
        if (sandboxRes.executionKind === 'execution-unavailable') break;

        const fitness = Number((sandboxRes.passed / Math.max(1, sandboxRes.total)).toFixed(3));
        const mutant: AprMutantEvaluation = {
          line: idx + 1,
          ochiai,
          operator: desc,
          originalLine: ln.trim(),
          mutatedLine: mutatedLine.trim(),
          passed: sandboxRes.passed,
          total: sandboxRes.total,
          fitness,
          selected: false,
        };
        evaluatedMutants.push(mutant);
        if (!sandboxRes.timedOut && !sandboxRes.importError && sandboxRes.failed === 0 && sandboxRes.passed > 0) {
          mutant.selected = true;
          return {
            patchInfo: {
              patchedCode: candidateCode,
              patchApplied: true,
              aprStrategy: `Search-Based APR (${getLanguageMeta(language).label} Mutation)`,
              ruleId: 'SBFL_MUTATION_OPERATOR_FIX',
              strategy: `Evaluated ${evaluatedMutants.length} mutant(s) and selected ${desc} on line ${idx + 1}, achieving 100% sandbox fitness (${sandboxRes.passed}/${sandboxRes.total}).`,
              targetLine: idx + 1,
              bugType: 'LogicBoundaryError',
              rootCause: `Runtime test assertion failed. Search-based mutation localized line ${idx + 1} ('${ln.trim()}').`,
              requiresHumanReview: false,
              evaluatedMutants,
              durationMs: Number((performance.now() - t0).toFixed(2)),
            },
            precomputedSandbox: sandboxRes,
          };
        }
      }
    }
  }

  return {
    patchInfo: {
      patchedCode: sourceCode,
      patchApplied: false,
      aprStrategy: 'Trust Gate — Human Review Required',
      ruleId: 'TRUST_GATE_NO_DETERMINISTIC_RULE',
      strategy:
        'No safe deterministic repair rule resolved this failure. Original source preserved unmodified; edit the candidate patch manually and re-run verification.',
      targetLine: baseline.errorLine,
      bugType: baseline.errorType || 'RuntimeError',
      rootCause: baseline.errorMessage || 'Manual developer inspection required.',
      requiresHumanReview: true,
      evaluatedMutants: [],
      durationMs: Number((performance.now() - t0).toFixed(2)),
    },
  };
}

/**
 * Honest, auditable confidence scoring:
 * - Dynamic sandbox points (40) & zero-regression points (15) are ONLY awarded when
 *   real executable tests actually ran in the isolated sandbox (`verificationMode === 'dynamic-sandbox'`).
 * - Static-only checks, unavailable sandboxes, compile-only passes, or empty test suites
 *   NEVER receive dynamic verification points!
 */
function computeConfidenceMultiLang(params: {
  astReport: AstReport;
  patchedAst: AstReport;
  baseline: TestRunResult;
  patchInfo: PatchInfo;
  sandbox: TestRunResult;
  diff: DiffData;
  verificationMode: VerificationMode;
}): ConfidenceBreakdown {
  const { astReport, patchedAst, baseline, patchInfo, sandbox, diff, verificationMode } = params;
  const factors = [];
  let score = 0;

  // 1. Fault Localization Evidence (max 25)
  const isGenuineParser =
    astReport.analysisKind === 'ast-parser' || astReport.analysisKind === 'compiler-diagnostics';
  if (astReport.findings.length > 0 || (patchInfo.evaluatedMutants?.length ?? 0) > 0) {
    const pts = isGenuineParser ? 25 : 15;
    score += pts;
    factors.push({
      label: isGenuineParser ? 'AST / Compiler Localization' : 'Heuristic Static Localization',
      points: pts,
      maxPoints: 25,
      detail: isGenuineParser
        ? `Defect localized via ${astReport.parserTool || 'parser'} or dynamic mutation`
        : 'Defect localized via comment-stripped static heuristics (no native compiler)',
    });
  } else {
    factors.push({
      label: 'Static / SBFL Localization',
      points: 0,
      maxPoints: 25,
      detail: 'No deterministic defect localization match',
    });
  }

  // 2. Minimal Surgical Diff + Syntax Soundness (max 20)
  const delta = diff.linesAdded + diff.linesRemoved;
  if (patchInfo.patchApplied && patchedAst.syntaxValid && delta >= 1 && delta <= 8) {
    const pts = isGenuineParser ? 20 : 12;
    score += pts;
    factors.push({
      label: 'Minimal Surgical Diff',
      points: pts,
      maxPoints: 20,
      detail: isGenuineParser
        ? `${delta} line(s) changed; syntax verified by ${patchedAst.parserTool || 'parser'}`
        : `${delta} line(s) changed; heuristic balance check only (not compiled)`,
    });
  } else if (patchInfo.patchApplied && patchedAst.syntaxValid) {
    score += 10;
    factors.push({
      label: 'Minimal Surgical Diff',
      points: 10,
      maxPoints: 20,
      detail: `${delta} lines changed`,
    });
  } else {
    factors.push({
      label: 'Minimal Surgical Diff',
      points: 0,
      maxPoints: 20,
      detail: patchInfo.patchApplied ? 'Candidate patch failed syntax validation' : 'No automatic rewrite applied',
    });
  }

  // 3. Dynamic Sandbox Verification (max 40) — STRICTLY ZERO unless dynamic tests actually ran & passed
  if (
    verificationMode === 'dynamic-sandbox' &&
    !sandbox.timedOut &&
    !sandbox.importError &&
    sandbox.total > 0 &&
    sandbox.failed === 0 &&
    sandbox.passed > 0
  ) {
    score += 40;
    factors.push({
      label: 'Dynamic Sandbox Verification',
      points: 40,
      maxPoints: 40,
      detail: `${sandbox.passed}/${sandbox.total} real unit test(s) passed in isolated sandbox`,
    });
  } else if (verificationMode === 'static-only') {
    factors.push({
      label: 'Dynamic Sandbox Verification',
      points: 0,
      maxPoints: 40,
      detail: 'Static checks only — no runtime tests were executed',
    });
  } else if (verificationMode === 'execution-unavailable') {
    factors.push({
      label: 'Dynamic Sandbox Verification',
      points: 0,
      maxPoints: 40,
      detail: 'Isolated sandbox execution unavailable (fail-closed)',
    });
  } else {
    factors.push({
      label: 'Dynamic Sandbox Verification',
      points: 0,
      maxPoints: 40,
      detail: 'Dynamic tests failed, timed out, or produced no assertions',
    });
  }

  // 4. Zero Runtime Regressions vs Server Baseline (max 15)
  const noReg =
    verificationMode === 'dynamic-sandbox' &&
    !sandbox.timedOut &&
    !sandbox.importError &&
    sandbox.failed === 0 &&
    sandbox.passed > 0 &&
    sandbox.passed >= baseline.passed &&
    sandbox.total > 0;
  if (noReg) {
    score += 15;
    factors.push({
      label: 'Zero Runtime Regressions',
      points: 15,
      maxPoints: 15,
      detail: 'All baseline runtime tests remain green',
    });
  } else {
    factors.push({
      label: 'Zero Runtime Regressions',
      points: 0,
      maxPoints: 15,
      detail:
        verificationMode === 'dynamic-sandbox'
          ? 'Runtime regression or unresolved failure present'
          : 'Cannot verify runtime regressions without dynamic test execution',
    });
  }

  return { score: Math.min(100, Math.max(0, score)), factors };
}

function determineVerificationMode(params: {
  language: SupportedLanguage;
  hasExecutableTests: boolean;
  sandbox: TestRunResult;
}): VerificationMode {
  const { language, hasExecutableTests, sandbox } = params;
  if (sandbox.executionKind === 'execution-unavailable') {
    return 'execution-unavailable';
  }
  if (!EXECUTABLE_SANDBOX_LANGUAGES.has(language) || !hasExecutableTests) {
    return 'static-only';
  }
  if (sandbox.executionKind === 'dynamic-sandbox') {
    return 'dynamic-sandbox';
  }
  return 'static-only';
}

function buildRemainingUncertainty(params: {
  language: SupportedLanguage;
  verificationMode: VerificationMode;
  astReport: AstReport;
  testSynthesisStatus: TestSynthesisStatus;
  sandbox: TestRunResult;
}): string[] {
  const notes: string[] = [];
  if (params.verificationMode === 'static-only') {
    if (!EXECUTABLE_SANDBOX_LANGUAGES.has(params.language)) {
      notes.push(
        `No local ${getLanguageMeta(params.language).label} compiler/runtime is installed; analysis used ${params.astReport.parserTool || 'static heuristics'} only and did not execute code.`
      );
    } else {
      notes.push(
        'No runnable unit test suite was supplied; patch was checked statically only and requires developer-written tests before merge.'
      );
    }
  } else if (params.verificationMode === 'execution-unavailable') {
    notes.push(
      params.sandbox.errorMessage ||
        'Isolated sandbox execution is unavailable in this environment; dynamic verification was blocked.'
    );
  }
  if (params.testSynthesisStatus === 'unavailable-human-tests-required') {
    notes.push(
      'Automatic behavioral test synthesis is not available for this code without fabricating placeholder assertions; supply real unit tests.'
    );
  }
  if (params.sandbox.failed > 0 || params.sandbox.timedOut) {
    notes.push('One or more dynamic tests failed or timed out; human review required.');
  }
  return notes;
}

export async function runMultiLangAnalysis(req: MultiLangRequest): Promise<AnalysisResponse> {
  const filename = sanitizeFileBase(req.filename, 'module.txt');
  const testFilename = sanitizeFileBase(req.testFilename, `test_${filename}`);
  const language: SupportedLanguage = req.language || detectLanguageFromFilename(filename);
  const timeoutSec = Math.max(0.5, Math.min(30.0, req.timeoutSeconds ?? 5.0));
  const sandboxIsolation = getSandboxIsolationInfo();

  const isManualValidate = req.action === 'validate';
  const originalCode = isManualValidate ? req.originalCode || '' : req.sourceCode || '';
  const candidateInput = isManualValidate ? req.candidateCode || '' : originalCode;
  const testCode = req.testCode || '';
  const hasExecutableTests =
    EXECUTABLE_SANDBOX_LANGUAGES.has(language) && testCode.trim().length > 0;
  const testSynthesisStatus: TestSynthesisStatus = testCode.trim()
    ? 'user-provided'
    : 'unavailable-human-tests-required';

  const runRuntime = async (code: string, astRep: AstReport): Promise<TestRunResult> => {
    if (!hasExecutableTests) {
      return buildStaticOnlyCheckRun(astRep, language);
    }
    if (language === 'javascript' || language === 'typescript') {
      return runJsTsSandbox(code, testCode, filename, testFilename, language, timeoutSec);
    }
    if (language === 'c' || language === 'cpp') {
      return runCCppSandbox(code, testCode, filename, testFilename, language, timeoutSec);
    }
    if (language === 'bash') {
      return runBashSandbox(code, testCode, filename, testFilename, timeoutSec);
    }
    return buildStaticOnlyCheckRun(astRep, language);
  };

  if (isManualValidate) {
    const origAst = await analyzeStaticMultiLang(originalCode, filename, language);
    const candidateAst = await analyzeStaticMultiLang(candidateInput, filename, language);
    // NEVER trust client-supplied baseline; only reuse server-verified baseline if provided internally
    const baseline = req._trustedServerBaseline ?? (await runRuntime(originalCode, origAst));
    const sandbox = await runRuntime(candidateInput, candidateAst);
    const diff = computeTextDiff(originalCode, candidateInput, filename);
    const sbfl = buildSbflFromRun(originalCode, baseline);
    const verificationMode = determineVerificationMode({ language, hasExecutableTests, sandbox });

    const patchInfo: PatchInfo = {
      patchedCode: candidateInput,
      patchApplied: candidateInput !== originalCode,
      aprStrategy: `Developer Manual Patch (${getLanguageMeta(language).label})`,
      ruleId: 'DEVELOPER_MANUAL_PATCH',
      strategy:
        verificationMode === 'dynamic-sandbox'
          ? 'Developer-edited candidate patch re-verified in isolated sandbox.'
          : 'Developer-edited candidate patch checked statically only (no runtime tests executed).',
      targetLine: req.targetLine ?? null,
      bugType: req.bugType || baseline.errorType || 'ManualFix',
      rootCause: req.rootCause || 'Custom developer patch submitted for validation.',
      requiresHumanReview: verificationMode !== 'dynamic-sandbox',
      evaluatedMutants: [],
      durationMs: 0.5,
    };

    const trustVerdict: TrustVerdict =
      verificationMode === 'dynamic-sandbox' &&
      candidateAst.syntaxValid &&
      !sandbox.timedOut &&
      !sandbox.importError &&
      sandbox.total > 0 &&
      sandbox.passed > 0 &&
      sandbox.failed === 0 &&
      sandbox.passed >= baseline.passed
        ? 'verified'
        : 'blocked';

    const confidence = computeConfidenceMultiLang({
      astReport: candidateAst,
      patchedAst: candidateAst,
      baseline,
      patchInfo,
      sandbox,
      diff,
      verificationMode,
    });

    const remainingUncertainty = buildRemainingUncertainty({
      language,
      verificationMode,
      astReport: candidateAst,
      testSynthesisStatus,
      sandbox,
    });

    const verificationStatus: VerificationStatus =
      verificationMode === 'execution-unavailable'
        ? 'VERIFICATION_UNAVAILABLE'
        : trustVerdict === 'verified'
        ? 'RUNTIME_VERIFIED'
        : verificationMode === 'static-only'
        ? candidateAst.syntaxValid && !candidateAst.findings.some((f) => f.severity === 'error')
          ? 'STATIC_ANALYSIS_PASSED'
          : 'HUMAN_REVIEW_REQUIRED'
        : sandbox.failed > 0 || !candidateAst.syntaxValid
        ? 'FAILED'
        : 'HUMAN_REVIEW_REQUIRED';

    const originalSourceHash = crypto.createHash('sha256').update(originalCode, 'utf-8').digest('hex');

    return {
      filename,
      testFilename,
      language,
      originalCode,
      patchedCode: candidateInput,
      originalSourceHash,
      astReport: candidateAst,
      baseline,
      sbfl,
      patchInfo,
      sandbox,
      diff,
      confidence,
      trustVerdict,
      verificationMode,
      verificationStatus,
      analysisKind: candidateAst.analysisKind,
      testSynthesisStatus,
      sandboxIsolation,
      remainingUncertainty,
      auditStorageMode: 'backend-append-only',
    };
  }

  // Standard `analyze` workflow
  const astReport = await analyzeStaticMultiLang(originalCode, filename, language);
  const baseline = await runRuntime(originalCode, astReport);
  const sbfl = buildSbflFromRun(originalCode, baseline);

  const { patchInfo, precomputedSandbox } = await generateMultiLangPatch({
    sourceCode: originalCode,
    testCode,
    filename,
    testFilename,
    language,
    astReport,
    baseline,
    sbfl,
    timeoutSec,
  });

  const patchedCode = patchInfo.patchedCode;
  const diff = computeTextDiff(originalCode, patchedCode, filename);
  const patchedAst = patchInfo.patchApplied
    ? await analyzeStaticMultiLang(patchedCode, filename, language)
    : astReport;

  let sandbox: TestRunResult;
  if (precomputedSandbox) {
    sandbox = precomputedSandbox;
  } else if (patchInfo.patchApplied) {
    sandbox = await runRuntime(patchedCode, patchedAst);
  } else {
    sandbox = { ...baseline };
  }

  const verificationMode = determineVerificationMode({ language, hasExecutableTests, sandbox });
  const hasBlockingStatic = astReport.findings.some((f) => f.severity === 'error');

  let trustVerdict: TrustVerdict = 'blocked';
  if (
    verificationMode === 'dynamic-sandbox' &&
    baseline.failed === 0 &&
    baseline.passed > 0 &&
    !baseline.timedOut &&
    !baseline.importError &&
    !hasBlockingStatic &&
    !patchInfo.patchApplied
  ) {
    trustVerdict = 'already_passing';
  } else if (
    verificationMode === 'dynamic-sandbox' &&
    patchedAst.syntaxValid &&
    !sandbox.timedOut &&
    !sandbox.importError &&
    sandbox.total > 0 &&
    sandbox.passed > 0 &&
    sandbox.failed === 0 &&
    sandbox.passed >= baseline.passed &&
    !patchInfo.requiresHumanReview
  ) {
    trustVerdict = 'verified';
  } else {
    // Static-only checks, unavailable sandbox, compile-only passes, or empty/failing tests are NEVER `verified`!
    trustVerdict = 'blocked';
  }

  const confidence = computeConfidenceMultiLang({
    astReport,
    patchedAst,
    baseline,
    patchInfo,
    sandbox,
    diff,
    verificationMode,
  });

  const remainingUncertainty = buildRemainingUncertainty({
    language,
    verificationMode,
    astReport,
    testSynthesisStatus,
    sandbox,
  });

  const verificationStatus: VerificationStatus =
    verificationMode === 'execution-unavailable'
      ? 'VERIFICATION_UNAVAILABLE'
      : trustVerdict === 'verified' || trustVerdict === 'already_passing'
      ? 'RUNTIME_VERIFIED'
      : verificationMode === 'static-only'
      ? patchedAst.syntaxValid && !patchedAst.findings.some((f) => f.severity === 'error')
        ? 'STATIC_ANALYSIS_PASSED'
        : 'HUMAN_REVIEW_REQUIRED'
      : patchInfo.requiresHumanReview
      ? 'HUMAN_REVIEW_REQUIRED'
      : sandbox.failed > 0 || !patchedAst.syntaxValid
      ? 'FAILED'
      : 'HUMAN_REVIEW_REQUIRED';

  const originalSourceHash = crypto.createHash('sha256').update(originalCode, 'utf-8').digest('hex');

  return {
    filename,
    testFilename,
    language,
    originalCode,
    patchedCode,
    originalSourceHash,
    // Never generate placeholder `assert(true)` / empty test stubs
    generatedTestCode: undefined,
    astReport,
    baseline,
    sbfl,
    patchInfo,
    sandbox,
    diff,
    confidence,
    trustVerdict,
    verificationMode,
    verificationStatus,
    analysisKind: astReport.analysisKind,
    testSynthesisStatus,
    sandboxIsolation,
    remainingUncertainty,
    auditStorageMode: 'backend-append-only',
  };
}
