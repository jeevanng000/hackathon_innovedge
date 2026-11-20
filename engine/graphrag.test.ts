import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { QueryResult } from 'neo4j-driver';
import { createAutoPatchApp } from '../server.ts';
import {
  AppendOnlyFileAuditStore,
  computeContentSha256,
} from './audit_store.ts';
import {
  loadAppEnvConfig,
  redactSecrets,
  validateStartupConfig,
} from './env_config.ts';
import {
  discoverRepositoryFiles,
  extractSourceFile,
} from './graphrag/code_extractor.ts';
import {
  ingestRepositoryToGraph,
} from './graphrag/ingestion_service.ts';
import {
  analyzeEntityImpact,
  answerGraphQuestion,
  investigateRootCause,
  searchHistoricalBugs,
} from './graphrag/intelligence_service.ts';
import {
  closeNeo4jDriver,
  getProjectGraphCounts,
  initializeGraphSchema,
  runWriteQuery,
  verifyNeo4jConnection,
} from './graphrag/neo4j_client.ts';
import {
  hybridRetrieve,
} from './graphrag/retrieval_service.ts';
import { computeTextDiff } from './multi_lang_engine.ts';

function makeFakeRecord(data: Record<string, unknown>) {
  return {
    get: (key: string) => data[key],
  };
}

function makeFakeResult(rows: Array<Record<string, unknown>>): QueryResult {
  return {
    records: rows.map(makeFakeRecord),
  } as unknown as QueryResult;
}

async function startTestServer(auditLogPath: string) {
  const app = createAutoPatchApp({ auditLogPath, enableGraphWriteBack: false });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// ---------------------------------------------------------------------------
// 1. ENVIRONMENT CONFIG & SECRET REDACTION
// ---------------------------------------------------------------------------

test('validateStartupConfig separates secrets from defaults, derives Aura instanceId without AURA_INSTANCEID, degrades optional services cleanly, and redacts secrets', () => {
  const saved: Record<string, string | undefined> = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    NEO4J_URI: process.env.NEO4J_URI,
    NEO4J_USERNAME: process.env.NEO4J_USERNAME,
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD,
    NEO4J_DATABASE: process.env.NEO4J_DATABASE,
    GRAPHRAG_ENABLED: process.env.GRAPHRAG_ENABLED,
    AUTOPATCH_API_KEY: process.env.AUTOPATCH_API_KEY,
  };

  try {
    // 1. All optional credentials absent -> server still ok, zero missingRequired, optional services disabled cleanly
    delete process.env.GEMINI_API_KEY;
    delete process.env.NEO4J_URI;
    delete process.env.NEO4J_USERNAME;
    delete process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_DATABASE;
    delete process.env.GRAPHRAG_ENABLED;
    delete process.env.AUTOPATCH_API_KEY;

    const cleanReport = validateStartupConfig();
    assert.equal(cleanReport.ok, true);
    assert.equal(cleanReport.features.deterministicEngine, true);
    assert.equal(cleanReport.features.geminiAi, false);
    assert.equal(cleanReport.features.graphRagEnabled, false);
    assert.equal(cleanReport.features.graphRagConfigured, false);
    assert.equal(cleanReport.missingRequired.length, 0);
    assert.equal(cleanReport.optionalDisabled.length, 3);

    // 2. Partial Neo4j credentials -> ONE consolidated missingRequired list identifying exact missing vars
    process.env.NEO4J_URI = 'neo4j+s://726bbfa1.databases.neo4j.io';
    process.env.GRAPHRAG_ENABLED = 'true';
    const partialReport = validateStartupConfig();
    assert.equal(partialReport.ok, true, 'Missing optional integration creds must not crash boot');
    const missingNames = partialReport.missingRequired.map((m) => m.variable).sort();
    assert.deepEqual(missingNames, ['NEO4J_PASSWORD', 'NEO4J_USERNAME']);
    assert.ok(partialReport.missingRequired.every((m) => m.source.includes('console.neo4j.io')));

    // 3. Full Neo4j credentials WITHOUT AURA_INSTANCEID -> configured=true and instanceId auto-derived from URI
    process.env.GEMINI_API_KEY = 'AIzaSyFakeTestSecretKey1234567890abcdef';
    process.env.NEO4J_USERNAME = 'neo4j';
    process.env.NEO4J_PASSWORD = 'super-secret-neo4j-pass-999';
    const cfg = loadAppEnvConfig();
    assert.equal(cfg.neo4j.configured, true);
    assert.equal(cfg.neo4j.instanceId, '726bbfa1');
    assert.equal(cfg.neo4j.database, 'neo4j');

    const fullReport = validateStartupConfig();
    assert.equal(fullReport.ok, true);
    assert.equal(fullReport.missingRequired.length, 0);
    assert.equal(fullReport.secretsStatus.geminiApiKey, 'configured');
    assert.equal(fullReport.secretsStatus.neo4jPassword, 'configured');
    assert.equal(fullReport.secretsStatus.autopatchApiKey, 'optional-unset');

    // 4. Secret redaction masks API keys, passwords, and bearer tokens
    const rawMsg =
      'Auth error using AIzaSyFakeTestSecretKey1234567890abcdef, Bearer tok_abcdef123456, and password=super-secret-neo4j-pass-999';
    const safeMsg = redactSecrets(rawMsg);
    assert.equal(safeMsg.includes('AIzaSyFakeTestSecretKey1234567890abcdef'), false);
    assert.equal(safeMsg.includes('super-secret-neo4j-pass-999'), false);
    assert.equal(safeMsg.includes('tok_abcdef123456'), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// 2. HYBRID RETRIEVAL, RANKING, DEDUP, TRAVERSAL & DEGRADATION (MOCKED)
// ---------------------------------------------------------------------------

test('hybridRetrieve combines vector, fulltext, exact, graph-traversal, and historical retrieval with project isolation', async () => {
  const observedProjectIds: string[] = [];
  const dims = loadAppEnvConfig().gemini.embeddingDimensions;

  const mockRunReadQuery = async (cypher: string, params: Record<string, unknown> = {}) => {
    if (typeof params.projectId === 'string') {
      observedProjectIds.push(params.projectId);
    }
    if (cypher.includes('db.index.vector.queryNodes')) {
      if (params.indexName === 'function_embedding_idx') {
        return makeFakeResult([
          {
            node: {
              labels: ['Function'],
              properties: {
                id: 'fn:projA:auth.ts:verifyToken:10',
                projectId: 'projA',
                name: 'verifyToken',
                filePath: 'src/auth.ts',
                startLine: 10,
                endLine: 28,
                summary: 'Verifies JWT token signature.',
                codeSnippet: 'export function verifyToken(tok: string) {}',
              },
            },
            label: 'Function',
            score: 0.91,
          },
        ]);
      }
      return makeFakeResult([]);
    }
    if (cypher.includes('db.index.fulltext.queryNodes')) {
      return makeFakeResult([
        {
          node: {
            labels: ['Function'],
            properties: {
              id: 'fn:projA:auth.ts:verifyToken:10',
              projectId: 'projA',
              name: 'verifyToken',
              filePath: 'src/auth.ts',
              startLine: 10,
              endLine: 28,
              summary: 'Verifies JWT token signature.',
            },
          },
          label: 'Function',
          score: 4.5,
        },
      ]);
    }
    if (cypher.includes('ANY(tok IN $tokens') && !cypher.includes('h:Finding')) {
      return makeFakeResult([
        {
          node: {
            labels: ['File'],
            properties: {
              id: 'file:projA:src/auth.ts',
              projectId: 'projA',
              name: 'auth.ts',
              path: 'src/auth.ts',
              summary: 'Auth module.',
            },
          },
          label: 'File',
        },
      ]);
    }
    if (cypher.includes('relationships(p) AS pathRels')) {
      return makeFakeResult([
        {
          seedId: 'fn:projA:auth.ts:verifyToken:10',
          neighbor: {
            labels: ['Test'],
            properties: {
              id: 'test:projA:auth.test.ts:test_verifyToken',
              projectId: 'projA',
              name: 'test_verifyToken',
              filePath: 'src/auth.test.ts',
              startLine: 5,
              endLine: 12,
              summary: 'Unit test for verifyToken.',
            },
          },
          nLabel: 'Test',
          hop: 1,
          relChain: [
            {
              type: 'TESTS',
              startId: 'test:projA:auth.test.ts:test_verifyToken',
              endId: 'fn:projA:auth.ts:verifyToken:10',
            },
          ],
        },
      ]);
    }
    if (cypher.includes('h:Finding OR h:Vulnerability')) {
      return makeFakeResult([
        {
          node: {
            labels: ['Finding'],
            properties: {
              id: 'finding:projA:src/auth.ts:NullDereference:18',
              projectId: 'projA',
              title: 'Null check missing in verifyToken',
              filePath: 'src/auth.ts',
              line: 18,
              severity: 'critical',
              summary: 'Missing null guard on decoded payload.',
            },
          },
          label: 'Finding',
        },
      ]);
    }
    return makeFakeResult([]);
  };

  const res = await hybridRetrieve({
    projectId: 'projA',
    query: 'verifyToken null payload',
    maxDepth: 2,
    maxNodes: 20,
    deps: {
      runReadQuery: mockRunReadQuery,
      embedQuery: async () => ({
        values: new Array<number>(dims).fill(0.1),
        model: 'gemini-embedding-001',
        dimensions: dims,
      }),
    },
  });

  assert.equal(res.mechanismsUsed.vector, true);
  assert.equal(res.mechanismsUsed.fulltext, true);
  assert.equal(res.mechanismsUsed.exact, true);
  assert.equal(res.mechanismsUsed.graphTraversal, true);
  assert.equal(res.mechanismsUsed.historical, true);
  assert.ok(observedProjectIds.length >= 5);
  assert.ok(observedProjectIds.every((id) => id === 'projA'), 'Every Cypher query must scope to projectId');

  // Verify deduplication: verifyToken merged across vector + fulltext with boosted score
  const verifyFn = res.entities.find((e) => e.entityId === 'fn:projA:auth.ts:verifyToken:10');
  assert.ok(verifyFn);
  assert.ok(verifyFn.retrievalMethods.includes('vector'));
  assert.ok(verifyFn.retrievalMethods.includes('fulltext'));
  assert.equal(verifyFn.filePath, 'src/auth.ts');
  assert.equal(verifyFn.startLine, 10);
  assert.equal(verifyFn.relationships.length, 1);
  assert.equal(verifyFn.relationships[0].type, 'TESTS');
});

test('hybridRetrieve degrades cleanly on embedding dimension mismatch and missing vector indexes', async () => {
  const mockRunReadQuery = async (cypher: string) => {
    if (cypher.includes('db.index.fulltext.queryNodes')) {
      throw new Error('No such fulltext index');
    }
    if (cypher.includes('ANY(tok IN $tokens') && !cypher.includes('h:Finding')) {
      return makeFakeResult([
        {
          node: {
            labels: ['Function'],
            properties: {
              id: 'fn:p1:server.ts:startServer:100',
              projectId: 'p1',
              name: 'startServer',
              filePath: 'server.ts',
              startLine: 100,
              endLine: 130,
              summary: 'Starts Express server.',
            },
          },
          label: 'Function',
        },
      ]);
    }
    return makeFakeResult([]);
  };

  const res = await hybridRetrieve({
    projectId: 'p1',
    query: 'startServer',
    deps: {
      runReadQuery: mockRunReadQuery,
      // Deliberate incompatible embedding dimension (4 vs 768)
      embedQuery: async () => ({
        values: [0.1, 0.2, 0.3, 0.4],
        model: 'bad-dim',
        dimensions: 4,
      }),
    },
  });

  assert.equal(res.mechanismsUsed.vector, false);
  assert.equal(res.mechanismsUsed.exact, true);
  assert.equal(res.entities.length, 1);
  assert.ok(res.warnings.some((w) => w.includes('dimension mismatch')));
  assert.ok(res.warnings.some((w) => w.includes('Full-text index')));
});

// ---------------------------------------------------------------------------
// 3. INTELLIGENCE SERVICES: EMPTY GRAPH, GEMINI FAILURE, HISTORICAL NO-AUTO-APPLY
// ---------------------------------------------------------------------------

test('GraphRAG intelligence services handle empty graph and Gemini failure honestly without hallucinations', async () => {
  const emptyRead = async () => makeFakeResult([]);
  const nullEmbed = async () => null;
  const failingGemini = async () => null;

  const qa = await answerGraphQuestion({
    projectId: 'empty-proj',
    question: 'Where is payment reconciliation implemented?',
    deps: { runReadQuery: emptyRead, embedQuery: nullEmbed, generateJson: failingGemini },
  });
  assert.equal(qa.insufficientEvidence, true);
  assert.equal(qa.confidence, 0);
  assert.equal(qa.relevantFiles.length, 0);

  const root = await investigateRootCause({
    projectId: 'empty-proj',
    findingId: 'finding:missing:1',
    deps: { runReadQuery: emptyRead, embedQuery: nullEmbed, generateJson: failingGemini },
  });
  assert.equal(root.found, false);
  assert.equal(root.confirmedFacts.length, 0);

  const impact = await analyzeEntityImpact({
    projectId: 'empty-proj',
    targetType: 'Function',
    targetId: 'nonExistentFn',
    deps: { runReadQuery: emptyRead },
  });
  assert.equal(impact.found, false);
  assert.equal(impact.riskLevel, 'unknown');

  const hist = await searchHistoricalBugs({
    projectId: 'empty-proj',
    query: 'ZeroDivisionError',
    deps: { runReadQuery: emptyRead, embedQuery: nullEmbed },
  });
  assert.equal(hist.autoApplied, false);
  assert.equal(hist.matches.length, 0);
  assert.ok(hist.verificationAuthorityNote.includes('never auto-applies'));
});

// ---------------------------------------------------------------------------
// 4. LARGE-FILE DIFF PERFORMANCE (NON-QUADRATIC BOUNDED DIFF)
// ---------------------------------------------------------------------------

test('computeTextDiff handles large 1500-line files swiftly without quadratic blowup', () => {
  const linesA = Array.from({ length: 1500 }, (_, i) => `const value_${i} = ${i};`);
  const linesB = [...linesA];
  linesB[250] = 'const value_250 = 250000; // patched';
  linesB[1200] = 'const value_1200 = 120000; // patched';

  const t0 = performance.now();
  const diff = computeTextDiff(linesA.join('\n'), linesB.join('\n'), 'large.ts');
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 500, `Expected fast diff (<500ms), got ${elapsed.toFixed(1)}ms`);
  assert.equal(diff.linesAdded, 2);
  assert.equal(diff.linesRemoved, 2);
  assert.ok(diff.unified.includes('value_250 = 250000'));
});

// ---------------------------------------------------------------------------
// 5. APPEND-ONLY HASH-CHAINED AUDIT STORE & TAMPER DETECTION
// ---------------------------------------------------------------------------

test('AppendOnlyFileAuditStore chains SHA-256 hashes and detects on-disk tampering', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_audit_test_'));
  const logPath = path.join(tmpDir, 'audit.ndjson');
  try {
    const store = new AppendOnlyFileAuditStore(logPath);
    const e1 = await store.append({
      id: 'aud-1',
      timestamp: '2026-11-19T00:00:00.000Z',
      filename: 'calc.py',
      line: 4,
      bugType: 'ZeroDivisionError',
      ruleId: 'GUARD_DIV',
      confidence: 92,
      baselinePassed: 1,
      baselineTotal: 2,
      sandboxPassed: 2,
      sandboxTotal: 2,
      linesAdded: 1,
      linesRemoved: 1,
      sandboxVerdict: 'verified',
      verificationStatus: 'RUNTIME_VERIFIED',
      decision: 'accepted',
      originalSourceHash: computeContentSha256('def f(a, b): return a / b'),
      modifiedSourceHash: computeContentSha256('def f(a, b): return a / b if b else 0'),
      summary: 'Guarded zero divisor.',
    });
    const e2 = await store.append({
      id: 'aud-2',
      timestamp: '2026-11-19T00:01:00.000Z',
      filename: 'auth.ts',
      line: 12,
      bugType: 'NullDereference',
      ruleId: 'OPTIONAL_CHAIN',
      confidence: 88,
      baselinePassed: 0,
      baselineTotal: 1,
      sandboxPassed: 1,
      sandboxTotal: 1,
      linesAdded: 1,
      linesRemoved: 1,
      sandboxVerdict: 'verified',
      verificationStatus: 'RUNTIME_VERIFIED',
      decision: 'override',
      summary: 'Added optional chaining.',
    });

    assert.equal(e1.prevEntryHash, 'GENESIS');
    assert.equal(e2.prevEntryHash, e1.entryHash);
    const okChain = await store.verifyChain();
    assert.equal(okChain.valid, true);
    assert.equal(okChain.totalRecords, 2);

    // Tamper with first record on disk and reload in a fresh store instance
    const raw = await fs.readFile(logPath, 'utf-8');
    await fs.writeFile(logPath, raw.replace('"confidence":92', '"confidence":100'), 'utf-8');
    const reloaded = new AppendOnlyFileAuditStore(logPath);
    const brokenChain = await reloaded.verifyChain();
    assert.equal(brokenChain.valid, false);
    assert.equal(brokenChain.brokenAtIndex, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. AST CODE EXTRACTOR & SECRET EXCLUSION
// ---------------------------------------------------------------------------

test('discoverRepositoryFiles excludes secrets/node_modules/binaries and extractSourceFile parses TS/Python ASTs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_extract_test_'));
  try {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.env'), 'NEO4J_PASSWORD=secret\n', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'private.pem'), '-----BEGIN PRIVATE KEY-----', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'export const x = 1;', 'utf-8');
    await fs.writeFile(
      path.join(tmpDir, 'src', 'billing.ts'),
      `import { helper } from './helper';\nexport class InvoiceService {\n  compute(a: number) { return helper(a); }\n}\nexport function charge(x: number) { return helper(x); }\n`,
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'math_ops.py'),
      `import math\ndef divide(a, b):\n    return a / b\n`,
      'utf-8'
    );

    const files = await discoverRepositoryFiles(tmpDir, 50);
    assert.ok(files.includes('src/billing.ts'));
    assert.ok(files.includes('src/math_ops.py'));
    assert.equal(files.some((f) => f.includes('.env') || f.includes('.pem') || f.includes('node_modules')), false);

    const tsExtracted = await extractSourceFile('unit-proj', tmpDir, 'src/billing.ts');
    assert.ok(tsExtracted.functions.some((f) => f.name === 'charge'));
    assert.ok(tsExtracted.classes.some((c) => c.name === 'InvoiceService'));
    assert.ok(tsExtracted.dependencies.some((d) => d.name === './helper'));

    const pyExtracted = await extractSourceFile('unit-proj', tmpDir, 'src/math_ops.py');
    assert.ok(pyExtracted.functions.some((f) => f.name === 'divide'));
    assert.ok(pyExtracted.dependencies.some((d) => d.name === 'math'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. HTTP API: STALE PATCH 409, AUDIT ROUTES, API KEY AUTH, VALIDATION, DEGRADATION
// ---------------------------------------------------------------------------

test('HTTP API enforces stale-patch 409 rejection, append-only audit routes, API key auth, and graceful Neo4j/Gemini degradation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_http_test_'));
  const auditPath = path.join(tmpDir, 'audit.ndjson');
  const prevApiKey = process.env.AUTOPATCH_API_KEY;
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevGraphEnabled = process.env.GRAPHRAG_ENABLED;

  const srv = await startTestServer(auditPath);
  try {
    // A. Stale patch rejection (HTTP 409 Conflict)
    const origCode = 'def add(a, b):\n    return a - b\n';
    const candCode = 'def add(a, b):\n    return a + b\n';
    const testCode = 'from math_mod import add\ndef test_add():\n    assert add(2, 3) == 5\n';
    const wrongHash = computeContentSha256('completely different source');
    const rightHash = computeContentSha256(origCode);

    const staleRes = await fetch(`${srv.baseUrl}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'math_mod.py',
        originalCode: origCode,
        candidateCode: candCode,
        testCode,
        expectedOriginalHash: wrongHash,
      }),
    });
    assert.equal(staleRes.status, 409);
    const staleBody = (await staleRes.json()) as { code: string };
    assert.equal(staleBody.code, 'STALE_PATCH_CONFLICT');

    // B. Valid expectedOriginalHash succeeds & appends to hash-chained audit ledger
    const validRes = await fetch(`${srv.baseUrl}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'math_mod.py',
        originalCode: origCode,
        candidateCode: candCode,
        testCode,
        expectedOriginalHash: rightHash,
        developerApproval: { approved: true, approver: 'qa-bot' },
      }),
    });
    assert.equal(validRes.status, 200);
    const validBody = (await validRes.json()) as {
      verificationStatus: string;
      originalSourceHash: string;
    };
    assert.equal(validBody.verificationStatus, 'RUNTIME_VERIFIED');
    assert.equal(validBody.originalSourceHash, rightHash);

    const auditListRes = await fetch(`${srv.baseUrl}/api/audit`);
    assert.equal(auditListRes.status, 200);
    const auditBody = (await auditListRes.json()) as {
      mode: string;
      chainValid: boolean;
      totalRecords: number;
      entries: Array<{ id: string }>;
    };
    assert.equal(auditBody.mode, 'backend-append-only');
    assert.equal(auditBody.chainValid, true);
    assert.ok(auditBody.totalRecords >= 1);

    const singleAuditRes = await fetch(`${srv.baseUrl}/api/audit/${auditBody.entries[0].id}`);
    assert.equal(singleAuditRes.status, 200);

    // C. Missing GEMINI_API_KEY on POST /api/autopatch returns clean 503 MISSING_GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY;
    const apRes = await fetch(`${srv.baseUrl}/api/autopatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceCode: origCode, filename: 'math_mod.py' }),
    });
    assert.equal(apRes.status, 503);
    const apBody = (await apRes.json()) as { code: string };
    assert.equal(apBody.code, 'MISSING_GEMINI_API_KEY');

    // D. Disabled GraphRAG returns clean 503 GRAPHRAG_UNAVAILABLE while /api/health still succeeds
    process.env.GRAPHRAG_ENABLED = 'false';
    const disabledAsk = await fetch(`${srv.baseUrl}/api/graphrag/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core', question: 'test?' }),
    });
    assert.equal(disabledAsk.status, 503);

    // E. Request validation rejects invalid projectId, invalid entityId, empty queries, and oversized request (413)
    process.env.GRAPHRAG_ENABLED = 'true';
    const badProj = await fetch(`${srv.baseUrl}/api/graphrag/status/..%2Fevil`);
    assert.equal(badProj.status, 400);

    const badEntity = await fetch(`${srv.baseUrl}/api/graphrag/impact-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core', targetId: 'bad\x00id' }),
    });
    assert.equal(badEntity.status, 400);

    const badRootCause = await fetch(`${srv.baseUrl}/api/graphrag/root-cause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core' }),
    });
    assert.equal(badRootCause.status, 400);

    const badHist = await fetch(`${srv.baseUrl}/api/graphrag/historical-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core', query: '   ' }),
    });
    assert.equal(badHist.status, 400);

    const badGraphProj = await fetch(`${srv.baseUrl}/api/graphrag/graph/..%2Fevil`);
    assert.equal(badGraphProj.status, 400);

    const oversized = await fetch(`${srv.baseUrl}/api/graphrag/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core', question: 'x'.repeat(350_000) }),
    });
    assert.equal(oversized.status, 413);

    // F. Optional API key authentication (401 without key, 403 wrong key, 200 valid key, /api/health open)
    process.env.AUTOPATCH_API_KEY = 'test-secret-api-token-xyz';
    const openHealth = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(openHealth.status, 200);

    const noAuth = await fetch(`${srv.baseUrl}/api/audit`);
    assert.equal(noAuth.status, 401);

    const wrongAuth = await fetch(`${srv.baseUrl}/api/audit`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrongAuth.status, 403);

    const goodAuth = await fetch(`${srv.baseUrl}/api/audit`, {
      headers: { Authorization: 'Bearer test-secret-api-token-xyz' },
    });
    assert.equal(goodAuth.status, 200);
  } finally {
    if (prevApiKey === undefined) delete process.env.AUTOPATCH_API_KEY;
    else process.env.AUTOPATCH_API_KEY = prevApiKey;
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevGraphEnabled === undefined) delete process.env.GRAPHRAG_ENABLED;
    else process.env.GRAPHRAG_ENABLED = prevGraphEnabled;
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. LIVE NEO4J AURADB INTEGRATION: DUPLICATE/INCREMENTAL INGESTION & ISOLATION
// ---------------------------------------------------------------------------

test('Live Neo4j AuraDB enforces idempotent duplicate ingestion, incremental updates, and strict project isolation', async (t) => {
  const cfg = loadAppEnvConfig().neo4j;
  if (!cfg.enabled || !cfg.configured) {
    t.skip('Neo4j credentials not configured in environment.');
    return;
  }

  const health = await verifyNeo4jConnection();
  assert.equal(health.connected, true, `Neo4j AuraDB connection failed: ${health.error || ''}`);

  const schema = await initializeGraphSchema();
  assert.equal(schema.ok, true, `Schema init errors: ${schema.errors.join('; ')}`);

  const tmpDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_neo4j_projA_'));
  const tmpDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_neo4j_projB_'));
  const projA = `test-iso-a-${Date.now()}`;
  const projB = `test-iso-b-${Date.now()}`;

  try {
    await fs.writeFile(
      path.join(tmpDirA, 'alpha_service.ts'),
      `export function alphaHelper(x: number) { return x + 1; }\nexport function alphaEntry(v: number) { return alphaHelper(v); }\n`,
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDirB, 'beta_service.ts'),
      `export function betaSecretWorkflow(x: number) { return x * 2; }\n`,
      'utf-8'
    );

    // First ingestion for projA (without embeddings to test pure Neo4j graph idempotency fast)
    const first = await ingestRepositoryToGraph({
      projectId: projA,
      rootDir: tmpDirA,
      includeEmbeddings: false,
    });
    assert.equal(first.status, 'COMPLETED');
    assert.equal(first.filesProcessed, 1);
    assert.ok((first.persistedCounts?.totalNodes ?? 0) >= 3);

    // Duplicate ingestion of identical files must skip unchanged & NOT create duplicate nodes
    const second = await ingestRepositoryToGraph({
      projectId: projA,
      rootDir: tmpDirA,
      includeEmbeddings: false,
    });
    assert.equal(second.filesSkippedUnchanged, 1);
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.persistedCounts?.totalNodes, first.persistedCounts?.totalNodes);

    // Ingest projB and verify strict project isolation in hybrid retrieval
    const ingestB = await ingestRepositoryToGraph({
      projectId: projB,
      rootDir: tmpDirB,
      includeEmbeddings: false,
    });
    assert.equal(ingestB.status, 'COMPLETED');

    const crossSearch = await hybridRetrieve({
      projectId: projA,
      query: 'betaSecretWorkflow',
      deps: { embedQuery: async () => null },
    });
    assert.equal(
      crossSearch.entities.some((e) => e.name === 'betaSecretWorkflow'),
      false,
      'Project A retrieval must NEVER return Project B nodes'
    );

    // Verify impact analysis traverses real CALLS edge alphaEntry -> alphaHelper in projA
    const impact = await analyzeEntityImpact({
      projectId: projA,
      targetType: 'Function',
      targetId: 'alphaHelper',
      maxDepth: 2,
    });
    assert.equal(impact.found, true);
    assert.ok(
      impact.directGraphConnections.directCallers.some((c) => c.name === 'alphaEntry'),
      'Impact analysis must detect real CALLS edge from alphaEntry to alphaHelper'
    );

    // Incremental update: modify alpha_service.ts + add a second file + malformed syntax file
    await fs.writeFile(
      path.join(tmpDirA, 'alpha_service.ts'),
      `export function alphaHelper(x: number) { return x + 2; }\nexport function alphaEntry(v: number) { return alphaHelper(v); }\nexport function alphaAdded(v: number) { return alphaHelper(v); }\n`,
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDirA, 'temp_obsolete.ts'),
      `export function obsoleteFn() { return 42; }\n`,
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDirA, 'broken_syntax.ts'),
      `export function broken( { return ;;;\n`,
      'utf-8'
    );
    const inc = await ingestRepositoryToGraph({
      projectId: projA,
      rootDir: tmpDirA,
      includeEmbeddings: false,
    });
    assert.ok(inc.filesProcessed >= 2);
    const countsWithObsolete = await getProjectGraphCounts(projA);
    assert.ok((countsWithObsolete.byLabel.Function ?? 0) >= 4);

    // Deleted source file pruning: delete temp_obsolete.ts and verify stale File & Function are pruned
    await fs.unlink(path.join(tmpDirA, 'temp_obsolete.ts'));
    await ingestRepositoryToGraph({
      projectId: projA,
      rootDir: tmpDirA,
      includeEmbeddings: false,
    });
    const afterDelete = await hybridRetrieve({
      projectId: projA,
      query: 'obsoleteFn',
      maxDepth: 99, // Verify excessive traversal depth is clamped safely
      deps: { embedQuery: async () => null },
    });
    assert.equal(
      afterDelete.entities.some((e) => e.name === 'obsoleteFn'),
      false,
      'Deleted source file functions must be pruned from Neo4j'
    );
  } finally {
    // Clean up only the ephemeral test projects from AuraDB (never touch autopatch-core!)
    await runWriteQuery(
      `MATCH (n) WHERE n.projectId IN [$projA, $projB] OR n.id IN [$pNodeA, $pNodeB] DETACH DELETE n`,
      { projA, projB, pNodeA: `project:${projA}`, pNodeB: `project:${projB}` }
    ).catch(() => {});
    await closeNeo4jDriver().catch(() => {});
    await fs.rm(tmpDirA, { recursive: true, force: true });
    await fs.rm(tmpDirB, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. SECURITY HARDENING: SYMLINK ESCAPE, AUDIT CORRUPTION, URI REDACTION
// ---------------------------------------------------------------------------

test('discoverRepositoryFiles and extractSourceFile block symlink escapes and path traversal', async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_sym_repo_'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_sym_outside_'));
  try {
    await fs.writeFile(path.join(outsideDir, 'secret_leak.py'), 'SECRET = "top_secret_123"\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'legit.py'), 'def ok():\n    return 1\n', 'utf-8');
    await fs.symlink(path.join(outsideDir, 'secret_leak.py'), path.join(repoDir, 'escaped.py'));

    const files = await discoverRepositoryFiles(repoDir, 50);
    assert.deepEqual(files, ['legit.py']);

    await assert.rejects(() => extractSourceFile('sec-proj', repoDir, 'escaped.py'));
    await assert.rejects(() => extractSourceFile('sec-proj', repoDir, '../outside.py'));
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('AppendOnlyFileAuditStore detects tampering in approval/diff fields and corrupted NDJSON lines', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_audit_sec_'));
  const logPath = path.join(tmpDir, 'audit.ndjson');
  try {
    const store = new AppendOnlyFileAuditStore(logPath);
    await store.append({
      id: 'sec-1',
      timestamp: '2026-11-19T00:00:00.000Z',
      projectId: 'proj-sec',
      filename: 'auth.py',
      line: 10,
      bugType: 'SqlInjectionRisk',
      ruleId: 'SQL_PARAM',
      confidence: 95,
      baselinePassed: 0,
      baselineTotal: 2,
      sandboxPassed: 2,
      sandboxTotal: 2,
      linesAdded: 1,
      linesRemoved: 1,
      sandboxVerdict: 'verified',
      verificationStatus: 'RUNTIME_VERIFIED',
      decision: 'accepted',
      patchDiff: '- bad\n+ good',
      developerApproval: {
        approved: true,
        approver: 'lead-dev',
        recordedAt: '2026-11-19T00:00:00.000Z',
      },
      summary: 'Parameterized SQL query.',
    });

    const cleanVerify = await store.verifyChain();
    assert.equal(cleanVerify.valid, true);

    // Tamper with sandboxPassed (previously unhashed)
    const origRaw = await fs.readFile(logPath, 'utf-8');
    await fs.writeFile(logPath, origRaw.replace('"sandboxPassed":2', '"sandboxPassed":99'), 'utf-8');
    const tamperedVerify = await new AppendOnlyFileAuditStore(logPath).verifyChain();
    assert.equal(tamperedVerify.valid, false);
    assert.equal(tamperedVerify.brokenAtIndex, 0);

    // Inject corrupted NDJSON line at end
    await fs.writeFile(logPath, `${origRaw}{corrupted json line\n`, 'utf-8');
    const corruptVerify = await new AppendOnlyFileAuditStore(logPath).verifyChain();
    assert.equal(corruptVerify.valid, false);
    assert.equal(corruptVerify.brokenAtIndex, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('redactSecrets masks Neo4j URI credentials and rejects invalid GraphRAG parameter types with 400', async () => {
  const red = redactSecrets('Failed connecting neo4j+s://neo4j:mySecretPass@726bbfa1.databases.neo4j.io using x-api-key=secret_token_99');
  assert.equal(red.includes('mySecretPass'), false);
  assert.equal(red.includes('secret_token_99'), false);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopatch_http_sec_'));
  const srv = await startTestServer(path.join(tmpDir, 'audit.ndjson'));
  try {
    const badTargetType = await fetch(`${srv.baseUrl}/api/graphrag/impact-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core', targetId: 'fn1', targetType: 'DROP_ALL' }),
    });
    assert.equal(badTargetType.status, 400);

    const badDepth = await fetch(`${srv.baseUrl}/api/graphrag/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'autopatch-core', question: 'where?', maxDepth: 'deep' }),
    });
    assert.equal(badDepth.status, 400);
  } finally {
    await srv.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

