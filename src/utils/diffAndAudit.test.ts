import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  buildAuditEntry,
  evaluateTrustGate,
  filterAuditEntries,
  formatAuditTimestamp,
  formatStructuredMarkdownReport,
  serializeAuditToCsv,
} from './diffAndAudit';
import { classifySuspiciousness, computeOchiai, computeTarantula } from './sbfl';
import { detectLanguageFromFilename, getLanguageMeta, type SupportedLanguage } from './languageDetect';
import { DEMO_CASES } from '../data/demoCases';
import type { AnalysisResponse } from '../types/autopatch';
import { runMultiLangAnalysis } from '../../engine/multi_lang_engine';

const ENGINE_PATH = path.resolve(process.cwd(), 'engine', 'autopatch_engine.py');

function runPythonEngineSync(payload: Record<string, unknown>): AnalysisResponse {
  const stdout = execFileSync('python3', [ENGINE_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 12000,
  });
  return JSON.parse(stdout.trim()) as AnalysisResponse;
}

test('detectLanguageFromFilename accurately classifies all major languages and generic fallback', () => {
  assert.equal(detectLanguageFromFilename('pricing_engine.py'), 'python');
  assert.equal(detectLanguageFromFilename('cart_totals.ts'), 'typescript');
  assert.equal(detectLanguageFromFilename('widget.jsx'), 'javascript');
  assert.equal(detectLanguageFromFilename('telemetry_math.c'), 'c');
  assert.equal(detectLanguageFromFilename('solver.cpp'), 'cpp');
  assert.equal(detectLanguageFromFilename('OrderQuery.java'), 'java');
  assert.equal(detectLanguageFromFilename('server.go'), 'go');
  assert.equal(detectLanguageFromFilename('lib.rs'), 'rust');
  assert.equal(detectLanguageFromFilename('Billing.cs'), 'csharp');
  assert.equal(detectLanguageFromFilename('index.php'), 'php');
  assert.equal(detectLanguageFromFilename('worker.rb'), 'ruby');
  assert.equal(detectLanguageFromFilename('deploy.sh'), 'bash');
  assert.equal(detectLanguageFromFilename('schema.sql'), 'sql');
  assert.equal(detectLanguageFromFilename('main.kt'), 'generic');
  assert.equal(getLanguageMeta('c').executionMode, 'sandbox-runtime');
  assert.equal(getLanguageMeta('java').executionMode, 'static-verifier');
});

test('SBFL Ochiai and Tarantula formulas compute exact textbook values', () => {
  assert.equal(computeOchiai(1, 1, 1), 0.707);
  assert.equal(computeTarantula(1, 1, 1, 3), 0.75);
  assert.equal(computeOchiai(1, 0, 1), 1.0);
  assert.equal(computeTarantula(1, 0, 1, 3), 1.0);
  assert.equal(computeOchiai(0, 3, 1), 0);
  assert.equal(classifySuspiciousness(0.816), 'high');
  assert.equal(classifySuspiciousness(0.5), 'medium');
  assert.equal(classifySuspiciousness(0.2), 'low');
});

test('evaluateTrustGate permits direct accept only when sandbox is verified', () => {
  const verified = evaluateTrustGate({
    verdict: 'verified',
    overrideEnabled: false,
    overrideReason: '',
  });
  assert.equal(verified.canAcceptDirectly, true);
  assert.equal(verified.canAcceptNow, true);
  assert.equal(verified.requiresOverride, false);

  const blockedNoOverride = evaluateTrustGate({
    verdict: 'blocked',
    overrideEnabled: false,
    overrideReason: '',
  });
  assert.equal(blockedNoOverride.canAcceptDirectly, false);
  assert.equal(blockedNoOverride.canAcceptNow, false);
  assert.equal(blockedNoOverride.requiresOverride, true);

  const blockedShortReason = evaluateTrustGate({
    verdict: 'blocked',
    overrideEnabled: true,
    overrideReason: 'short',
  });
  assert.equal(blockedShortReason.canAcceptNow, false);

  const blockedValidOverride = evaluateTrustGate({
    verdict: 'blocked',
    overrideEnabled: true,
    overrideReason: 'Accepted for manual dead-letter refactor in follow-up commit.',
  });
  assert.equal(blockedValidOverride.canAcceptNow, true);
});

test('All 6 multi-language golden demos (Python, TypeScript, C, Java) pass end-to-end verification', async () => {
  for (const demo of DEMO_CASES) {
    const res =
      demo.language === 'python'
        ? runPythonEngineSync({
            action: 'analyze',
            filename: demo.filename,
            testFilename: demo.testFilename,
            sourceCode: demo.sourceCode,
            testCode: demo.testCode,
            timeoutSeconds: 1.5,
          })
        : await runMultiLangAnalysis({
            action: 'analyze',
            language: demo.language as SupportedLanguage,
            filename: demo.filename,
            testFilename: demo.testFilename,
            sourceCode: demo.sourceCode,
            testCode: demo.testCode,
            timeoutSeconds: 2.0,
          });

    if (demo.expectedOutcome === 'auto-verified' && demo.language !== 'java') {
      assert.equal(
        res.trustVerdict,
        'verified',
        `${demo.filename} (${demo.language}) should produce verified verdict, got ${res.trustVerdict} (${res.sandbox.errorMessage})`
      );
      assert.equal(res.verificationMode, 'dynamic-sandbox');
      assert.equal(res.sandbox.failed, 0, `${demo.filename} sandbox should have 0 failed checks`);
      assert.ok(res.sandbox.passed >= 3, `${demo.filename} should pass all checks`);
      assert.ok(res.confidence.score >= 85, `${demo.filename} confidence should be high`);
      assert.ok(res.diff.unified.includes('@@'), `${demo.filename} should include unified diff`);

      if (demo.id === 'auth-service-none-sub') {
        assert.ok(res.patchedCode.includes('if user is not None and user["password"] == password:'));
        assert.ok(res.patchedCode.includes('if username not in users_db:'));
      }

      if (demo.id === 'discount-sbfl-mutation') {
        assert.ok(res.sbfl && res.sbfl.rankings.length > 0, 'discount_rules.py should produce SBFL rankings');
        assert.equal(res.sbfl?.coverageStatus, 'collected');
        assert.ok(
          (res.patchInfo.evaluatedMutants?.length ?? 0) >= 1,
          'discount_rules.py should record Search-Based APR mutant evaluations'
        );
        assert.ok(res.patchedCode.includes('order_total >= 100'));
      }

      if (demo.id === 'ts-cart-index') {
        assert.ok(res.patchedCode.includes('i < items.length'));
        assert.equal(res.sbfl?.coverageStatus, 'collected');
        assert.ok((res.sbfl?.rankings.length ?? 0) >= 1, 'TS demo should collect real Acorn AST SBFL rankings');
      }

      if (demo.id === 'c-telemetry-div') {
        assert.ok(res.patchedCode.includes('if (count == 0)'));
      }
    } else if (demo.id === 'java-order-taint') {
      // Honest static-only verification: Java has no local javac/JUnit runtime in this container,
      // so the patch is generated accurately but trustVerdict MUST be 'blocked' (static-only), never 'verified'.
      assert.equal(res.verificationMode, 'static-only');
      assert.equal(res.analysisKind, 'heuristic');
      assert.equal(res.trustVerdict, 'blocked');
      assert.ok(res.confidence.score <= 45, 'Static-only Java confidence must not include dynamic sandbox points');
      assert.ok(res.patchedCode.includes('WHERE customer_id = ?'));
      assert.ok(res.patchedCode.includes('i < ids.length'));
      assert.ok(!res.patchedCode.includes('unreachableLog'));
    } else {
      assert.equal(
        res.trustVerdict,
        'blocked',
        `${demo.filename} should be blocked by Trust Layer`
      );
      assert.equal(res.baseline.timedOut, true, `${demo.filename} should hit sandbox timeout`);
      assert.equal(res.patchInfo.requiresHumanReview, true);
    }
  }
});

test('Universal multi-language engine patches Rust (static-only blocked) and Bash (sandbox verified) honestly', async () => {
  const rustRes = await runMultiLangAnalysis({
    action: 'analyze',
    language: 'rust',
    filename: 'metrics.rs',
    testFilename: 'metrics_test.rs',
    sourceCode: `pub fn sum_slice(vals: &[i32]) -> i32 {
    let mut acc = 0;
    for i in 0..=vals.len() {
        acc += vals[i];
    }
    acc
}
`,
    testCode: '',
  });
  assert.equal(rustRes.verificationMode, 'static-only');
  assert.equal(rustRes.analysisKind, 'heuristic');
  assert.equal(rustRes.trustVerdict, 'blocked');
  assert.equal(rustRes.generatedTestCode, undefined);
  assert.ok(rustRes.patchedCode.includes('0..vals.len()'));

  const bashRes = await runMultiLangAnalysis({
    action: 'analyze',
    language: 'bash',
    filename: 'avg.sh',
    testFilename: 'test_avg.sh',
    sourceCode: `#!/usr/bin/env bash
safe_ratio() {
  local total=$1
  local count=$2
  echo $(( total / count ))
}
`,
    testCode: `#!/usr/bin/env bash
set -euo pipefail
source ./avg.sh
out=$(safe_ratio 10 2)
test "$out" = "5"
zero_out=$(safe_ratio 10 0)
test "$zero_out" = "0"
`,
  });
  assert.equal(bashRes.verificationMode, 'dynamic-sandbox');
  assert.equal(bashRes.trustVerdict, 'verified');
  assert.equal(bashRes.sandbox.passed, 1);
});

test('Manual patch validation verifies developer fix for retry_worker.py', () => {
  const retryDemo = DEMO_CASES.find((d) => d.id === 'retry-loop-blocked')!;
  const fixedCode = `def drain_job_queue(jobs):
    """Process jobs until the queue empties. Drop malformed jobs without 'payload'."""
    queue = list(jobs)
    processed = []
    while queue:
        current = queue.pop(0)
        if "payload" not in current:
            continue
        processed.append(current["payload"])
    return processed
`;

  const res = runPythonEngineSync({
    action: 'validate',
    filename: retryDemo.filename,
    testFilename: retryDemo.testFilename,
    originalCode: retryDemo.sourceCode,
    candidateCode: fixedCode,
    testCode: retryDemo.testCode,
    timeoutSeconds: 1.5,
  });

  assert.equal(res.trustVerdict, 'verified');
  assert.equal(res.sandbox.passed, 2);
  assert.equal(res.sandbox.failed, 0);
  assert.equal(res.sandbox.timedOut, false);
});

test('Audit entry creation, filtering, CSV serialization, and 5-section Markdown report preserve fidelity', () => {
  const pricingDemo = DEMO_CASES.find((d) => d.id === 'pricing-zero-div')!;
  const analysis = runPythonEngineSync({
    action: 'analyze',
    filename: pricingDemo.filename,
    testFilename: pricingDemo.testFilename,
    sourceCode: pricingDemo.sourceCode,
    testCode: pricingDemo.testCode,
    timeoutSeconds: 1.5,
  });

  const acceptedEntry = buildAuditEntry({
    analysis,
    decision: 'accepted',
    now: new Date('2026-11-18T20:00:00.000Z'),
  });
  const rejectedEntry = buildAuditEntry({
    analysis: { ...analysis, filename: 'telemetry_math.c' },
    decision: 'rejected',
    now: new Date('2026-11-18T20:05:00.000Z'),
  });

  const all = [acceptedEntry, rejectedEntry];
  assert.equal(filterAuditEntries(all, 'all', '').length, 2);
  assert.equal(filterAuditEntries(all, 'accepted', '').length, 1);
  assert.equal(filterAuditEntries(all, 'all', 'telemetry').length, 1);
  assert.equal(filterAuditEntries(all, 'accepted', 'telemetry').length, 0);

  const csv = serializeAuditToCsv(all);
  assert.ok(csv.startsWith('ID,Timestamp,File,Line,Bug Type'));
  assert.ok(csv.includes('pricing_engine.py'));
  assert.ok(csv.includes('ZeroDivisionError'));
  assert.equal(formatAuditTimestamp('2026-11-18T20:00:00.000Z').length, 19);

  // Also verify traceback-only analysis (empty testCode + bugContext) auto-synthesizes tests and generates all 5 markdown headers
  const authDemo = DEMO_CASES.find((d) => d.id === 'auth-service-none-sub')!;
  const tracebackOnlyRes = runPythonEngineSync({
    action: 'analyze',
    filename: authDemo.filename,
    testFilename: authDemo.testFilename,
    sourceCode: authDemo.sourceCode,
    testCode: '',
    bugContext: authDemo.bugContext,
    timeoutSeconds: 1.5,
  });
  assert.equal(tracebackOnlyRes.trustVerdict, 'verified');
  assert.ok(tracebackOnlyRes.generatedTestCode?.includes('def test_authenticate_existing_and_missing_user'));

  const md = formatStructuredMarkdownReport(tracebackOnlyRes, '', 'accepted');
  assert.ok(md.includes('### 1. BUG SUMMARY & TRIAGE'));
  assert.ok(md.includes('### 2. ROOT-CAUSE ANALYSIS'));
  assert.ok(md.includes('### 3. MINIMAL SURGICAL PATCH (UNIFIED DIFF)'));
  assert.ok(md.includes('### 4. REGRESSION & EDGE-CASE TEST SUITE'));
  assert.ok(md.includes('### 5. AUDIT LOG ENTRY'));
});

test('Prism.js syntax highlighting tokenizes Python, TypeScript, C, Java, and Rust accurately', async () => {
  const { highlightCodeWithPrism, resolvePrismLanguage } = await import('./syntaxHighlight');

  assert.equal(resolvePrismLanguage('python', 'auth_service.py'), 'python');
  assert.equal(resolvePrismLanguage('generic', 'cart_totals.ts'), 'typescript');

  const pyHtml = highlightCodeWithPrism(
    'def authenticate_user(users_db, username):\n    # check None\n    return "SUCCESS"\n',
    'python',
    'auth_service.py'
  );
  assert.ok(pyHtml.includes('token keyword'));
  assert.ok(pyHtml.includes('token comment'));
  assert.ok(pyHtml.includes('token string'));
  assert.ok(pyHtml.endsWith('\n '), 'Trailing newline should append space for pre height sync');

  const tsHtml = highlightCodeWithPrism(
    'export function sum(items: number[]): number { return items.length; }',
    'typescript',
    'cart.ts'
  );
  assert.ok(tsHtml.includes('token keyword'));
  assert.ok(tsHtml.includes('token builtin'));

  const cHtml = highlightCodeWithPrism(
    '#include <stdio.h>\nint main(void) { return 0; }',
    'c',
    'main.c'
  );
  assert.ok(cHtml.includes('token directive') || cHtml.includes('token keyword'));
  assert.ok(cHtml.includes('token number'));
});

test('Unified findings builder, line fix application, severity sort, and voice notes audit integration work cleanly', async () => {
  const {
    buildUnifiedFindings,
    applyFindingFixToSource,
    sortFindingsBySeverity,
  } = await import('./unifiedFindings');
  const pricingDemo = DEMO_CASES.find((d) => d.id === 'pricing-zero-div')!;
  const analysis = runPythonEngineSync({
    action: 'analyze',
    filename: pricingDemo.filename,
    testFilename: pricingDemo.testFilename,
    sourceCode: pricingDemo.sourceCode,
    testCode: pricingDemo.testCode,
    timeoutSeconds: 1.5,
  });

  const findings = buildUnifiedFindings(analysis, []);
  assert.ok(findings.length >= 1, 'Should produce at least one unified finding');
  const fixable = findings.find((f) => f.canAutoFix && f.suggestedReplacement !== null);
  assert.ok(fixable, 'Should expose an auto-fixable finding');

  const patched = applyFindingFixToSource(pricingDemo.sourceCode, fixable!);
  assert.notEqual(patched, pricingDemo.sourceCode, 'Applying fix should update source');

  const sorted = sortFindingsBySeverity([
    { severity: 'info' as const, line: 1 },
    { severity: 'critical' as const, line: 8 },
    { severity: 'warning' as const, line: 3 },
    { severity: 'critical' as const, line: 2 },
  ]);
  assert.deepEqual(
    sorted.map((s) => `${s.severity}:${s.line}`),
    ['critical:2', 'critical:8', 'warning:3', 'info:1']
  );

  const mockVoiceNotes = [
    {
      id: 'vn-1',
      findingId: fixable!.id,
      filename: pricingDemo.filename,
      line: fixable!.line,
      bugTitle: fixable!.title,
      createdAt: '2026-11-19T01:00:00.000Z',
      durationSec: 4,
      mimeType: 'audio/webm',
      audioDataUrl: 'data:audio/webm;base64,AAAA',
      transcript: 'Verified zero-guard matches billing SLA.',
      transcriptionStatus: 'completed' as const,
    },
  ];

  const auditWithNotes = buildAuditEntry({
    analysis,
    decision: 'accepted',
    voiceNotes: mockVoiceNotes,
    now: new Date('2026-11-19T01:00:00.000Z'),
  });
  assert.equal(auditWithNotes.voiceNoteCount, 1);
  assert.ok(auditWithNotes.voiceNotesSummary?.includes('billing SLA'));
  assert.equal(filterAuditEntries([auditWithNotes], 'all', 'billing SLA').length, 1);

  const report = formatStructuredMarkdownReport(
    analysis,
    pricingDemo.testCode,
    'accepted',
    mockVoiceNotes
  );
  assert.ok(report.includes('Developer Voice Notes'));
  assert.ok(report.includes('billing SLA'));
});


