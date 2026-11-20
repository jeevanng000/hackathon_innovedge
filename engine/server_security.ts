import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { TestRunResult } from '../src/types/autopatch.ts';
import {
  detectLanguageFromFilename,
  isSupportedLanguage,
  type SupportedLanguage,
} from '../src/utils/languageDetect.ts';

export interface SecurityLimits {
  maxSourceSizeBytes: number;
  maxTestSizeBytes: number;
  maxContextSizeBytes: number;
  maxAudioSizeBytes: number;
  maxRequestsPerMinute: number;
  maxAiRequestsPerMinute: number;
  maxConcurrentAnalyses: number;
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function loadSecurityLimits(): SecurityLimits {
  return {
    maxSourceSizeBytes: readIntEnv('MAX_SOURCE_SIZE_BYTES', 25_000_000, 1024, 50_000_000),
    maxTestSizeBytes: readIntEnv('MAX_TEST_SIZE_BYTES', 25_000_000, 1024, 50_000_000),
    maxContextSizeBytes: readIntEnv('MAX_CONTEXT_SIZE_BYTES', 2_000_000, 256, 10_000_000),
    maxAudioSizeBytes: readIntEnv('MAX_AUDIO_SIZE_BYTES', 10_000_000, 10_000, 25_000_000),
    maxRequestsPerMinute: readIntEnv('MAX_REQUESTS_PER_MINUTE', 6000, 5, 100_000),
    maxAiRequestsPerMinute: readIntEnv('MAX_AI_REQUESTS_PER_MINUTE', 6000, 2, 100_000),
    maxConcurrentAnalyses: readIntEnv('MAX_CONCURRENT_ANALYSES', 32, 1, 256),
  };
}

/**
 * Validates filenames strictly: rejects path traversal (`..`, `/`, `\`),
 * null bytes, control chars, and excessive lengths.
 */
export function validateSafeFilename(
  raw: unknown,
  fallback: string,
  fieldLabel: string
): { ok: true; filename: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, filename: fallback };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${fieldLabel} must be a string.` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, filename: fallback };
  }
  if (trimmed.length > 128) {
    return { ok: false, error: `${fieldLabel} exceeds maximum length of 128 characters.` };
  }
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    /[\x00-\x1f\x7f]/.test(trimmed)
  ) {
    return {
      ok: false,
      error: `${fieldLabel} contains disallowed path traversal or control characters.`,
    };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return {
      ok: false,
      error: `${fieldLabel} must start with an alphanumeric character and contain only letters, digits, '.', '_', or '-'.`,
    };
  }
  return { ok: true, filename: trimmed };
}

/**
 * Strictly validates the optional `language` parameter against the supported allowlist.
 * Never blindly casts arbitrary strings as SupportedLanguage.
 */
export function validateAndResolveLanguage(
  rawLanguage: unknown,
  safeFilename: string
): { ok: true; language: SupportedLanguage } | { ok: false; error: string } {
  if (rawLanguage === undefined || rawLanguage === null || rawLanguage === '' || rawLanguage === 'auto') {
    return { ok: true, language: detectLanguageFromFilename(safeFilename) };
  }
  if (typeof rawLanguage !== 'string') {
    return { ok: false, error: 'Language must be a string.' };
  }
  const normalized = rawLanguage.trim().toLowerCase();
  if (normalized === 'auto') {
    return { ok: true, language: detectLanguageFromFilename(safeFilename) };
  }
  if (!isSupportedLanguage(normalized)) {
    return {
      ok: false,
      error: `Unsupported language '${normalized}'. Provide 'auto' or a supported language identifier.`,
    };
  }
  return { ok: true, language: normalized };
}

export function validateTimeoutSeconds(raw: unknown, defaultSec = 5.0): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return defaultSec;
  return Math.max(0.5, Math.min(30.0, raw));
}

export function validateTargetLine(raw: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 1_000_000) {
    return { ok: false, error: 'targetLine must be a positive integer or null.' };
  }
  return { ok: true, value: raw };
}

/**
 * Sliding-window in-memory rate limiter keyed by client IP + bucket name.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  check(key: string, limit: number): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const prev = this.hits.get(key) ?? [];
    const recent = prev.filter((ts) => ts > cutoff);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    recent.push(now);
    this.hits.set(key, recent);

    // Prevent unbounded map growth across many transient IPs
    if (this.hits.size > 2000) {
      for (const [k, v] of this.hits.entries()) {
        if (v.length === 0 || v[v.length - 1] <= cutoff) {
          this.hits.delete(k);
        }
      }
    }

    return { allowed: true, remaining: Math.max(0, limit - recent.length), retryAfterSec: 0 };
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * Server-side store for authoritative analysis baselines keyed by opaque `analysisId`
 * and verified against the SHA-256 hash of `(originalCode, testCode, filename, language)`.
 * Prevents clients from forging baseline results in `/api/validate`.
 */
export interface StoredAnalysisBaseline {
  analysisId: string;
  keyHash: string;
  baseline: TestRunResult;
  language: SupportedLanguage;
  filename: string;
  testFilename: string;
  createdAt: number;
}

export class ServerAnalysisStore {
  private readonly records = new Map<string, StoredAnalysisBaseline>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 200, ttlMs = 30 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  static computeKeyHash(params: {
    originalCode: string;
    testCode: string;
    filename: string;
    language: SupportedLanguage;
  }): string {
    return crypto
      .createHash('sha256')
      .update(params.language)
      .update('\0')
      .update(params.filename)
      .update('\0')
      .update(params.originalCode)
      .update('\0')
      .update(params.testCode)
      .digest('hex');
  }

  save(params: {
    originalCode: string;
    testCode: string;
    filename: string;
    testFilename: string;
    language: SupportedLanguage;
    baseline: TestRunResult;
  }): string {
    this.pruneExpired();
    const analysisId = crypto.randomUUID();
    const keyHash = ServerAnalysisStore.computeKeyHash(params);
    this.records.set(analysisId, {
      analysisId,
      keyHash,
      baseline: structuredClone(params.baseline),
      language: params.language,
      filename: params.filename,
      testFilename: params.testFilename,
      createdAt: Date.now(),
    });
    if (this.records.size > this.maxEntries) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) this.records.delete(oldestKey);
    }
    return analysisId;
  }

  /**
   * Returns the server-verified baseline ONLY if `analysisId` exists, is not expired,
   * and matches the cryptographic SHA-256 hash of the current inputs.
   */
  getVerifiedBaseline(params: {
    analysisId: unknown;
    originalCode: string;
    testCode: string;
    filename: string;
    language: SupportedLanguage;
  }): TestRunResult | null {
    if (typeof params.analysisId !== 'string' || !params.analysisId.trim()) return null;
    this.pruneExpired();
    const entry = this.records.get(params.analysisId.trim());
    if (!entry) return null;
    const expectedHash = ServerAnalysisStore.computeKeyHash(params);
    if (entry.keyHash !== expectedHash) return null;
    return structuredClone(entry.baseline);
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, rec] of this.records.entries()) {
      if (rec.createdAt < cutoff) {
        this.records.delete(id);
      }
    }
  }
}

export function getClientIp(req: Request): string {
  // Only honor X-Forwarded-For when explicitly running behind a trusted reverse proxy
  if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) {
      const candidate = fwd.split(',')[0].trim();
      if (/^[0-9a-fA-F:.]{2,45}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
  (req as Request & { requestId?: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/**
 * Structured server logger that emits clean JSON metadata without ever logging
 * secrets, API keys, raw audio, passwords, or full user source code.
 */
export function logStructured(
  level: 'info' | 'warn' | 'error',
  event: string,
  meta: Record<string, string | number | boolean | null | undefined>
): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function validateProjectId(
  raw: unknown,
  fallback = 'autopatch-core'
): { ok: true; projectId: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, projectId: fallback };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'projectId must be a string.' };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return {
      ok: false,
      error: 'projectId must be 1-80 characters containing only letters, digits, ".", "_", or "-".',
    };
  }
  return { ok: true, projectId: trimmed };
}

export function validateEntityId(
  raw: unknown,
  fieldLabel = 'entityId'
): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: `${fieldLabel} is required.` };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 256 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, error: `${fieldLabel} is invalid or exceeds 256 characters.` };
  }
  return { ok: true, id: trimmed };
}

export function sanitizeSingleLineText(raw: string, maxLen: number): string {
  return raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLen);
}

export function validateSafeAuditId(
  raw: unknown
): { ok: true; id: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, id: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'audit id must be a string.' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, id: '' };
  }
  if (trimmed.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) {
    return {
      ok: false,
      error: 'audit id must be 1-80 chars containing only letters, digits, ".", "_", ":", or "-".',
    };
  }
  return { ok: true, id: trimmed };
}

/**
 * Optional API-key protection middleware for sensitive backend routes.
 * When AUTOPATCH_API_KEY is unset, requests proceed normally (preserves local dev / existing UI).
 * When AUTOPATCH_API_KEY is configured, enforces strict constant-time SHA-256 digest comparison via
 * `Authorization: Bearer <token>` or `X-API-Key: <token>`.
 */
export function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.AUTOPATCH_API_KEY?.trim();
  if (!expected) {
    next();
    return;
  }
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  const provided = bearer || headerKey;

  if (!provided) {
    res.status(401).json({ error: 'Authentication required. Provide Bearer token or X-API-Key header.' });
    return;
  }

  // Hash both keys to fixed 32-byte digests so timingSafeEqual leaks zero length information
  const aDigest = crypto.createHash('sha256').update(provided, 'utf-8').digest();
  const bDigest = crypto.createHash('sha256').update(expected, 'utf-8').digest();
  if (!crypto.timingSafeEqual(aDigest, bDigest)) {
    res.status(403).json({ error: 'Invalid API credentials.' });
    return;
  }
  next();
}

