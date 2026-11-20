import { GoogleGenAI } from '@google/genai';
import crypto from 'node:crypto';
import { loadAppEnvConfig, redactSecrets } from './env_config.ts';

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey: string | null = null;

// Daily quota tracking for controlled Gemini API usage
let quotaDateKey = new Date().toISOString().slice(0, 10);
let dailyCallCount = 0;

function resetQuotaIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== quotaDateKey) {
    quotaDateKey = today;
    dailyCallCount = 0;
  }
}

export function checkAndConsumeGeminiQuota(units = 1): {
  allowed: boolean;
  used: number;
  limit: number;
} {
  resetQuotaIfNewDay();
  const limit = loadAppEnvConfig().gemini.dailyQuota;
  if (dailyCallCount + units > limit) {
    return { allowed: false, used: dailyCallCount, limit };
  }
  dailyCallCount += units;
  return { allowed: true, used: dailyCallCount, limit };
}

export function getGeminiQuotaStatus(): { date: string; used: number; limit: number } {
  resetQuotaIfNewDay();
  return {
    date: quotaDateKey,
    used: dailyCallCount,
    limit: loadAppEnvConfig().gemini.dailyQuota,
  };
}

/**
 * Shared singleton Gemini client keyed by the active server-side GEMINI_API_KEY.
 * Automatically refreshes if the key rotates or changes across test runs.
 */
export function getSharedGeminiClient(): GoogleGenAI | null {
  const apiKey = loadAppEnvConfig().gemini.apiKey;
  if (!apiKey) {
    cachedClient = null;
    cachedApiKey = null;
    return null;
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedApiKey = apiKey;
  }
  return cachedClient;
}

export function resetSharedGeminiClientForTest(): void {
  cachedClient = null;
  cachedApiKey = null;
  dailyCallCount = 0;
}

export async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new Error('503 UNAVAILABLE timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/**
 * Scrubs potential secrets/private keys before transmitting text to external embedding APIs.
 */
export function scrubSecretsForEmbedding(text: string): string {
  let cleaned = redactSecrets(text);
  cleaned = cleaned.replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  cleaned = cleaned.replace(/(?:neo4j\+s|bolt\+s|postgres|mongodb\+srv):\/\/[^@\s]+@/gi, '[REDACTED_URI_CREDS]@');
  return cleaned.trim();
}

export interface EmbeddingResultItem {
  values: number[];
  model: string;
  dimensions: number;
  cached: boolean;
}

// Content-addressed LRU cache keyed by `${model}:${dims}:${sha256}`
const EMBEDDING_CACHE_MAX = 2000;
const embeddingCache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const val = embeddingCache.get(key);
  if (!val) return undefined;
  embeddingCache.delete(key);
  embeddingCache.set(key, val);
  return val;
}

function cacheSet(key: string, vector: number[]): void {
  if (embeddingCache.has(key)) embeddingCache.delete(key);
  embeddingCache.set(key, vector);
  if (embeddingCache.size > EMBEDDING_CACHE_MAX) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest) embeddingCache.delete(oldest);
  }
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

export function getEmbeddingCacheStats(): { size: number; model: string; dimensions: number } {
  const cfg = loadAppEnvConfig().gemini;
  return {
    size: embeddingCache.size,
    model: cfg.embeddingModel,
    dimensions: cfg.embeddingDimensions,
  };
}

/**
 * Generates embeddings via Gemini (`gemini-embedding-001` by default, configurable)
 * with consistent output dimensionality, secret scrubbing, deduplication, caching,
 * batching, and retry handling.
 *
 * Returns null entries for items that failed rather than silently fabricating vectors.
 */
export async function generateGeminiEmbeddings(
  texts: string[],
  options?: {
    taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    modelOverride?: string;
    dimensionsOverride?: number;
    embedderOverride?: (batch: string[], model: string, dimensions: number) => Promise<number[][]>;
  }
): Promise<{
  vectors: Array<EmbeddingResultItem | null>;
  model: string;
  dimensions: number;
  generatedCount: number;
  cachedCount: number;
  failedCount: number;
  error?: string;
}> {
  const cfg = loadAppEnvConfig();
  const model = options?.modelOverride || cfg.gemini.embeddingModel;
  const dimensions = options?.dimensionsOverride || cfg.gemini.embeddingDimensions;
  const batchSize = cfg.neo4j.embeddingBatchSize;

  const results: Array<EmbeddingResultItem | null> = new Array(texts.length).fill(null);
  let generatedCount = 0;
  let cachedCount = 0;
  let failedCount = 0;

  // Prepare scrubbed texts and deduplicate identical content within the batch
  const pendingMap = new Map<string, { text: string; indices: number[] }>();

  for (let i = 0; i < texts.length; i++) {
    const scrubbed = scrubSecretsForEmbedding(texts[i] || '').slice(0, 6000);
    if (!scrubbed) {
      failedCount++;
      continue;
    }
    const contentHash = crypto.createHash('sha256').update(scrubbed).digest('hex');
    const cacheKey = `${model}:${dimensions}:${options?.taskType || 'DEFAULT'}:${contentHash}`;
    const hit = cacheGet(cacheKey);
    if (hit && hit.length === dimensions) {
      results[i] = { values: hit, model, dimensions, cached: true };
      cachedCount++;
      continue;
    }
    const existing = pendingMap.get(cacheKey);
    if (existing) {
      existing.indices.push(i);
    } else {
      pendingMap.set(cacheKey, { text: scrubbed, indices: [i] });
    }
  }

  const pendingEntries = Array.from(pendingMap.entries());
  if (pendingEntries.length === 0) {
    return { vectors: results, model, dimensions, generatedCount, cachedCount, failedCount };
  }

  const client = options?.embedderOverride ? null : getSharedGeminiClient();
  if (!options?.embedderOverride && !client) {
    return {
      vectors: results,
      model,
      dimensions,
      generatedCount,
      cachedCount,
      failedCount: failedCount + pendingEntries.reduce((acc, [, v]) => acc + v.indices.length, 0),
      error: 'GEMINI_API_KEY is not configured; embeddings unavailable.',
    };
  }

  let lastError: string | undefined;

  for (let offset = 0; offset < pendingEntries.length; offset += batchSize) {
    const slice = pendingEntries.slice(offset, offset + batchSize);
    const batchTexts = slice.map(([, item]) => item.text);

    if (!options?.embedderOverride) {
      const quota = checkAndConsumeGeminiQuota(1);
      if (!quota.allowed) {
        lastError = `Gemini daily quota (${quota.limit}) exhausted.`;
        failedCount += slice.reduce((acc, [, v]) => acc + v.indices.length, 0);
        break;
      }
    }

    let vectorsBatch: number[][] | null = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (options?.embedderOverride) {
          vectorsBatch = await options.embedderOverride(batchTexts, model, dimensions);
        } else if (client) {
          const response = await runWithTimeout(
            () =>
              client.models.embedContent({
                model,
                contents: batchTexts,
                config: {
                  outputDimensionality: dimensions,
                  ...(options?.taskType ? { taskType: options.taskType } : {}),
                },
              }),
            Math.max(cfg.gemini.timeoutMs, 10000)
          );
          const embs = response.embeddings || [];
          vectorsBatch = embs.map((e) => (Array.isArray(e.values) ? e.values : []));
        }
        break;
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        lastError = msg;
        const isTransient = /503|429|UNAVAILABLE|ETIMEDOUT|ECONNRESET|timeout/i.test(msg);
        if (attempt < maxAttempts && isTransient) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        break;
      }
    }

    if (!vectorsBatch || vectorsBatch.length !== slice.length) {
      failedCount += slice.reduce((acc, [, v]) => acc + v.indices.length, 0);
      continue;
    }

    for (let k = 0; k < slice.length; k++) {
      const [cacheKey, item] = slice[k];
      const vec = vectorsBatch[k];
      if (!Array.isArray(vec) || vec.length !== dimensions) {
        failedCount += item.indices.length;
        continue;
      }
      cacheSet(cacheKey, vec);
      for (const idx of item.indices) {
        results[idx] = { values: vec, model, dimensions, cached: false };
      }
      generatedCount += item.indices.length;
    }
  }

  return {
    vectors: results,
    model,
    dimensions,
    generatedCount,
    cachedCount,
    failedCount,
    ...(lastError ? { error: lastError } : {}),
  };
}

export async function generateSingleEmbedding(
  text: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_QUERY'
): Promise<EmbeddingResultItem | null> {
  const res = await generateGeminiEmbeddings([text], { taskType });
  return res.vectors[0] ?? null;
}
