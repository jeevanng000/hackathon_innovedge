/**
 * Centralized AutoPatch Environment & Configuration Module
 *
 * Strictly separates:
 *  - Secrets / credentials (GEMINI_API_KEY, NEO4J_PASSWORD, AUTOPATCH_API_KEY)
 *  - Non-secret runtime configuration (models, limits, timeouts, feature flags)
 *
 * Guarantees:
 *  - Safe defaults for every non-secret variable so the backend always boots cleanly
 *  - Graceful degradation when optional integrations (Gemini / Neo4j) are unconfigured
 *  - Never logs or serializes raw secret values
 */

export interface GeminiConfig {
  apiKey: string | null;
  configured: boolean;
  model: string;
  transcribeModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  timeoutMs: number;
  transcribeTimeoutMs: number;
  dailyQuota: number;
}

export interface Neo4jConfig {
  enabled: boolean;
  configured: boolean;
  uri: string | null;
  username: string | null;
  password: string | null;
  database: string;
  /** Derived automatically from NEO4J_URI when pointing at Neo4j AuraDB (*.databases.neo4j.io). Never requires a separate env var. */
  instanceId: string | null;
  maxTraversalDepth: number;
  maxNodes: number;
  embeddingBatchSize: number;
}

export interface AppEnvConfig {
  port: number;
  nodeEnv: string;
  disableHmr: boolean;
  enableLocalHmr: boolean;
  apiKeyAuthToken: string | null;
  auditLogPath: string;
  gemini: GeminiConfig;
  neo4j: Neo4jConfig;
}

export interface MissingCredentialEntry {
  variable: string;
  service: string;
  purpose: string;
  source: string;
}

export interface OptionalDisabledService {
  service: string;
  reason: string;
  variables: string[];
  source: string;
}

export interface StartupValidationReport {
  ok: boolean;
  warnings: string[];
  errors: string[];
  missingRequired: MissingCredentialEntry[];
  optionalDisabled: OptionalDisabledService[];
  secretsStatus: {
    geminiApiKey: 'configured' | 'missing';
    neo4jPassword: 'configured' | 'missing';
    autopatchApiKey: 'configured' | 'optional-unset';
  };
  features: {
    deterministicEngine: boolean;
    geminiAi: boolean;
    graphRagEnabled: boolean;
    graphRagConfigured: boolean;
    apiKeyAuthEnabled: boolean;
  };
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw.trim();
}

function readOptionalSecret(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const norm = raw.trim().toLowerCase();
  if (norm === 'true' || norm === '1' || norm === 'yes') return true;
  if (norm === 'false' || norm === '0' || norm === 'no') return false;
  return fallback;
}

/**
 * Extracts the AuraDB instance ID directly from NEO4J_URI (e.g. neo4j+s://<id>.databases.neo4j.io)
 * so the application never requires a separate AURA_INSTANCEID environment variable.
 */
export function extractAuraInstanceIdFromUri(uri: string | null): string | null {
  if (!uri) return null;
  const match = uri.match(/^[a-z0-9+]+:\/\/([a-z0-9-]+)\.databases\.neo4j\.io(?::\d+)?\/?$/i);
  return match ? match[1] : null;
}

export function loadAppEnvConfig(): AppEnvConfig {
  const geminiApiKey = readOptionalSecret('GEMINI_API_KEY');
  const neo4jUri = readOptionalSecret('NEO4J_URI');
  const neo4jUsername = readOptionalSecret('NEO4J_USERNAME');
  const neo4jPassword = readOptionalSecret('NEO4J_PASSWORD');
  const neo4jDatabase = readString('NEO4J_DATABASE', 'neo4j');
  const neo4jConfigured = Boolean(neo4jUri && neo4jUsername && neo4jPassword);
  const graphRagEnabled = readBool('GRAPHRAG_ENABLED', neo4jConfigured);

  return {
    port: readInt('PORT', 3000, 1, 65535),
    nodeEnv: readString('NODE_ENV', 'development'),
    disableHmr: readBool('DISABLE_HMR', true),
    enableLocalHmr: readBool('ENABLE_LOCAL_HMR', false),
    apiKeyAuthToken: readOptionalSecret('AUTOPATCH_API_KEY'),
    auditLogPath: readString('AUDIT_LOG_PATH', '.autopatch-data/audit-ledger.ndjson').replace(/\0/g, ''),
    gemini: {
      apiKey: geminiApiKey,
      configured: Boolean(geminiApiKey),
      model: readString('GEMINI_MODEL', 'gemini-4-hydrogen'),
      transcribeModel: readString('GEMINI_TRANSCRIBE_MODEL', 'gemini-3.5-transcribe'),
      embeddingModel: readString('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
      embeddingDimensions: readInt('GEMINI_EMBEDDING_DIMENSIONS', 768, 128, 3072),
      timeoutMs: readInt('GEMINI_TIMEOUT_MS', 90000, 1500, 300000),
      transcribeTimeoutMs: readInt('GEMINI_TRANSCRIBE_TIMEOUT_MS', 45000, 2000, 180000),
      dailyQuota: readInt('GEMINI_DAILY_QUOTA', 1000000, 10, 10000000),
    },
    neo4j: {
      enabled: graphRagEnabled,
      configured: neo4jConfigured,
      uri: neo4jUri,
      username: neo4jUsername,
      password: neo4jPassword,
      database: neo4jDatabase,
      instanceId: extractAuraInstanceIdFromUri(neo4jUri),
      maxTraversalDepth: readInt('GRAPHRAG_MAX_TRAVERSAL_DEPTH', 2, 1, 3),
      maxNodes: readInt('GRAPHRAG_MAX_NODES', 50, 5, 200),
      embeddingBatchSize: readInt('GRAPHRAG_EMBEDDING_BATCH_SIZE', 16, 1, 64),
    },
  };
}

export function validateStartupConfig(): StartupValidationReport {
  const cfg = loadAppEnvConfig();
  const warnings: string[] = [];
  const errors: string[] = [];
  const missingRequired: MissingCredentialEntry[] = [];
  const optionalDisabled: OptionalDisabledService[] = [];

  if (!cfg.gemini.configured) {
    warnings.push(
      'GEMINI_API_KEY is not set. Deterministic static/sandbox analysis remains fully operational; AI bug scanning, voice transcription, embeddings, and GraphRAG synthesis are disabled.'
    );
    optionalDisabled.push({
      service: 'Gemini AI (Bug Scan, AutoPatch AI, Voice Transcription, Embeddings)',
      reason: 'GEMINI_API_KEY is not configured; deterministic engine remains active.',
      variables: ['GEMINI_API_KEY'],
      source: 'Google AI Studio Secrets (auto-provided in AI Studio) or https://aistudio.google.com/apikey',
    });
  }

  const anyNeo4jPresent = Boolean(cfg.neo4j.uri || cfg.neo4j.username || cfg.neo4j.password);
  const explicitGraphRagEnabled =
    process.env.GRAPHRAG_ENABLED !== undefined && cfg.neo4j.enabled;

  if (!cfg.neo4j.configured) {
    if (explicitGraphRagEnabled || anyNeo4jPresent) {
      const missingNeo4jVars: Array<{ variable: string; purpose: string }> = [];
      if (!cfg.neo4j.uri) {
        missingNeo4jVars.push({
          variable: 'NEO4J_URI',
          purpose: 'Bolt/Neo4j TLS connection URI for Neo4j AuraDB (e.g. neo4j+s://<instance>.databases.neo4j.io)',
        });
      }
      if (!cfg.neo4j.username) {
        missingNeo4jVars.push({
          variable: 'NEO4J_USERNAME',
          purpose: 'Neo4j AuraDB database username for basic authentication',
        });
      }
      if (!cfg.neo4j.password) {
        missingNeo4jVars.push({
          variable: 'NEO4J_PASSWORD',
          purpose: 'Neo4j AuraDB database password for basic authentication',
        });
      }
      for (const item of missingNeo4jVars) {
        missingRequired.push({
          variable: item.variable,
          service: 'Neo4j AuraDB GraphRAG',
          purpose: item.purpose,
          source: 'Neo4j Aura Console (https://console.neo4j.io) -> Instance Connection Details',
        });
      }
      warnings.push(
        `Neo4j GraphRAG is enabled or partially configured, but missing: ${missingNeo4jVars.map((m) => m.variable).join(', ')}. Core AutoPatch starts normally with GraphRAG degraded.`
      );
    } else {
      optionalDisabled.push({
        service: 'Neo4j AuraDB GraphRAG',
        reason: 'Optional integration disabled because NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD are not set.',
        variables: ['NEO4J_URI', 'NEO4J_USERNAME', 'NEO4J_PASSWORD'],
        source: 'Neo4j Aura Console (https://console.neo4j.io) -> Instance Connection Details',
      });
    }
  } else if (!cfg.neo4j.enabled) {
    optionalDisabled.push({
      service: 'Neo4j AuraDB GraphRAG',
      reason: 'Explicitly disabled via GRAPHRAG_ENABLED=false.',
      variables: ['GRAPHRAG_ENABLED'],
      source: 'Runtime configuration',
    });
  }

  if (!cfg.apiKeyAuthToken) {
    optionalDisabled.push({
      service: 'API Key Authentication Middleware',
      reason: 'Optional self-managed bearer token (AUTOPATCH_API_KEY) is unset; API endpoints operate in local/dev mode.',
      variables: ['AUTOPATCH_API_KEY'],
      source: 'Optional self-generated secret (no external dashboard required)',
    });
  }

  if (cfg.neo4j.uri && !/^(neo4j|neo4j\+s|neo4j\+ssc|bolt|bolt\+s|bolt\+ssc):\/\//i.test(cfg.neo4j.uri)) {
    errors.push('NEO4J_URI must use a valid Neo4j scheme (neo4j+s://, neo4j://, bolt+s://, or bolt://).');
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    missingRequired,
    optionalDisabled,
    secretsStatus: {
      geminiApiKey: cfg.gemini.configured ? 'configured' : 'missing',
      neo4jPassword: cfg.neo4j.password ? 'configured' : 'missing',
      autopatchApiKey: cfg.apiKeyAuthToken ? 'configured' : 'optional-unset',
    },
    features: {
      deterministicEngine: true,
      geminiAi: cfg.gemini.configured,
      graphRagEnabled: cfg.neo4j.enabled,
      graphRagConfigured: cfg.neo4j.configured,
      apiKeyAuthEnabled: Boolean(cfg.apiKeyAuthToken),
    },
  };
}

/**
 * Redacts any configured secret values or common secret patterns from error messages / logs.
 */
export function redactSecrets(input: string): string {
  if (!input) return '';
  let out = input;
  for (const envName of ['GEMINI_API_KEY', 'NEO4J_PASSWORD', 'AUTOPATCH_API_KEY']) {
    const val = process.env[envName]?.trim();
    if (val && val.length >= 4) {
      out = out.split(val).join('[REDACTED]');
    }
  }
  out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]');
  out = out.replace(/sk-[0-9A-Za-z_-]{16,}/g, '[REDACTED_API_KEY]');
  out = out.replace(/gh[pousr]_[0-9A-Za-z]{20,}/g, '[REDACTED_TOKEN]');
  out = out.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');
  out = out.replace(
    /((?:neo4j\+s|neo4j\+ssc|neo4j|bolt\+s|bolt\+ssc|bolt|postgres|postgresql|mysql|mongodb\+srv|mongodb|https?):\/\/)[^:@\s/]+:[^@\s]+@/gi,
    '$1[REDACTED]@'
  );
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  out = out.replace(
    /(password|passwd|secret|token|api[_-]?key|x-api-key|authorization)\s*[:=]\s*['"]?[^\s'",;]+/gi,
    '$1=[REDACTED]'
  );
  return out;
}
