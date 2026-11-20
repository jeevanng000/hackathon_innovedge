import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAutoPatchApp } from '../server.ts';
import {
  analyzeStaticMultiLang,
  runMultiLangAnalysis,
} from './multi_lang_engine.ts';
import {
  parseAndValidateAiFindings,
  validateAudioPayload,
} from './gemini_bug_scanner.ts';
import {
  createSandboxTempDir,
  getSandboxIsolationInfo,
  runInIsolatedSandbox,
  writeSandboxFile,
} from './sandbox_runner.ts';
import type { AnalysisResponse } from '../src/types/autopatch.ts';

const ENGINE_PATH = path.resolve(process.cwd(), 'engine', 'autopatch_engine.py');

function runPythonEngineSync(
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {}
): AnalysisResponse {
  const stdout = execFileSync('python3', [ENGINE_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 12000,
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(stdout.trim()) as AnalysisResponse;
}

async function startTestHttpServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const tmpAuditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_backend_audit_'));
  const app = createAutoPatchApp({
    auditLogPath: path.join(tmpAuditDir, 'audit.ndjson'),
    enableGraphWriteBack: false,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      const { closeNeo4jDriver } = await import('./graphrag/neo4j_client.ts');
      await closeNeo4jDriver().catch(() => {});
      await fs.rm(tmpAuditDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. REAL AST & COMPILER DIAGNOSTICS (NO FALSE POSITIVES IN COMMENTS/STRINGS)
// ---------------------------------------------------------------------------

test('JS/TS Acorn AST parser ignores defects inside comments and string literals', async () => {
  const cleanTs = `export function describePolicy(name: string): string {
  // eval(userInput) and for (let i = 0; i <= arr.length; i++) and a / count
  const doc = "SELECT * FROM users WHERE id = " + "literal_only";
  const note = "eval(danger)";
  return name + doc + note;
}
`;
  const report = await analyzeStaticMultiLang(cleanTs, 'policy.ts', 'typescript');
  assert.equal(report.syntaxValid, true);
  assert.equal(report.analysisKind, 'ast-parser');
  assert.equal(report.parserTool, 'esbuild+acorn');
  assert.equal(report.findings.length, 0, `Expected 0 findings in clean code, got: ${JSON.stringify(report.findings)}`);
  assert.equal(report.functions?.[0]?.name, 'describePolicy');
});

test('GCC compiler diagnostics catch real C syntax errors and report compiler-diagnostics', async () => {
  const brokenC = `int add(int a, int b) {
    return a + b
}
`;
  const report = await analyzeStaticMultiLang(brokenC, 'broken.c', 'c');
  assert.equal(report.syntaxValid, false);
  assert.equal(report.analysisKind, 'compiler-diagnostics');
  assert.ok(report.findings.some((f) => f.kind === 'SyntaxError'));
});

test('Bash -n diagnostics catch real shell syntax errors', async () => {
  const brokenBash = `#!/usr/bin/env bash
if [ "$1" = "ok" ]; then
  echo "missing fi"
`;
  const report = await analyzeStaticMultiLang(brokenBash, 'broken.sh', 'bash');
  assert.equal(report.syntaxValid, false);
  assert.equal(report.analysisKind, 'compiler-diagnostics');
  assert.ok(report.findings.some((f) => f.kind === 'SyntaxError'));
});

// ---------------------------------------------------------------------------
// 2. REAL JS/TS SBFL COVERAGE (ZERO FABRICATED LINES)
// ---------------------------------------------------------------------------

test('TypeScript SBFL collects real per-test line coverage via Acorn AST instrumentation (no fabricated fallback)', async () => {
  const sourceCode = `export function calculateTierFee(amount: number, isVip: boolean): number {
  if (isVip) {
    return 0;
  }
  if (amount > 100) {
    return 0;
  }
  return 15;
}
`;
  const testCode = `import assert from 'node:assert/strict';
import { calculateTierFee } from './fees';

export function test_vip_is_free() {
  assert.equal(calculateTierFee(50, true), 0);
}

export function test_below_threshold_pays_fee() {
  assert.equal(calculateTierFee(50, false), 15);
}

export function test_exact_100_is_free() {
  assert.equal(calculateTierFee(100, false), 0);
}
`;
  const res = await runMultiLangAnalysis({
    action: 'analyze',
    language: 'typescript',
    filename: 'fees.ts',
    testFilename: 'test_fees.ts',
    sourceCode,
    testCode,
  });

  assert.equal(res.verificationMode, 'dynamic-sandbox');
  assert.equal(res.trustVerdict, 'verified');
  assert.ok(res.patchedCode.includes('amount >= 100'));
  assert.equal(res.sbfl?.coverageStatus, 'collected');
  assert.ok((res.sbfl?.rankings.length ?? 0) >= 2);
  // VIP test hits line 3 (return 0), failing test hits line 5/8 — proving real differentiated coverage!
  const line3 = res.sbfl?.rankings.find((r) => r.line === 3);
  const line5 = res.sbfl?.rankings.find((r) => r.line === 5);
  assert.ok(line3, 'Line 3 should be covered by passing VIP test');
  assert.equal(line3?.failedCovering, 0);
  assert.equal(line3?.passedCovering, 1);
  assert.ok(line5, 'Line 5 should be covered by non-VIP tests including failing boundary test');
  assert.ok((line5?.failedCovering ?? 0) >= 1);
  assert.ok((line5?.ochiai ?? 0) > (line3?.ochiai ?? 0));
});

test('Static-only runs return coverageStatus unavailable and zero fabricated SBFL rankings', async () => {
  const res = await runMultiLangAnalysis({
    action: 'analyze',
    language: 'go',
    filename: 'calc.go',
    testFilename: 'calc_test.go',
    sourceCode: `package main
func avg(total int, count int) int {
    return total / count
}
`,
    testCode: '',
  });
  assert.equal(res.verificationMode, 'static-only');
  assert.equal(res.analysisKind, 'heuristic');
  assert.equal(res.trustVerdict, 'blocked');
  assert.equal(res.sbfl?.coverageStatus, 'unavailable');
  assert.equal(res.sbfl?.rankings.length, 0);
  assert.equal(res.generatedTestCode, undefined);
});

// ---------------------------------------------------------------------------
// 3. C/C++ STRICT PASS REQUIREMENT & EMPTY TEST SUITE HONESTY
// ---------------------------------------------------------------------------

test('C binary exiting 0 without printing explicit PASS is blocked (NoTestAssertions)', async () => {
  const cSrc = `int add(int a, int b) { return a + b; }\n`;
  const silentMain = `#include "add.c"\nint main(void) { return 0; }\n`;

  const res = await runMultiLangAnalysis({
    action: 'analyze',
    language: 'c',
    filename: 'add.c',
    testFilename: 'test_add.c',
    sourceCode: cSrc,
    testCode: silentMain,
  });

  assert.equal(res.trustVerdict, 'blocked');
  assert.equal(res.sandbox.passed, 0);
  assert.equal(res.sandbox.errorType, 'NoTestAssertions');
});

test('C++ binary printing explicit PASS passes verification cleanly', async () => {
  const cppSrc = `double safe_ratio(double a, double b) {\n    return a / b;\n}\n`;
  const cppTest = `#include <iostream>
#include <cmath>
#include "ratio.cpp"
int main() {
    if (std::fabs(safe_ratio(10.0, 2.0) - 5.0) < 0.001 && std::fabs(safe_ratio(10.0, 0.0) - 0.0) < 0.001) {
        std::cout << "PASS:test_safe_ratio\\n";
        return 0;
    }
    std::cout << "FAIL:test_safe_ratio:bad result\\n";
    return 1;
}
`;
  const res = await runMultiLangAnalysis({
    action: 'analyze',
    language: 'cpp',
    filename: 'ratio.cpp',
    testFilename: 'test_ratio.cpp',
    sourceCode: cppSrc,
    testCode: cppTest,
  });

  assert.equal(res.verificationMode, 'dynamic-sandbox');
  assert.equal(res.trustVerdict, 'verified');
  assert.equal(res.sandbox.passed, 1);
  assert.ok(res.patchedCode.includes('if (b == 0)'));
});

test('Python analysis without tests and without deterministic contract does NOT generate placeholder tests or claim verified', () => {
  const res = runPythonEngineSync({
    action: 'analyze',
    filename: 'custom_math.py',
    testFilename: 'test_custom_math.py',
    sourceCode: `def custom_ratio(total, count):\n    return total / count\n`,
    testCode: '',
  });
  assert.equal(res.verificationMode, 'static-only');
  assert.equal(res.trustVerdict, 'blocked');
  assert.equal(res.testSynthesisStatus, 'unavailable-human-tests-required');
  assert.equal(res.generatedTestCode, undefined);
  assert.ok(res.confidence.score <= 45, `Static-only Python confidence must exclude sandbox points, got ${res.confidence.score}`);
});

test('Fail-closed sandbox mode (SANDBOX_ALLOW_UNTRUSTED_EXEC=false) marks execution unavailable and blocks verification', () => {
  const res = runPythonEngineSync(
    {
      action: 'analyze',
      filename: 'math_mod.py',
      testFilename: 'test_math_mod.py',
      sourceCode: `def div(a, b):\n    return a / b\n`,
      testCode: `from math_mod import div\ndef test_div():\n    assert div(4, 2) == 2\n    assert div(4, 0) == 0.0\n`,
    },
    { SANDBOX_ALLOW_UNTRUSTED_EXEC: 'false' }
  );

  assert.equal(res.verificationMode, 'execution-unavailable');
  assert.equal(res.trustVerdict, 'blocked');
  assert.equal(res.sandbox.executionKind, 'execution-unavailable');
  assert.equal(res.sandbox.passed, 0);
});

// ---------------------------------------------------------------------------
// 4. SANDBOX ISOLATION SECURITY TESTS (NETWORK, SECRETS, UID, TIMEOUT, OUTPUT BOMB)
// ---------------------------------------------------------------------------

test('Isolated sandbox blocks outbound network, strips GEMINI_API_KEY, runs as non-root UID nobody, and cleans temp dirs', async () => {
  const info = getSandboxIsolationInfo();
  assert.equal(info.level, 'linux-namespace-unprivileged');
  assert.equal(info.networkIsolated, true);
  assert.equal(info.pidIsolated, true);

  const prevSecret = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'SUPER_SECRET_TEST_KEY_12345';

  const tmpdir = await createSandboxTempDir('autopatch_sec_test_');
  try {
    const pyScript = `import os, socket, json
net_blocked = False
try:
    socket.create_connection(("1.1.1.1", 80), timeout=1)
except OSError:
    net_blocked = True
print(json.dumps({
    "uid": os.getuid(),
    "pid": os.getpid(),
    "secret": os.environ.get("GEMINI_API_KEY"),
    "netBlocked": net_blocked
}))
`;
    const scriptPath = await writeSandboxFile(tmpdir, 'probe.py', pyScript);
    const pyRun = await runInIsolatedSandbox('python3', ['-I', scriptPath], {
      cwd: tmpdir,
      timeoutMs: 2500,
      mode: 'run',
    });
    assert.equal(pyRun.code, 0, pyRun.stderr);
    const parsed = JSON.parse(pyRun.stdout.trim()) as {
      uid: number;
      pid: number;
      secret: string | null;
      netBlocked: boolean;
    };
    assert.equal(parsed.secret, null, 'GEMINI_API_KEY must NEVER be visible inside sandbox');
    assert.equal(parsed.netBlocked, true, 'Outbound network MUST be blocked by Linux network namespace');
    assert.equal(parsed.pid, 1, 'Process must run in isolated PID namespace');
    if (info.isolatedUser) {
      assert.equal(parsed.uid, 65534, 'Process must run as unprivileged UID nobody (65534)');
    }

    // Node.js secret stripping check
    const nodeRun = await runInIsolatedSandbox(
      'node',
      ['-e', 'console.log(JSON.stringify({secret: process.env.GEMINI_API_KEY ?? null}))'],
      { cwd: tmpdir, timeoutMs: 2500, mode: 'node' }
    );
    assert.equal(nodeRun.code, 0, nodeRun.stderr);
    assert.equal(JSON.parse(nodeRun.stdout.trim()).secret, null);

    // Bash secret stripping check
    const bashRun = await runInIsolatedSandbox(
      'bash',
      ['-c', 'printf "%s" "${GEMINI_API_KEY:-EMPTY}"'],
      { cwd: tmpdir, timeoutMs: 2000, mode: 'run' }
    );
    assert.equal(bashRun.code, 0);
    assert.equal(bashRun.stdout, 'EMPTY');

    // Output bomb termination check
    const bombRun = await runInIsolatedSandbox(
      'python3',
      ['-I', '-c', 'while True: print("X" * 4096)'],
      { cwd: tmpdir, timeoutMs: 3000, mode: 'run', maxOutputBytes: 16384 }
    );
    assert.equal(bombRun.outputTruncated, true, 'Excessive output loop must be truncated and killed');
  } finally {
    if (prevSecret === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevSecret;
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
});

test('Python sandbox cleans up temp directories and terminates infinite loops cleanly', async () => {
  const isolatedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_cleanup_check_'));
  await fs.chmod(isolatedTmp, 0o777);
  try {
    const res = runPythonEngineSync(
      {
        action: 'analyze',
        filename: 'hang.py',
        testFilename: 'test_hang.py',
        sourceCode: `import os\ndef hang():\n    os.makedirs("locked_dir", exist_ok=True)\n    with open("locked_dir/data.txt", "w") as f:\n        f.write("x")\n    os.chmod("locked_dir", 0o500)\n    while True:\n        pass\n`,
        testCode: `from hang import hang\ndef test_hang():\n    hang()\n`,
        timeoutSeconds: 0.7,
      },
      { TMPDIR: isolatedTmp }
    );
    const leakedEntries = (await fs.readdir(isolatedTmp)).filter((n) =>
      n.startsWith('autopatch_sandbox_')
    );
    assert.equal(res.baseline.timedOut, true);
    assert.equal(res.trustVerdict, 'blocked');
    assert.equal(res.verificationStatus, 'FAILED');
    assert.equal(typeof res.originalSourceHash, 'string');
    assert.equal(res.originalSourceHash?.length, 64);
    assert.equal(leakedEntries.length, 0, 'No leaked autopatch_sandbox_ temp dirs');
  } finally {
    await fs.rm(isolatedTmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. GEMINI AI OUTPUT VALIDATION & AUDIO VALIDATION HARDENING
// ---------------------------------------------------------------------------

test('Gemini finding validator rejects malformed JSON, out-of-bounds lines, broken syntax, and eval() injection', async () => {
  const src = `export function greet(name: string) {\n  return "hi " + name;\n}\n`;
  // Malformed JSON
  const badJson = await parseAndValidateAiFindings({
    rawJsonText: '{not valid json',
    sourceCode: src,
    language: 'typescript',
    filename: 'greet.ts',
  });
  assert.deepEqual(badJson, []);

  // Out-of-bounds line + dangerous eval replacement + syntax-breaking replacement
  const adversarial = JSON.stringify([
    {
      line: 999,
      endLine: 999,
      category: 'security',
      severity: 'critical',
      title: 'Out of bounds',
      cweOrRule: 'CWE-0',
      plainEnglishExplanation: 'Invalid line',
      technicalExplanation: 'Invalid line',
      impactSummary: 'None',
      suggestedReplacement: 'return 1;',
      canAutoFix: true,
    },
    {
      line: 2,
      endLine: 2,
      category: 'security',
      severity: 'critical',
      title: 'Injected eval replacement',
      cweOrRule: 'CWE-94',
      plainEnglishExplanation: 'Sneaky payload',
      technicalExplanation: 'Sneaky payload',
      impactSummary: 'Bad',
      suggestedReplacement: '  return eval(name);',
      canAutoFix: true,
    },
    {
      line: 2,
      endLine: 2,
      category: 'logic',
      severity: 'warning',
      title: 'Broken syntax replacement',
      cweOrRule: 'Syntax',
      plainEnglishExplanation: 'Broken',
      technicalExplanation: 'Broken',
      impactSummary: 'Bad',
      suggestedReplacement: '  return (((;',
      canAutoFix: true,
    },
  ]);

  const parsed = await parseAndValidateAiFindings({
    rawJsonText: adversarial,
    sourceCode: src,
    language: 'typescript',
    filename: 'greet.ts',
  });
  assert.equal(parsed.length, 2, 'Out-of-bounds line 999 must be dropped');
  assert.equal(parsed[0].canAutoFix, false, 'Replacement injecting eval() must be downgraded to canAutoFix=false');
  assert.equal(parsed[0].suggestedReplacement, null);
  assert.equal(parsed[1].canAutoFix, false, 'Syntax-breaking replacement must be downgraded to canAutoFix=false');
  assert.equal(parsed[1].suggestedReplacement, null);
});

test('Audio payload validator enforces MIME allowlist, base64 syntax, and byte limits', () => {
  const badMime = validateAudioPayload({
    audioBase64: 'AAAA',
    mimeType: 'text/html',
    maxDecodedBytes: 1000,
  });
  assert.equal(badMime.ok, false);
  if (!badMime.ok) assert.equal(badMime.status, 400);

  const badB64 = validateAudioPayload({
    audioBase64: '!!!not-base64!!!',
    mimeType: 'audio/webm',
    maxDecodedBytes: 1000,
  });
  assert.equal(badB64.ok, false);

  const tooBig = validateAudioPayload({
    audioBase64: 'A'.repeat(2000),
    mimeType: 'audio/webm',
    maxDecodedBytes: 100,
  });
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.equal(tooBig.status, 413);

  const good = validateAudioPayload({
    audioBase64: Buffer.from('hello-audio').toString('base64'),
    mimeType: 'audio/webm;codecs=opus',
    maxDecodedBytes: 1000,
  });
  assert.equal(good.ok, true);
});

// ---------------------------------------------------------------------------
// 6. EXPRESS HTTP API SECURITY, INPUT VALIDATION, FORGED BASELINE, RATE LIMITING
// ---------------------------------------------------------------------------

test('HTTP API enforces health, input validation, path traversal, 400/413, forged baseline rejection, and rate limiting', async () => {
  const { baseUrl, close } = await startTestHttpServer();
  try {
    // Health endpoint & iFrame-compatible security headers
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.ok(healthRes.headers.get('x-request-id'));
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(healthRes.headers.get('cache-control'), 'no-store');
    assert.equal(healthRes.headers.get('x-frame-options'), null);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.auditStorageMode, 'backend-append-only');
    assert.equal(typeof health.geminiConfigured, 'boolean');
    assert.ok(Array.isArray((health.languages as { executableSandbox: string[] }).executableSandbox));

    // Path traversal rejected (400)
    const traversalRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: '../../etc/passwd',
        sourceCode: 'x = 1',
        includeAiScan: false,
      }),
    });
    assert.equal(traversalRes.status, 400);

    // Unsupported language rejected (400)
    const badLangRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'test.py',
        language: 'nonexistent_lang',
        sourceCode: 'x = 1',
        includeAiScan: false,
      }),
    });
    assert.equal(badLangRes.status, 400);

    // Malformed JSON rejected (400) without leaking stack traces
    const badJsonRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"sourceCode": ',
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = (await badJsonRes.json()) as { error: string };
    assert.ok(!badJsonBody.error.includes('/app/applet'));

    // Large payload (>150KB) executes seamlessly with raised default limits (200)
    const bigRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'huge.py',
        sourceCode: 'x = 1\n'.repeat(25_000),
        includeAiScan: false,
      }),
    });
    assert.equal(bigRes.status, 200);

    // Forged client baseline in /api/validate MUST be ignored (server recomputes real baseline!)
    // Here original passes 2 tests, candidate regresses to passing 1 test & failing 1 test.
    // Client tries to forge baseline={passed:0, failed:2, total:2} to hide regression.
    const originalPy = `def double(x):\n    return x * 2\n`;
    const brokenCandidatePy = `def double(x):\n    return x * 3\n`;
    const testsPy = `from mod import double\ndef test_zero():\n    assert double(0) == 0\ndef test_two():\n    assert double(2) == 4\n`;
    const validateRes = await fetch(`${baseUrl}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'mod.py',
        testFilename: 'test_mod.py',
        language: 'python',
        originalCode: originalPy,
        candidateCode: brokenCandidatePy,
        testCode: testsPy,
        baseline: {
          timedOut: false,
          importError: false,
          passed: 0,
          failed: 2,
          total: 2,
          durationMs: 1,
          errorType: 'ForgedError',
          errorMessage: 'Forged by client',
          errorLine: 1,
          traceback: null,
          tests: [],
        },
      }),
    });
    assert.equal(validateRes.status, 200);
    const valData = (await validateRes.json()) as AnalysisResponse;
    assert.equal(valData.baseline.passed, 2, 'Server must recompute real baseline (passed=2) and ignore forged baseline');
    assert.equal(valData.baseline.failed, 0);
    assert.equal(valData.sandbox.failed, 1);
    assert.equal(valData.trustVerdict, 'blocked');

    // Invalid audio MIME on /api/transcribe-note returns 400
    const badAudioRes = await fetch(`${baseUrl}/api/transcribe-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioDataUrl: 'data:text/plain;base64,SGVsbG8=',
        mimeType: 'text/plain',
      }),
    });
    assert.equal(badAudioRes.status, 400);
  } finally {
    await close();
  }
});

test('Rate limiter returns HTTP 429 with Retry-After when MAX_REQUESTS_PER_MINUTE is exceeded', async () => {
  const prevLimit = process.env.MAX_REQUESTS_PER_MINUTE;
  process.env.MAX_REQUESTS_PER_MINUTE = '5';
  const { baseUrl, close } = await startTestHttpServer();
  try {
    let hit429 = false;
    let retryAfter: string | null = null;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'x.py', sourceCode: '', includeAiScan: false }),
      });
      if (r.status === 429) {
        hit429 = true;
        retryAfter = r.headers.get('retry-after');
        break;
      }
    }
    assert.equal(hit429, true, 'Should enforce 429 rate limit');
    assert.ok(retryAfter && Number(retryAfter) >= 1, 'Should include Retry-After header');
  } finally {
    if (prevLimit === undefined) delete process.env.MAX_REQUESTS_PER_MINUTE;
    else process.env.MAX_REQUESTS_PER_MINUTE = prevLimit;
    await close();
  }
});

test('Explicit MAX_SOURCE_SIZE_BYTES cap triggers 413 and parseAndValidateAiFindings preserves >6 findings and >25-line spans', async () => {
  const prevMax = process.env.MAX_SOURCE_SIZE_BYTES;
  process.env.MAX_SOURCE_SIZE_BYTES = '100000';
  const { baseUrl, close } = await startTestHttpServer();
  try {
    const oversizedRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'too_big_for_env.py',
        sourceCode: 'x = 1\n'.repeat(25_000),
        includeAiScan: false,
      }),
    });
    assert.equal(oversizedRes.status, 413);
  } finally {
    if (prevMax === undefined) delete process.env.MAX_SOURCE_SIZE_BYTES;
    else process.env.MAX_SOURCE_SIZE_BYTES = prevMax;
    await close();
  }

  const longCode = Array.from({ length: 40 }, (_, i) => `val_${i + 1} = ${i + 1}`).join('\n');
  const rawFindings = Array.from({ length: 8 }, (_, idx) => ({
    line: idx + 1,
    endLine: idx === 0 ? 35 : idx + 2,
    category: 'runtime',
    severity: 'warning',
    title: `Finding ${idx + 1}`,
    plainEnglishExplanation: `Issue ${idx + 1}`,
    technicalExplanation: `Technical details ${idx + 1}`,
    canAutoFix: false,
  }));

  const validated = await parseAndValidateAiFindings({
    rawJsonText: JSON.stringify(rawFindings),
    sourceCode: longCode,
    language: 'python',
    filename: 'large_module.py',
  });
  assert.equal(validated.length, 8);
  assert.equal(validated[0].endLine - validated[0].line, 34);
});

// ---------------------------------------------------------------------------
// 7. BACKEND SECURITY HARDENING REGRESSION TESTS
// ---------------------------------------------------------------------------

test('Sandbox runner rejects disallowed binaries and working directories outside os.tmpdir()', async () => {
  const disallowedCmd = await runInIsolatedSandbox('cat', ['/etc/passwd'], {
    cwd: os.tmpdir(),
    timeoutMs: 1000,
    mode: 'run',
  });
  assert.equal(disallowedCmd.executionUnavailable, true);
  assert.equal(disallowedCmd.code, 126);

  const disallowedCwd = await runInIsolatedSandbox('node', ['-e', 'console.log(1)'], {
    cwd: process.cwd(),
    timeoutMs: 1000,
    mode: 'node',
  });
  assert.equal(disallowedCwd.executionUnavailable, true);
  assert.equal(disallowedCwd.code, 126);
});

test('HTTP API enforces Content-Type 415, API 404 JSON catch-all, strict /api/audit validation, and XFF anti-spoofing', async () => {
  const prevLimit = process.env.MAX_REQUESTS_PER_MINUTE;
  const prevTrustProxy = process.env.TRUST_PROXY;
  process.env.MAX_REQUESTS_PER_MINUTE = '5';
  delete process.env.TRUST_PROXY;

  const { baseUrl, close } = await startTestHttpServer();
  try {
    // 1. Security headers present, X-Frame-Options still absent for iFrame compatibility
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.headers.get('x-dns-prefetch-control'), 'off');
    assert.equal(healthRes.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(healthRes.headers.get('x-frame-options'), null);

    // 2. Unknown /api route returns JSON 404 (not SPA HTML)
    const notFoundRes = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(notFoundRes.status, 404);
    const nfJson = (await notFoundRes.json()) as { error: string };
    assert.ok(nfJson.error);

    // 3. Non-JSON Content-Type on POST /api/* returns 415
    const formPostRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });
    assert.equal(formPostRes.status, 415);

    // 4. Strict /api/audit validation rejects invalid id, decision, verificationStatus
    const badAuditId = await fetch(`${baseUrl}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad/id\nline', filename: 'a.py', decision: 'accepted' }),
    });
    assert.equal(badAuditId.status, 400);

    const badAuditDecision = await fetch(`${baseUrl}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'a.py', decision: 'malicious_decision' }),
    });
    assert.equal(badAuditDecision.status, 400);

    const badAuditStatus = await fetch(`${baseUrl}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'a.py', decision: 'accepted', verificationStatus: 'FORGED_STATUS' }),
    });
    assert.equal(badAuditStatus.status, 400);

    // 5. Spoofing X-Forwarded-For does not bypass rate limiter when TRUST_PROXY is unset
    let hit429 = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${baseUrl}/api/audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${i + 1}`,
        },
        body: JSON.stringify({ filename: 'a.py', decision: 'accepted' }),
      });
      if (r.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, 'Spoofed X-Forwarded-For must not bypass per-IP rate limiting');
  } finally {
    if (prevLimit === undefined) delete process.env.MAX_REQUESTS_PER_MINUTE;
    else process.env.MAX_REQUESTS_PER_MINUTE = prevLimit;
    if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTrustProxy;
    await close();
  }
});

