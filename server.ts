import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppendOnlyFileAuditStore,
  computeContentSha256,
} from './engine/audit_store.ts';
import {
  loadAppEnvConfig,
  redactSecrets,
  validateStartupConfig,
} from './engine/env_config.ts';
import {
  runGeminiAutoPatchWorkflow,
  runGeminiLatestBugScan,
  transcribeVoiceNote,
} from './engine/gemini_bug_scanner.ts';
import {
  getProjectIngestionStatus,
  ingestRepositoryToGraph,
  recordAnalysisResultInGraph,
} from './engine/graphrag/ingestion_service.ts';
import {
  analyzeEntityImpact,
  answerGraphQuestion,
  getGraphRagPatchContext,
  investigateRootCause,
  searchHistoricalBugs,
} from './engine/graphrag/intelligence_service.ts';
import {
  closeNeo4jDriver,
  verifyNeo4jConnection,
} from './engine/graphrag/neo4j_client.ts';
import {
  getProjectEntityDetails,
  getProjectSubgraph,
} from './engine/graphrag/retrieval_service.ts';
import { runMultiLangAnalysis } from './engine/multi_lang_engine.ts';
import {
  executionSemaphore,
  getSandboxIsolationInfo,
  loadSandboxConfig,
} from './engine/sandbox_runner.ts';
import {
  apiKeyAuthMiddleware,
  getClientIp,
  loadSecurityLimits,
  logStructured,
  requestIdMiddleware,
  sanitizeSingleLineText,
  ServerAnalysisStore,
  SlidingWindowRateLimiter,
  validateAndResolveLanguage,
  validateEntityId,
  validateProjectId,
  validateSafeAuditId,
  validateSafeFilename,
  validateTargetLine,
  validateTimeoutSeconds,
} from './engine/server_security.ts';
import type { AnalysisResponse, TestRunResult } from './src/types/autopatch.ts';
import {
  adaptDeterministicAnalysisToReport,
  mergeAutoPatchReports,
} from './src/utils/autopatchWorkflow.ts';
import {
  EXECUTABLE_SANDBOX_LANGUAGES,
  SUPPORTED_LANGUAGES,
} from './src/utils/languageDetect.ts';
import { buildUnifiedFindings } from './src/utils/unifiedFindings.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENGINE_PATH = path.resolve(__dirname, 'engine', 'autopatch_engine.py');
const PORT = loadAppEnvConfig().port;

interface EnginePayload {
  action: 'analyze' | 'validate';
  filename: string;
  testFilename: string;
  sourceCode?: string;
  originalCode?: string;
  candidateCode?: string;
  testCode: string;
  bugContext?: string;
  timeoutSeconds?: number;
  _trustedServerBaseline?: TestRunResult | null;
  targetLine?: number | null;
  bugType?: string;
  rootCause?: string;
}

export interface CreateAppOptions {
  auditLogPath?: string;
  repoRootDir?: string;
  enableGraphWriteBack?: boolean;
}

/**
 * Invokes the local Python AST/SBFL/APR orchestrator with a minimal environment
 * (NEVER forwarding GEMINI_API_KEY, NEO4J_PASSWORD, AUTOPATCH_API_KEY, or host secrets),
 * bounded output cap, concurrency throttling, and process-group SIGKILL on timeout.
 */
async function runPythonEngine(payload: EnginePayload): Promise<AnalysisResponse> {
  const cfg = loadSandboxConfig();
  const acquired = await executionSemaphore.acquire(cfg.maxConcurrentExecutions, 5000);
  if (!acquired) {
    const err = new Error('Analysis execution capacity temporarily saturated. Please retry shortly.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 503;
    throw err;
  }

  try {
    return await new Promise<AnalysisResponse>((resolve, reject) => {
      // Forward only non-secret sandbox tuning knobs and minimal PATH
      const cleanEnv: Record<string, string> = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      };
      for (const k of [
        'SANDBOX_ALLOW_UNTRUSTED_EXEC',
        'SANDBOX_MEMORY_MB',
        'SANDBOX_CPU_SECONDS',
        'SANDBOX_MAX_OUTPUT_BYTES',
        'SANDBOX_MAX_FILE_BYTES',
        'SANDBOX_MAX_OPEN_FILES',
        'SANDBOX_MAX_PROCESSES',
      ]) {
        if (process.env[k] !== undefined) cleanEnv[k] = String(process.env[k]);
      }

      const child = spawn('python3', [ENGINE_PATH], {
        env: cleanEnv,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const maxEngineOut = 32 * 1024 * 1024;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const killTree = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree();
        reject(new Error('Python analysis engine exceeded wall-clock budget.'));
      }, 90000);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes + chunk.length <= maxEngineOut) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else if (!settled) {
          settled = true;
          clearTimeout(timer);
          killTree();
          reject(new Error('Python analysis engine output exceeded buffer limit.'));
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < 65536) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Python engine spawn error: ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        if (code !== 0) {
          reject(new Error(stderr ? 'Python analysis engine returned an error.' : 'Python engine failed.'));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as AnalysisResponse;
          resolve({ ...parsed, language: 'python' });
        } catch {
          reject(new Error('Invalid JSON output returned by Python analysis engine.'));
        }
      });

      child.stdin?.on('error', () => {});
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  } finally {
    executionSemaphore.release();
  }
}

async function fetchBestEffortGraphContext(params: {
  projectId: string;
  filename: string;
  sourceCode: string;
  bugContext?: string;
}): Promise<{ promptContext: string; summary?: AnalysisResponse['graphRagContext'] }> {
  const cfg = loadAppEnvConfig().neo4j;
  if (!cfg.enabled || !cfg.configured) return { promptContext: '' };

  try {
    const ctx = await Promise.race([
      getGraphRagPatchContext(params),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!ctx || !ctx.available || ctx.entityCount === 0) {
      return { promptContext: '' };
    }
    return {
      promptContext: ctx.promptContext,
      summary: {
        used: true,
        projectId: ctx.projectId,
        relatedEntitiesCount: ctx.entityCount,
        summary: `Retrieved ${ctx.entityCount} GraphRAG entities (${ctx.relatedFindingsCount} findings, ${ctx.relatedPatchesCount} patches; advisory only).`,
      },
    };
  } catch {
    return { promptContext: '' };
  }
}

function summarizeDeterministicAnalysis(det: AnalysisResponse): string {
  const parts: string[] = [];
  if (det.baseline) {
    parts.push(
      `Baseline Sandbox: ${det.baseline.passed}/${det.baseline.total} passed` +
        (det.baseline.errorType ? ` (${det.baseline.errorType}: ${det.baseline.errorMessage || ''})` : '')
    );
    if (det.baseline.traceback) {
      parts.push(`Baseline Traceback:\n${det.baseline.traceback.slice(0, 1500)}`);
    }
  }
  const findings = det.astReport?.findings ?? [];
  if (findings.length > 0) {
    parts.push(
      'AST / Static Findings:\n' +
        findings
          .slice(0, 20)
          .map(
            (f) =>
              `- Line ${f.line} [${f.severity}/${f.category ?? 'static'}] ${f.kind}: ${f.message}`
          )
          .join('\n')
    );
  }
  if (det.patchInfo?.rootCause) {
    parts.push(
      `Deterministic Engine Finding (${det.patchInfo.strategy}): ${det.patchInfo.rootCause}`
    );
  }
  return parts.join('\n\n');
}

export function createAutoPatchApp(options: CreateAppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);

  // iFrame-compatible security headers (never set X-Frame-Options: DENY/SAMEORIGIN so AI Studio preview iframe works)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  const appCfg = loadAppEnvConfig();
  const limits = loadSecurityLimits();
  const rateLimiter = new SlidingWindowRateLimiter(60_000);
  const analysisStore = new ServerAnalysisStore(200, 30 * 60 * 1000);
  const auditStore = new AppendOnlyFileAuditStore(
    options.auditLogPath || path.resolve(__dirname, appCfg.auditLogPath)
  );
  const repoRootDir = path.resolve(options.repoRootDir || __dirname);
  const enableGraphWriteBack = options.enableGraphWriteBack !== false;
  let activeAnalyses = 0;

  // High-capacity JSON parsers so large source files and multi-file workloads execute smoothly
  const standardJsonParser = express.json({ limit: '50mb' });
  const audioJsonParser = express.json({ limit: '50mb' });
  const queryJsonParser = express.json({ limit: '300kb' });

  const checkRateLimit = (
    req: Request,
    res: Response,
    bucket: 'api' | 'ai' | 'transcribe' | 'graphrag',
    maxPerMin: number
  ): boolean => {
    const ip = getClientIp(req);
    const check = rateLimiter.check(`${bucket}:${ip}`, maxPerMin);
    res.setHeader('X-RateLimit-Limit', String(maxPerMin));
    res.setHeader('X-RateLimit-Remaining', String(check.remaining));
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSec));
      res.status(429).json({
        error: 'Too many requests. Please wait before retrying.',
        retryAfterSeconds: check.retryAfterSec,
      });
      return false;
    }
    return true;
  };

  // Optional API-key auth across /api/* when AUTOPATCH_API_KEY is configured (excluding health endpoints)
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/graphrag/health') {
      next();
      return;
    }
    apiKeyAuthMiddleware(req, res, next);
  });

  // Require application/json Content-Type on mutating API requests to prevent simple form/CORS CSRF posts
  app.post('/api/*', (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json.' });
      return;
    }
    next();
  });

  // ---------------------------------------------------------------------------
  // HEALTH & DIAGNOSTICS
  // ---------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    const envCfg = loadAppEnvConfig();
    const isolation = getSandboxIsolationInfo();
    const cfg = loadSandboxConfig();
    const executable = Array.from(EXECUTABLE_SANDBOX_LANGUAGES);
    const staticOnly = SUPPORTED_LANGUAGES.filter((l) => l.executionMode !== 'sandbox-runtime').map(
      (l) => l.id
    );

    res.json({
      ok: true,
      engine: 'autopatch-hardened-backend',
      sandbox: {
        level: isolation.level,
        isolatedUser: isolation.isolatedUser,
        networkIsolated: isolation.networkIsolated,
        pidIsolated: isolation.pidIsolated,
        activeExecutions: executionSemaphore.getActiveCount(),
        maxConcurrentExecutions: cfg.maxConcurrentExecutions,
        activeAnalyses,
        maxConcurrentAnalyses: limits.maxConcurrentAnalyses,
        limitations: isolation.limitations,
      },
      languages: {
        executableSandbox: executable,
        staticHeuristicOnly: staticOnly,
        runtimeVerified: executable,
        compileVerified: ['c', 'cpp', 'typescript'],
        staticOnly,
      },
      aiConfigured: envCfg.gemini.configured,
      geminiConfigured: envCfg.gemini.configured,
      geminiModel: envCfg.gemini.model,
      graphrag: {
        enabled: envCfg.neo4j.enabled,
        configured: envCfg.neo4j.configured,
        database: envCfg.neo4j.database,
        instanceId: envCfg.neo4j.instanceId,
      },
      auditStorageMode: auditStore.mode,
      apiKeyAuthEnabled: Boolean(envCfg.apiKeyAuthToken),
    });
  });

  // ---------------------------------------------------------------------------
  // GEMINI AUTOPATCH WORKFLOW (FRONTEND PRIMARY AI ENDPOINT)
  // ---------------------------------------------------------------------------

  app.post('/api/autopatch', standardJsonParser, async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId || 'unknown';
    const t0 = performance.now();

    if (!checkRateLimit(req, res, 'ai', limits.maxAiRequestsPerMinute)) return;

    const { sourceCode, errorStatement, filename, language, projectId, testCode, testFilename } =
      req.body ?? {};
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
      res.status(400).json({ error: 'sourceCode cannot be empty.' });
      return;
    }
    if (Buffer.byteLength(sourceCode, 'utf-8') > limits.maxSourceSizeBytes) {
      res.status(413).json({
        error: `Source code exceeds maximum size limit (${limits.maxSourceSizeBytes} bytes).`,
      });
      return;
    }
    if (testCode !== undefined && testCode !== null && typeof testCode !== 'string') {
      res.status(400).json({ error: 'testCode must be a string when provided.' });
      return;
    }
    const safeTestCode = typeof testCode === 'string' ? testCode : '';
    if (Buffer.byteLength(safeTestCode, 'utf-8') > limits.maxTestSizeBytes) {
      res.status(413).json({
        error: `Test code exceeds maximum size limit (${limits.maxTestSizeBytes} bytes).`,
      });
      return;
    }
    const safeError = typeof errorStatement === 'string' ? errorStatement : '';
    if (Buffer.byteLength(safeError, 'utf-8') > limits.maxContextSizeBytes) {
      res.status(413).json({
        error: `errorStatement exceeds maximum size limit (${limits.maxContextSizeBytes} bytes).`,
      });
      return;
    }

    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }

    const srcNameCheck = validateSafeFilename(filename, 'snippet.py', 'filename');
    const resolvedFilename = srcNameCheck.ok ? srcNameCheck.filename : 'snippet.py';
    const testNameCheck = validateSafeFilename(
      testFilename,
      `test_${resolvedFilename}`,
      'testFilename'
    );
    const resolvedTestFilename = testNameCheck.ok ? testNameCheck.filename : `test_${resolvedFilename}`;
    const langCheck = validateAndResolveLanguage(language, resolvedFilename);
    const resolvedLang = langCheck.ok ? langCheck.language : 'python';

    try {
      // Preserve fast-fail 503 MISSING_GEMINI_API_KEY contract when Gemini key is absent
      if (!loadAppEnvConfig().gemini.configured) {
        await runGeminiAutoPatchWorkflow({
          sourceCode,
          errorStatement: safeError,
          filename: resolvedFilename,
          language: resolvedLang,
        });
      }

      const graphCtxPromise = fetchBestEffortGraphContext({
        projectId: projCheck.projectId,
        filename: resolvedFilename,
        sourceCode,
        bugContext: safeError,
      });

      // Kick off fast deterministic AST + sandbox precheck in parallel to ground Gemini on tough bugs
      const detPromise: Promise<AnalysisResponse | null> = (
        resolvedLang === 'python'
          ? runPythonEngine({
              action: 'analyze',
              filename: resolvedFilename,
              testFilename: resolvedTestFilename,
              sourceCode,
              testCode: safeTestCode,
              bugContext: safeError,
              timeoutSeconds: 2.0,
            })
          : runMultiLangAnalysis({
              action: 'analyze',
              language: resolvedLang,
              filename: resolvedFilename,
              testFilename: resolvedTestFilename,
              sourceCode,
              testCode: safeTestCode,
              bugContext: safeError,
              timeoutSeconds: 2.0,
            })
      ).catch(() => null);

      const [graphCtx, quickDet] = await Promise.all([
        graphCtxPromise,
        Promise.race([
          detPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 650)),
        ]),
      ]);

      const deterministicSummary = quickDet ? summarizeDeterministicAnalysis(quickDet) : undefined;

      let report = await runGeminiAutoPatchWorkflow({
        sourceCode,
        errorStatement: safeError,
        filename: resolvedFilename,
        language: resolvedLang,
        graphRagContext: graphCtx.promptContext || undefined,
        deterministicSummary,
      });

      const finalDet =
        quickDet ??
        (await Promise.race([
          detPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 150)),
        ]));
      if (finalDet) {
        const detReport = adaptDeterministicAnalysisToReport(finalDet);
        report = mergeAutoPatchReports(report, detReport);
      }

      logStructured('info', 'api.autopatch', {
        requestId,
        language: report.detected_language,
        bugsCount: report.bugs.length,
        graphContextUsed: Boolean(graphCtx.promptContext),
        deterministicMerged: Boolean(finalDet),
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });

      res.json(report);
    } catch (err) {
      const typedErr = err as Error & { statusCode?: number; code?: string };
      const status = typedErr.statusCode || 500;
      const code = typedErr.code || (status === 503 ? 'MISSING_GEMINI_API_KEY' : 'AUTOPATCH_ERROR');
      logStructured(status >= 500 ? 'error' : 'warn', 'api.autopatch.failed', {
        requestId,
        status,
        code,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });
      res.status(status).json({
        error:
          status >= 500 && status !== 502 && status !== 503
            ? 'AutoPatch AI workflow failed.'
            : redactSecrets(typedErr.message || 'AutoPatch AI workflow failed.'),
        code,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // VOICE NOTE TRANSCRIPTION
  // ---------------------------------------------------------------------------

  app.post('/api/transcribe-note', audioJsonParser, async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId || 'unknown';
    const t0 = performance.now();

    if (!checkRateLimit(req, res, 'transcribe', limits.maxAiRequestsPerMinute)) return;

    const { audioDataUrl, mimeType, bugContext } = req.body ?? {};
    if (typeof audioDataUrl !== 'string' || !/^data:[^;,]+;base64,/i.test(audioDataUrl)) {
      res.status(400).json({ error: 'Valid base64 audio data URL is required.' });
      return;
    }
    if (bugContext !== undefined && bugContext !== null && typeof bugContext !== 'string') {
      res.status(400).json({ error: 'bugContext must be a string when provided.' });
      return;
    }

    const headerPart = audioDataUrl.slice(0, audioDataUrl.indexOf(','));
    const dataUrlMime = headerPart.match(/^data:([^;,]+)/i)?.[1];
    const resolvedMime =
      typeof mimeType === 'string' && mimeType.trim()
        ? mimeType.trim()
        : dataUrlMime || 'audio/webm';

    const base64Data = audioDataUrl.slice(audioDataUrl.indexOf(',') + 1).trim();
    if (!base64Data) {
      res.status(400).json({ error: 'Audio recording payload is empty.' });
      return;
    }

    try {
      const result = await transcribeVoiceNote({
        audioBase64: base64Data,
        mimeType: resolvedMime,
        bugContext: typeof bugContext === 'string' ? sanitizeSingleLineText(bugContext, 400) : undefined,
        maxAudioSizeBytes: limits.maxAudioSizeBytes,
      });
      logStructured('info', 'api.transcribe_note', {
        requestId,
        status: 200,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });
      res.json(result);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode || 500;
      const safeMessage =
        status >= 500
          ? 'Unable to transcribe voice note right now.'
          : err instanceof Error
          ? err.message
          : 'Invalid audio payload.';
      logStructured(status >= 500 ? 'error' : 'warn', 'api.transcribe_note.failed', {
        requestId,
        status,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });
      res.status(status).json({ error: safeMessage });
    }
  });

  // ---------------------------------------------------------------------------
  // DETERMINISTIC ANALYSIS & SANDBOX VALIDATION
  // ---------------------------------------------------------------------------

  app.post('/api/analyze', standardJsonParser, async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId || 'unknown';
    const t0 = performance.now();

    if (!checkRateLimit(req, res, 'api', limits.maxRequestsPerMinute)) return;

    const {
      filename,
      testFilename,
      sourceCode,
      testCode,
      bugContext,
      language,
      includeAiScan,
      timeoutSeconds,
      projectId,
    } = req.body ?? {};

    if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
      res.status(400).json({ error: 'Source file cannot be empty.' });
      return;
    }
    if (Buffer.byteLength(sourceCode, 'utf-8') > limits.maxSourceSizeBytes) {
      res.status(413).json({
        error: `Source file exceeds maximum size limit (${limits.maxSourceSizeBytes} bytes).`,
      });
      return;
    }
    if (testCode !== undefined && typeof testCode !== 'string') {
      res.status(400).json({ error: 'testCode must be a string when provided.' });
      return;
    }
    const safeTestCode = typeof testCode === 'string' ? testCode : '';
    if (Buffer.byteLength(safeTestCode, 'utf-8') > limits.maxTestSizeBytes) {
      res.status(413).json({
        error: `Test file exceeds maximum size limit (${limits.maxTestSizeBytes} bytes).`,
      });
      return;
    }
    const safeBugContext = typeof bugContext === 'string' ? bugContext : '';
    if (Buffer.byteLength(safeBugContext, 'utf-8') > limits.maxContextSizeBytes) {
      res.status(413).json({
        error: `Bug context exceeds maximum size limit (${limits.maxContextSizeBytes} bytes).`,
      });
      return;
    }

    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }

    const srcNameCheck = validateSafeFilename(filename, 'module.py', 'filename');
    if (!srcNameCheck.ok) {
      res.status(400).json({ error: srcNameCheck.error });
      return;
    }
    const testNameCheck = validateSafeFilename(
      testFilename,
      `test_${srcNameCheck.filename}`,
      'testFilename'
    );
    if (!testNameCheck.ok) {
      res.status(400).json({ error: testNameCheck.error });
      return;
    }

    const langCheck = validateAndResolveLanguage(language, srcNameCheck.filename);
    if (!langCheck.ok) {
      res.status(400).json({ error: langCheck.error });
      return;
    }

    const resolvedLang = langCheck.language;
    const clampedTimeout = validateTimeoutSeconds(timeoutSeconds, 2.0);
    const enableAi = includeAiScan !== false;

    if (activeAnalyses >= limits.maxConcurrentAnalyses) {
      res.setHeader('Retry-After', '2');
      res.status(503).json({
        error: 'Server is at maximum concurrent analysis capacity. Please retry shortly.',
      });
      return;
    }

    activeAnalyses++;
    try {
      const deterministicPromise: Promise<AnalysisResponse> =
        resolvedLang === 'python'
          ? runPythonEngine({
              action: 'analyze',
              filename: srcNameCheck.filename,
              testFilename: testNameCheck.filename,
              sourceCode,
              testCode: safeTestCode,
              bugContext: safeBugContext,
              timeoutSeconds: clampedTimeout,
            })
          : runMultiLangAnalysis({
              action: 'analyze',
              language: resolvedLang,
              filename: srcNameCheck.filename,
              testFilename: testNameCheck.filename,
              sourceCode,
              testCode: safeTestCode,
              bugContext: safeBugContext,
              timeoutSeconds: clampedTimeout,
            });

      const graphCtxPromise = enableAi
        ? fetchBestEffortGraphContext({
            projectId: projCheck.projectId,
            filename: srcNameCheck.filename,
            sourceCode,
            bugContext: safeBugContext,
          })
        : Promise.resolve({ promptContext: '' as string, summary: undefined });

      let aiPromise: Promise<{
        findings: ReturnType<typeof buildUnifiedFindings>;
        aiScanStatus: NonNullable<AnalysisResponse['aiScanStatus']>;
      }>;
      if (!enableAi) {
        aiPromise = Promise.resolve({
          findings: [],
          aiScanStatus: {
            status: 'skipped',
            findingsCount: 0,
            message: 'AI scan bypassed for deterministic-only run.',
          },
        });
      } else {
        const aiRateCheck = rateLimiter.check(`ai:${getClientIp(req)}`, limits.maxAiRequestsPerMinute);
        if (!aiRateCheck.allowed) {
          aiPromise = Promise.resolve({
            findings: [],
            aiScanStatus: {
              status: 'skipped',
              findingsCount: 0,
              message: 'AI scan rate-limited for this client; showing deterministic analysis only.',
            },
          });
        } else {
          aiPromise = graphCtxPromise.then((gCtx) =>
            runGeminiLatestBugScan({
              filename: srcNameCheck.filename,
              language: resolvedLang,
              sourceCode,
              bugContext: safeBugContext,
              graphRagContext: gCtx.promptContext || undefined,
            })
          );
        }
      }

      const [detResult, aiResult, graphCtx] = await Promise.all([
        deterministicPromise,
        aiPromise,
        graphCtxPromise,
      ]);

      const originalSourceHash =
        detResult.originalSourceHash || computeContentSha256(sourceCode);

      const analysisId = analysisStore.save({
        originalCode: sourceCode,
        testCode: safeTestCode,
        filename: srcNameCheck.filename,
        testFilename: testNameCheck.filename,
        language: resolvedLang,
        baseline: detResult.baseline,
      });

      const unifiedFindings = buildUnifiedFindings(detResult, aiResult.findings);

      const enrichedResponse: AnalysisResponse = {
        ...detResult,
        analysisId,
        originalSourceHash,
        unifiedFindings,
        aiScanStatus: aiResult.aiScanStatus,
        auditStorageMode: auditStore.mode,
        ...(graphCtx.summary ? { graphRagContext: graphCtx.summary } : {}),
      };

      // Best-effort fire-and-forget Neo4j graph recording
      if (enableGraphWriteBack) {
        recordAnalysisResultInGraph({
          projectId: projCheck.projectId,
          analysis: enrichedResponse,
        }).catch(() => {});
      }

      logStructured('info', 'api.analyze', {
        requestId,
        language: resolvedLang,
        verificationMode: detResult.verificationMode,
        verificationStatus: detResult.verificationStatus,
        trustVerdict: detResult.trustVerdict,
        aiStatus: aiResult.aiScanStatus.status,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });

      res.json(enrichedResponse);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode || 500;
      logStructured('error', 'api.analyze.failed', {
        requestId,
        language: resolvedLang,
        status,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });
      res.status(status).json({
        error:
          status === 503
            ? 'Analysis engine is temporarily at capacity. Please retry shortly.'
            : 'Failed to run AutoPatch analysis engine.',
      });
    } finally {
      activeAnalyses = Math.max(0, activeAnalyses - 1);
    }
  });

  app.post('/api/validate', standardJsonParser, async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId || 'unknown';
    const t0 = performance.now();

    if (!checkRateLimit(req, res, 'api', limits.maxRequestsPerMinute)) return;

    const {
      analysisId,
      expectedOriginalHash,
      filename,
      testFilename,
      language,
      originalCode,
      candidateCode,
      testCode,
      targetLine,
      bugType,
      rootCause,
      timeoutSeconds,
      projectId,
      developerApproval,
    } = req.body ?? {};
    // NOTE: Any client-supplied `baseline`, `confidence`, `sbfl`, or `trustVerdict` in req.body
    // is intentionally IGNORED to prevent baseline forgery.

    if (typeof candidateCode !== 'string' || !candidateCode.trim()) {
      res.status(400).json({ error: 'Candidate patch code cannot be empty.' });
      return;
    }
    const safeOriginal = typeof originalCode === 'string' ? originalCode : candidateCode;
    const safeTestCode = typeof testCode === 'string' ? testCode : '';

    if (
      Buffer.byteLength(candidateCode, 'utf-8') > limits.maxSourceSizeBytes ||
      Buffer.byteLength(safeOriginal, 'utf-8') > limits.maxSourceSizeBytes
    ) {
      res.status(413).json({
        error: `Source/candidate code exceeds maximum size limit (${limits.maxSourceSizeBytes} bytes).`,
      });
      return;
    }
    if (Buffer.byteLength(safeTestCode, 'utf-8') > limits.maxTestSizeBytes) {
      res.status(413).json({
        error: `Test file exceeds maximum size limit (${limits.maxTestSizeBytes} bytes).`,
      });
      return;
    }

    // PHASE 5 — STALE PATCH PROTECTION (HTTP 409 Conflict)
    const actualOriginalHash = computeContentSha256(safeOriginal);
    if (expectedOriginalHash !== undefined && expectedOriginalHash !== null && expectedOriginalHash !== '') {
      if (
        typeof expectedOriginalHash !== 'string' ||
        !/^[a-fA-F0-9]{64}$/.test(expectedOriginalHash.trim())
      ) {
        res.status(400).json({
          error: 'expectedOriginalHash must be a valid 64-character SHA-256 hex digest.',
        });
        return;
      }
      if (expectedOriginalHash.trim().toLowerCase() !== actualOriginalHash) {
        logStructured('warn', 'api.validate.stale_patch_conflict', {
          requestId,
          filename: typeof filename === 'string' ? filename : 'unknown',
        });
        res.status(409).json({
          error:
            'Stale patch rejected: current source hash does not match expectedOriginalHash. Re-run analysis against the latest source before applying.',
          code: 'STALE_PATCH_CONFLICT',
          expectedOriginalHash: expectedOriginalHash.trim().toLowerCase(),
          actualOriginalHash,
        });
        return;
      }
    }

    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }

    const srcNameCheck = validateSafeFilename(filename, 'module.py', 'filename');
    if (!srcNameCheck.ok) {
      res.status(400).json({ error: srcNameCheck.error });
      return;
    }
    const testNameCheck = validateSafeFilename(
      testFilename,
      `test_${srcNameCheck.filename}`,
      'testFilename'
    );
    if (!testNameCheck.ok) {
      res.status(400).json({ error: testNameCheck.error });
      return;
    }

    const langCheck = validateAndResolveLanguage(language, srcNameCheck.filename);
    if (!langCheck.ok) {
      res.status(400).json({ error: langCheck.error });
      return;
    }
    const lineCheck = validateTargetLine(targetLine);
    if (!lineCheck.ok) {
      res.status(400).json({ error: lineCheck.error });
      return;
    }

    const resolvedLang = langCheck.language;
    const clampedTimeout = validateTimeoutSeconds(timeoutSeconds, 2.0);

    if (activeAnalyses >= limits.maxConcurrentAnalyses) {
      res.setHeader('Retry-After', '2');
      res.status(503).json({
        error: 'Server is at maximum concurrent validation capacity. Please retry shortly.',
      });
      return;
    }

    // Look up server-verified baseline ONLY if analysisId matches SHA-256 of current inputs
    const trustedBaseline = analysisStore.getVerifiedBaseline({
      analysisId,
      originalCode: safeOriginal,
      testCode: safeTestCode,
      filename: srcNameCheck.filename,
      language: resolvedLang,
    });

    activeAnalyses++;
    try {
      const result =
        resolvedLang === 'python'
          ? await runPythonEngine({
              action: 'validate',
              filename: srcNameCheck.filename,
              testFilename: testNameCheck.filename,
              originalCode: safeOriginal,
              candidateCode,
              testCode: safeTestCode,
              _trustedServerBaseline: trustedBaseline,
              targetLine: lineCheck.value,
              bugType: typeof bugType === 'string' ? sanitizeSingleLineText(bugType, 80) : undefined,
              rootCause: typeof rootCause === 'string' ? sanitizeSingleLineText(rootCause, 500) : undefined,
              timeoutSeconds: clampedTimeout,
            })
          : await runMultiLangAnalysis({
              action: 'validate',
              language: resolvedLang,
              filename: srcNameCheck.filename,
              testFilename: testNameCheck.filename,
              originalCode: safeOriginal,
              candidateCode,
              testCode: safeTestCode,
              _trustedServerBaseline: trustedBaseline,
              targetLine: lineCheck.value,
              bugType: typeof bugType === 'string' ? sanitizeSingleLineText(bugType, 80) : undefined,
              rootCause: typeof rootCause === 'string' ? sanitizeSingleLineText(rootCause, 500) : undefined,
              timeoutSeconds: clampedTimeout,
            });

      const unifiedFindings = buildUnifiedFindings(result, []);
      const modifiedSourceHash = computeContentSha256(candidateCode);

      const enriched: AnalysisResponse = {
        ...result,
        originalSourceHash: actualOriginalHash,
        unifiedFindings,
        auditStorageMode: auditStore.mode,
      };

      // Persist authoritative hash-chained audit record for patch validation
      try {
        const approvalObj =
          developerApproval && typeof developerApproval === 'object'
            ? {
                approved: Boolean((developerApproval as { approved?: unknown }).approved),
                approver:
                  typeof (developerApproval as { approver?: unknown }).approver === 'string'
                    ? sanitizeSingleLineText((developerApproval as { approver: string }).approver, 80)
                    : undefined,
                reason:
                  typeof (developerApproval as { reason?: unknown }).reason === 'string'
                    ? sanitizeSingleLineText((developerApproval as { reason: string }).reason, 300)
                    : undefined,
                recordedAt: new Date().toISOString(),
              }
            : undefined;

        await auditStore.append({
          id: `val-${Date.now()}-${requestId.slice(0, 6)}`,
          timestamp: new Date().toISOString(),
          projectId: projCheck.projectId,
          filename: srcNameCheck.filename,
          line: result.patchInfo.targetLine ?? lineCheck.value ?? null,
          bugType: result.patchInfo.bugType || 'ManualFix',
          ruleId: result.patchInfo.ruleId || 'DEVELOPER_MANUAL_PATCH',
          confidence: result.confidence.score,
          baselinePassed: result.baseline.passed,
          baselineTotal: result.baseline.total,
          sandboxPassed: result.sandbox.passed,
          sandboxTotal: result.sandbox.total,
          sandboxVerdict: result.trustVerdict,
          verificationStatus: result.verificationStatus,
          decision: approvalObj?.approved
            ? 'accepted'
            : result.trustVerdict === 'blocked'
            ? 'blocked'
            : 'override',
          originalSourceHash: actualOriginalHash,
          modifiedSourceHash,
          linesAdded: result.diff.linesAdded,
          linesRemoved: result.diff.linesRemoved,
          patchDiff: result.diff.unified.slice(0, 4000),
          developerApproval: approvalObj,
          summary: result.patchInfo.strategy,
        });
      } catch {
        // Do not fail validation response if audit file write encounters transient IO error
      }

      // Best-effort fire-and-forget Neo4j graph recording
      if (enableGraphWriteBack) {
        recordAnalysisResultInGraph({
          projectId: projCheck.projectId,
          analysis: enriched,
        }).catch(() => {});
      }

      logStructured('info', 'api.validate', {
        requestId,
        language: resolvedLang,
        usedCachedBaseline: Boolean(trustedBaseline),
        verificationMode: result.verificationMode,
        verificationStatus: result.verificationStatus,
        trustVerdict: result.trustVerdict,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });

      res.json(enriched);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode || 500;
      logStructured('error', 'api.validate.failed', {
        requestId,
        language: resolvedLang,
        status,
        durationMs: Number((performance.now() - t0).toFixed(1)),
      });
      res.status(status).json({
        error:
          status === 503
            ? 'Validation engine is temporarily at capacity. Please retry shortly.'
            : 'Failed to validate candidate patch.',
      });
    } finally {
      activeAnalyses = Math.max(0, activeAnalyses - 1);
    }
  });

  // ---------------------------------------------------------------------------
  // APPEND-ONLY HASH-CHAINED AUDIT API
  // ---------------------------------------------------------------------------

  app.get('/api/audit', async (req, res) => {
    if (!checkRateLimit(req, res, 'api', limits.maxRequestsPerMinute)) return;
    const rawLimit = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.round(rawLimit))) : 100;
    try {
      const [entries, chain] = await Promise.all([
        auditStore.list(limit),
        auditStore.verifyChain(),
      ]);
      res.json({
        mode: auditStore.mode,
        totalRecords: chain.totalRecords,
        chainValid: chain.valid,
        brokenAtIndex: chain.brokenAtIndex,
        entries,
      });
    } catch {
      res.status(500).json({ error: 'Failed to read append-only audit ledger.' });
    }
  });

  app.get('/api/audit/:id', async (req, res) => {
    if (!checkRateLimit(req, res, 'api', limits.maxRequestsPerMinute)) return;
    const idCheck = validateEntityId(req.params.id, 'auditId');
    if (!idCheck.ok) {
      res.status(400).json({ error: idCheck.error });
      return;
    }
    try {
      const entry = await auditStore.getById(idCheck.id);
      if (!entry) {
        res.status(404).json({ error: 'Audit record not found.' });
        return;
      }
      res.json(entry);
    } catch {
      res.status(500).json({ error: 'Failed to load audit record.' });
    }
  });

  app.post('/api/audit', standardJsonParser, async (req, res) => {
    if (!checkRateLimit(req, res, 'api', limits.maxRequestsPerMinute)) return;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Audit payload must be a JSON object.' });
      return;
    }
    const auditIdCheck = validateSafeAuditId(body.id);
    if (!auditIdCheck.ok) {
      res.status(400).json({ error: auditIdCheck.error });
      return;
    }
    const srcNameCheck = validateSafeFilename(body.filename, 'module.py', 'filename');
    if (!srcNameCheck.ok) {
      res.status(400).json({ error: srcNameCheck.error });
      return;
    }
    const projCheck = validateProjectId(body.projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }

    const allowedDecisions = new Set(['accepted', 'rejected', 'override', 'blocked']);
    if (body.decision !== undefined && (typeof body.decision !== 'string' || !allowedDecisions.has(body.decision))) {
      res.status(400).json({ error: 'Invalid audit decision value.' });
      return;
    }
    const decision = (body.decision ?? 'override') as 'accepted' | 'rejected' | 'override' | 'blocked';

    const allowedVerdicts = new Set(['verified', 'blocked', 'already_passing']);
    if (
      body.sandboxVerdict !== undefined &&
      (typeof body.sandboxVerdict !== 'string' || !allowedVerdicts.has(body.sandboxVerdict))
    ) {
      res.status(400).json({ error: 'Invalid sandboxVerdict value.' });
      return;
    }
    const sandboxVerdict = (body.sandboxVerdict ?? 'blocked') as
      | 'verified'
      | 'blocked'
      | 'already_passing';

    const allowedVerificationStatuses = new Set([
      'RUNTIME_VERIFIED',
      'STATIC_ANALYSIS_PASSED',
      'HUMAN_REVIEW_REQUIRED',
      'VERIFICATION_UNAVAILABLE',
      'FAILED',
    ]);
    if (
      body.verificationStatus !== undefined &&
      body.verificationStatus !== null &&
      (typeof body.verificationStatus !== 'string' ||
        !allowedVerificationStatuses.has(body.verificationStatus))
    ) {
      res.status(400).json({ error: 'Invalid verificationStatus value.' });
      return;
    }

    try {
      const record = await auditStore.append({
        id: auditIdCheck.id,
        timestamp: new Date().toISOString(),
        projectId: projCheck.projectId,
        filename: srcNameCheck.filename,
        line: typeof body.line === 'number' && Number.isFinite(body.line) ? Math.round(body.line) : null,
        bugType:
          typeof body.bugType === 'string' && body.bugType.trim()
            ? sanitizeSingleLineText(body.bugType, 80)
            : 'ManualAudit',
        ruleId:
          typeof body.ruleId === 'string' && body.ruleId.trim()
            ? sanitizeSingleLineText(body.ruleId, 80)
            : 'AUDIT_LOG',
        confidence:
          typeof body.confidence === 'number' && Number.isFinite(body.confidence)
            ? Math.max(0, Math.min(100, Math.round(body.confidence)))
            : 0,
        baselinePassed:
          typeof body.baselinePassed === 'number' && Number.isFinite(body.baselinePassed)
            ? Math.max(0, Math.round(body.baselinePassed))
            : 0,
        baselineTotal:
          typeof body.baselineTotal === 'number' && Number.isFinite(body.baselineTotal)
            ? Math.max(0, Math.round(body.baselineTotal))
            : 0,
        sandboxPassed:
          typeof body.sandboxPassed === 'number' && Number.isFinite(body.sandboxPassed)
            ? Math.max(0, Math.round(body.sandboxPassed))
            : 0,
        sandboxTotal:
          typeof body.sandboxTotal === 'number' && Number.isFinite(body.sandboxTotal)
            ? Math.max(0, Math.round(body.sandboxTotal))
            : 0,
        linesAdded:
          typeof body.linesAdded === 'number' && Number.isFinite(body.linesAdded)
            ? Math.max(0, Math.round(body.linesAdded))
            : 0,
        linesRemoved:
          typeof body.linesRemoved === 'number' && Number.isFinite(body.linesRemoved)
            ? Math.max(0, Math.round(body.linesRemoved))
            : 0,
        sandboxVerdict,
        verificationStatus:
          typeof body.verificationStatus === 'string'
            ? (body.verificationStatus as AnalysisResponse['verificationStatus'])
            : undefined,
        decision,
        overrideReason:
          typeof body.overrideReason === 'string'
            ? sanitizeSingleLineText(body.overrideReason, 400)
            : undefined,
        originalSourceHash:
          typeof body.originalSourceHash === 'string' && /^[a-fA-F0-9]{64}$/.test(body.originalSourceHash.trim())
            ? body.originalSourceHash.trim().toLowerCase()
            : undefined,
        modifiedSourceHash:
          typeof body.modifiedSourceHash === 'string' && /^[a-fA-F0-9]{64}$/.test(body.modifiedSourceHash.trim())
            ? body.modifiedSourceHash.trim().toLowerCase()
            : undefined,
        patchDiff: typeof body.patchDiff === 'string' ? body.patchDiff.slice(0, 4000) : undefined,
        developerApproval:
          body.developerApproval && typeof body.developerApproval === 'object' && !Array.isArray(body.developerApproval)
            ? {
                approved: Boolean(body.developerApproval.approved),
                approver:
                  typeof body.developerApproval.approver === 'string'
                    ? sanitizeSingleLineText(body.developerApproval.approver, 80)
                    : undefined,
                reason:
                  typeof body.developerApproval.reason === 'string'
                    ? sanitizeSingleLineText(body.developerApproval.reason, 300)
                    : undefined,
                recordedAt: new Date().toISOString(),
              }
            : undefined,
        summary:
          typeof body.summary === 'string' && body.summary.trim()
            ? sanitizeSingleLineText(body.summary, 400)
            : `Audit event (${decision}) for ${srcNameCheck.filename}`,
      });
      res.status(201).json(record);
    } catch {
      res.status(500).json({ error: 'Failed to append audit record.' });
    }
  });

  // ---------------------------------------------------------------------------
  // NEO4J GRAPHRAG API (ALL 9 ENDPOINTS)
  // ---------------------------------------------------------------------------

  const ensureGraphRagConfigured = (res: Response): boolean => {
    const cfg = loadAppEnvConfig().neo4j;
    if (!cfg.enabled || !cfg.configured) {
      res.status(503).json({
        error:
          'Neo4j GraphRAG is not configured or disabled on this server. Set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD to enable GraphRAG.',
        code: 'GRAPHRAG_UNAVAILABLE',
      });
      return false;
    }
    return true;
  };

  // 1. GET /api/graphrag/health
  app.get('/api/graphrag/health', async (_req, res) => {
    const envCfg = loadAppEnvConfig();
    const health = await verifyNeo4jConnection();
    res.status(health.connected || !health.configured ? 200 : 503).json({
      ...health,
      embeddingModel: envCfg.gemini.embeddingModel,
      embeddingDimensions: envCfg.gemini.embeddingDimensions,
      geminiConfigured: envCfg.gemini.configured,
    });
  });

  // 2. POST /api/graphrag/ingest
  app.post('/api/graphrag/ingest', standardJsonParser, async (req, res) => {
    const requestId = (req as Request & { requestId?: string }).requestId || 'unknown';
    if (!checkRateLimit(req, res, 'graphrag', Math.min(limits.maxRequestsPerMinute, 12))) return;

    const { projectId, forceReindex, includeEmbeddings } = req.body ?? {};
    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;

    try {
      const auditRecords = await auditStore.list(50).catch(() => []);
      const report = await ingestRepositoryToGraph({
        projectId: projCheck.projectId,
        rootDir: repoRootDir,
        forceReindex: forceReindex === true,
        includeEmbeddings: includeEmbeddings !== false,
        auditRecords,
      });

      logStructured('info', 'api.graphrag.ingest', {
        requestId,
        projectId: projCheck.projectId,
        status: report.status,
        filesProcessed: report.filesProcessed,
        embeddingsGenerated: report.embeddingsGenerated,
        durationMs: report.durationMs,
      });

      res.status(report.status === 'FAILED' ? 502 : 200).json(report);
    } catch (err) {
      logStructured('error', 'api.graphrag.ingest.failed', {
        requestId,
        projectId: projCheck.projectId,
      });
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'GraphRAG ingestion failed.'),
        code: 'GRAPHRAG_INGEST_FAILED',
      });
    }
  });

  // 3. GET /api/graphrag/status/:projectId
  app.get('/api/graphrag/status/:projectId', async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;
    const projCheck = validateProjectId(req.params.projectId);
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    const status = await getProjectIngestionStatus(projCheck.projectId);
    res.json(status);
  });

  // 4. POST /api/graphrag/root-cause
  app.post('/api/graphrag/root-cause', queryJsonParser, async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;

    const { projectId, findingId, query } = req.body ?? {};
    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    if (findingId !== undefined && findingId !== null && findingId !== '') {
      const fCheck = validateEntityId(findingId, 'findingId');
      if (!fCheck.ok) {
        res.status(400).json({ error: fCheck.error });
        return;
      }
    }
    const safeQuery = typeof query === 'string' ? query.trim().slice(0, 600) : '';
    if (!findingId && !safeQuery) {
      res.status(400).json({ error: 'Provide either findingId or query for root-cause analysis.' });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;

    try {
      const result = await investigateRootCause({
        projectId: projCheck.projectId,
        findingId: typeof findingId === 'string' && findingId.trim() ? findingId.trim() : undefined,
        query: safeQuery || undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'Root-cause analysis unavailable.'),
        code: 'GRAPHRAG_QUERY_FAILED',
      });
    }
  });

  // 5. POST /api/graphrag/impact-analysis
  app.post('/api/graphrag/impact-analysis', queryJsonParser, async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;

    const { projectId, targetType, targetId, maxDepth } = req.body ?? {};
    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    const idCheck = validateEntityId(targetId, 'targetId');
    if (!idCheck.ok) {
      res.status(400).json({ error: idCheck.error });
      return;
    }
    let safeType = 'Function';
    if (targetType !== undefined && targetType !== null && targetType !== '') {
      if (typeof targetType !== 'string' || !['Function', 'File', 'Class'].includes(targetType.trim())) {
        res.status(400).json({ error: 'targetType must be Function, File, or Class.' });
        return;
      }
      safeType = targetType.trim();
    }
    if (maxDepth !== undefined && (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth))) {
      res.status(400).json({ error: 'maxDepth must be a finite number.' });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;

    try {
      const result = await analyzeEntityImpact({
        projectId: projCheck.projectId,
        targetType: safeType,
        targetId: idCheck.id,
        maxDepth: typeof maxDepth === 'number' ? Math.max(1, Math.min(3, Math.round(maxDepth))) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'Impact analysis unavailable.'),
        code: 'GRAPHRAG_QUERY_FAILED',
      });
    }
  });

  // 6. POST /api/graphrag/historical-search
  app.post('/api/graphrag/historical-search', queryJsonParser, async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;

    const { projectId, query, limit } = req.body ?? {};
    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'query is required for historical bug search.' });
      return;
    }
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
      res.status(400).json({ error: 'limit must be a finite number.' });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;

    try {
      const result = await searchHistoricalBugs({
        projectId: projCheck.projectId,
        query: sanitizeSingleLineText(query, 600),
        limit: typeof limit === 'number' ? Math.max(1, Math.min(25, Math.round(limit))) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'Historical search unavailable.'),
        code: 'GRAPHRAG_QUERY_FAILED',
      });
    }
  });

  // 7. POST /api/graphrag/ask
  app.post('/api/graphrag/ask', queryJsonParser, async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;

    const { projectId, question, maxDepth, maxNodes } = req.body ?? {};
    const projCheck = validateProjectId(projectId, 'autopatch-core');
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    if (typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'question is required.' });
      return;
    }
    if (maxDepth !== undefined && (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth))) {
      res.status(400).json({ error: 'maxDepth must be a finite number.' });
      return;
    }
    if (maxNodes !== undefined && (typeof maxNodes !== 'number' || !Number.isFinite(maxNodes))) {
      res.status(400).json({ error: 'maxNodes must be a finite number.' });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;

    try {
      const result = await answerGraphQuestion({
        projectId: projCheck.projectId,
        question: sanitizeSingleLineText(question, 800),
        maxDepth: typeof maxDepth === 'number' ? Math.max(1, Math.min(3, Math.round(maxDepth))) : undefined,
        maxNodes: typeof maxNodes === 'number' ? Math.max(5, Math.min(200, Math.round(maxNodes))) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'GraphRAG Q&A unavailable.'),
        code: 'GRAPHRAG_QUERY_FAILED',
      });
    }
  });

  // 8. GET /api/graphrag/graph/:projectId
  app.get('/api/graphrag/graph/:projectId', async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;

    const projCheck = validateProjectId(req.params.projectId);
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;
    const rawLimit = Number(req.query.limit ?? 80);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 80;

    try {
      const subgraph = await getProjectSubgraph(projCheck.projectId, limit);
      res.json(subgraph);
    } catch (err) {
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'Unable to fetch project subgraph.'),
        code: 'GRAPHRAG_QUERY_FAILED',
      });
    }
  });

  // 9. GET /api/graphrag/entity/:projectId/:entityId
  app.get('/api/graphrag/entity/:projectId/:entityId', async (req, res) => {
    if (!checkRateLimit(req, res, 'graphrag', limits.maxRequestsPerMinute)) return;

    const projCheck = validateProjectId(req.params.projectId);
    if (!projCheck.ok) {
      res.status(400).json({ error: projCheck.error });
      return;
    }
    const idCheck = validateEntityId(req.params.entityId, 'entityId');
    if (!idCheck.ok) {
      res.status(400).json({ error: idCheck.error });
      return;
    }
    if (!ensureGraphRagConfigured(res)) return;

    try {
      const detail = await getProjectEntityDetails(projCheck.projectId, idCheck.id);
      if (!detail.found) {
        res.status(404).json({ error: 'Entity not found in this project.' });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(503).json({
        error: redactSecrets(err instanceof Error ? err.message : 'Unable to load entity details.'),
        code: 'GRAPHRAG_QUERY_FAILED',
      });
    }
  });

  // Explicit JSON 404 for unknown /api/* routes so they never fall through to Vite/SPA HTML
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Centralized Express error middleware (handles malformed JSON 400, oversized body 413, unexpected 500 cleanly without leaking stack traces or secrets)
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as Request & { requestId?: string }).requestId || 'unknown';
    const errObj = err as { type?: string; status?: number; statusCode?: number };
    if (errObj?.type === 'entity.too.large' || errObj?.status === 413) {
      logStructured('warn', 'api.payload_too_large', { requestId, path: req.path });
      res.status(413).json({ error: 'Request payload exceeds maximum allowed size.' });
      return;
    }
    if (errObj?.type === 'entity.parse.failed' || errObj?.status === 400) {
      logStructured('warn', 'api.invalid_json', { requestId, path: req.path });
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    logStructured('error', 'api.unhandled_error', { requestId, path: req.path });
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

async function startServer() {
  const startupReport = validateStartupConfig();
  logStructured(startupReport.ok ? 'info' : 'warn', 'server.config_validated', {
    ok: startupReport.ok,
    geminiAi: startupReport.features.geminiAi,
    graphRagEnabled: startupReport.features.graphRagEnabled,
    graphRagConfigured: startupReport.features.graphRagConfigured,
    apiKeyAuthEnabled: startupReport.features.apiKeyAuthEnabled,
    missingRequired:
      startupReport.missingRequired.length > 0
        ? startupReport.missingRequired.map((m) => m.variable).join(',')
        : 'none',
    optionalDisabled:
      startupReport.optionalDisabled.length > 0
        ? startupReport.optionalDisabled.map((s) => s.service).join('; ')
        : 'none',
    warningCount: startupReport.warnings.length,
    errorCount: startupReport.errors.length,
  });

  const app = createAutoPatchApp();
  const server = http.createServer(app);
  server.requestTimeout = 300_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');
  let viteServer: { close: () => Promise<void> } | null = null;

  if (isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const envCfg = loadAppEnvConfig();
    const useHmr =
      !envCfg.disableHmr &&
      (process.env.DISABLE_HMR === 'false' || envCfg.enableLocalHmr);
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: useHmr ? { server } : false,
        watch: useHmr ? {} : null,
      },
      appType: 'spa',
    });
    viteServer = vite;
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    logStructured('info', 'server.started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      sandboxLevel: getSandboxIsolationInfo().level,
    });
  });

  const shutdown = async (sig: string) => {
    logStructured('info', 'server.shutting_down', { signal: sig });
    await viteServer?.close().catch(() => {});
    await closeNeo4jDriver().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    logStructured('error', 'process.unhandled_rejection', {
      reason: redactSecrets(reason instanceof Error ? reason.message : String(reason)),
    });
  });
}

// Only start HTTP listener when executed directly (allows importing createAutoPatchApp in tests!)
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  startServer().catch((err) => {
    logStructured('error', 'server.start_failed', {
      reason: redactSecrets(err instanceof Error ? err.message : 'unknown'),
    });
    process.exit(1);
  });
}
