import neo4j, { type Driver, type ManagedTransaction, type QueryResult } from 'neo4j-driver';
import { loadAppEnvConfig, redactSecrets } from '../env_config.ts';

let driverInstance: Driver | null = null;
let driverKey = '';
let schemaInitialized = false;

export interface Neo4jHealthStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  database: string;
  instanceId: string | null;
  schemaInitialized: boolean;
  latencyMs?: number;
  error?: string;
}

export interface GraphEntityCounts {
  totalNodes: number;
  totalRelationships: number;
  embeddedNodes: number;
  byLabel: Record<string, number>;
}

/**
 * Returns a pooled Neo4j Driver configured from environment variables.
 * Never logs or exposes NEO4J_PASSWORD. Returns null gracefully when GraphRAG
 * is disabled or credentials are missing.
 */
export function getNeo4jDriver(): Driver | null {
  const cfg = loadAppEnvConfig().neo4j;
  if (!cfg.enabled || !cfg.configured || !cfg.uri || !cfg.username || !cfg.password) {
    return null;
  }

  const nextKey = `${cfg.uri}|${cfg.username}|${cfg.database}`;
  if (driverInstance && driverKey === nextKey) {
    return driverInstance;
  }

  if (driverInstance) {
    driverInstance.close().catch(() => {});
    driverInstance = null;
    schemaInitialized = false;
  }

  driverInstance = neo4j.driver(
    cfg.uri,
    neo4j.auth.basic(cfg.username, cfg.password),
    {
      maxConnectionPoolSize: 20,
      connectionAcquisitionTimeout: 10_000,
      connectionTimeout: 10_000,
      maxTransactionRetryTime: 10_000,
    }
  );
  driverKey = nextKey;
  return driverInstance;
}

export async function closeNeo4jDriver(): Promise<void> {
  if (driverInstance) {
    try {
      await driverInstance.close();
    } finally {
      driverInstance = null;
      driverKey = '';
      schemaInitialized = false;
    }
  }
}

function isTransientNeo4jError(err: unknown): boolean {
  const code = (err as { code?: string })?.code || '';
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code.startsWith('Neo.TransientError') ||
    /ServiceUnavailable|SessionExpired|ECONNRESET|ETIMEDOUT|Connection acquisition timed out/i.test(msg)
  );
}

/**
 * Executes a read transaction against the configured Neo4j database with bounded retry.
 */
export async function runReadQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult> {
  const driver = getNeo4jDriver();
  if (!driver) {
    throw new Error('Neo4j GraphRAG is not configured or disabled.');
  }
  const database = loadAppEnvConfig().neo4j.database;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.READ });
    try {
      return await session.executeRead((tx: ManagedTransaction) => tx.run(cypher, params));
    } catch (err) {
      lastErr = err;
      if (attempt < 2 && isTransientNeo4jError(err)) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
    } finally {
      await session.close();
    }
  }
  throw new Error(redactSecrets(lastErr instanceof Error ? lastErr.message : 'Neo4j read failed.'));
}

/**
 * Executes a write transaction against the configured Neo4j database with bounded retry.
 */
export async function runWriteQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult> {
  const driver = getNeo4jDriver();
  if (!driver) {
    throw new Error('Neo4j GraphRAG is not configured or disabled.');
  }
  const database = loadAppEnvConfig().neo4j.database;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const session = driver.session({ database, defaultAccessMode: neo4j.session.WRITE });
    try {
      return await session.executeWrite((tx: ManagedTransaction) => tx.run(cypher, params));
    } catch (err) {
      lastErr = err;
      if (attempt < 2 && isTransientNeo4jError(err)) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
    } finally {
      await session.close();
    }
  }
  throw new Error(redactSecrets(lastErr instanceof Error ? lastErr.message : 'Neo4j write failed.'));
}

export async function verifyNeo4jConnection(): Promise<Neo4jHealthStatus> {
  const cfg = loadAppEnvConfig().neo4j;
  const base: Neo4jHealthStatus = {
    enabled: cfg.enabled,
    configured: cfg.configured,
    connected: false,
    database: cfg.database,
    instanceId: cfg.instanceId,
    schemaInitialized,
  };

  if (!cfg.enabled) {
    return { ...base, error: 'GRAPHRAG_ENABLED is false.' };
  }
  if (!cfg.configured) {
    const missing = [
      !cfg.uri ? 'NEO4J_URI' : null,
      !cfg.username ? 'NEO4J_USERNAME' : null,
      !cfg.password ? 'NEO4J_PASSWORD' : null,
    ].filter(Boolean);
    return {
      ...base,
      error: `Neo4j credentials missing (${missing.join(', ')}). GraphRAG is disabled.`,
    };
  }

  const driver = getNeo4jDriver();
  if (!driver) {
    return { ...base, error: 'Unable to initialize Neo4j driver.' };
  }

  const t0 = performance.now();
  try {
    await driver.verifyConnectivity({ database: cfg.database });
    const ping = await runReadQuery('RETURN 1 AS ok');
    const ok = ping.records.length > 0;
    return {
      ...base,
      connected: ok,
      schemaInitialized,
      latencyMs: Number((performance.now() - t0).toFixed(1)),
    };
  } catch (err) {
    return {
      ...base,
      connected: false,
      latencyMs: Number((performance.now() - t0).toFixed(1)),
      error: redactSecrets(err instanceof Error ? err.message : 'Neo4j connectivity check failed.'),
    };
  }
}

export const GRAPH_ENTITY_LABELS = [
  'Project',
  'File',
  'Function',
  'Class',
  'Dependency',
  'Finding',
  'Vulnerability',
  'Test',
  'Patch',
  'Incident',
  'Commit',
] as const;

export const VECTOR_INDEX_DEFINITIONS = [
  { name: 'function_embedding_idx', label: 'Function', property: 'embedding' },
  { name: 'finding_embedding_idx', label: 'Finding', property: 'embedding' },
  { name: 'vulnerability_embedding_idx', label: 'Vulnerability', property: 'embedding' },
  { name: 'patch_embedding_idx', label: 'Patch', property: 'embedding' },
  { name: 'test_embedding_idx', label: 'Test', property: 'embedding' },
  { name: 'incident_embedding_idx', label: 'Incident', property: 'embedding' },
] as const;

/**
 * Initializes all uniqueness constraints, range indexes, full-text keyword index,
 * and Neo4j cosine vector indexes using the configured Gemini embedding dimensionality.
 */
export async function initializeGraphSchema(): Promise<{
  ok: boolean;
  constraintsCreated: number;
  indexesCreated: number;
  vectorIndexesCreated: number;
  embeddingDimensions: number;
  errors: string[];
}> {
  const dims = loadAppEnvConfig().gemini.embeddingDimensions;
  const errors: string[] = [];
  let constraintsCreated = 0;
  let indexesCreated = 0;
  let vectorIndexesCreated = 0;

  // 1. Uniqueness constraints on stable `id` for all 11 entity labels
  for (const label of GRAPH_ENTITY_LABELS) {
    const cname = `uniq_${label.toLowerCase()}_id`;
    try {
      await runWriteQuery(
        `CREATE CONSTRAINT ${cname} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`
      );
      constraintsCreated++;
    } catch (err) {
      errors.push(`${cname}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  }

  // 2. Project-scoped lookup indexes
  const rangeStatements: Array<{ name: string; cypher: string }> = [
    {
      name: 'idx_file_project_path',
      cypher: 'CREATE INDEX idx_file_project_path IF NOT EXISTS FOR (f:File) ON (f.projectId, f.path)',
    },
    {
      name: 'idx_function_project_name',
      cypher: 'CREATE INDEX idx_function_project_name IF NOT EXISTS FOR (fn:Function) ON (fn.projectId, fn.name)',
    },
    {
      name: 'idx_class_project_name',
      cypher: 'CREATE INDEX idx_class_project_name IF NOT EXISTS FOR (c:Class) ON (c.projectId, c.name)',
    },
    {
      name: 'idx_finding_project_severity',
      cypher: 'CREATE INDEX idx_finding_project_severity IF NOT EXISTS FOR (fd:Finding) ON (fd.projectId, fd.severity)',
    },
    {
      name: 'idx_patch_project_status',
      cypher: 'CREATE INDEX idx_patch_project_status IF NOT EXISTS FOR (p:Patch) ON (p.projectId, p.verificationStatus)',
    },
    {
      name: 'idx_test_project_name',
      cypher: 'CREATE INDEX idx_test_project_name IF NOT EXISTS FOR (t:Test) ON (t.projectId, t.name)',
    },
  ];

  for (const stmt of rangeStatements) {
    try {
      await runWriteQuery(stmt.cypher);
      indexesCreated++;
    } catch (err) {
      errors.push(`${stmt.name}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  }

  // 3. Full-text index for exact keyword retrieval across entities
  try {
    await runWriteQuery(
      `CREATE FULLTEXT INDEX autopatch_entity_fulltext IF NOT EXISTS
       FOR (n:File|Function|Class|Finding|Vulnerability|Patch|Test|Incident)
       ON EACH [n.name, n.title, n.summary, n.path, n.codeSnippet]`
    );
    indexesCreated++;
  } catch (err) {
    errors.push(`fulltext: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
  }

  // 4. Cosine vector indexes matched to GEMINI_EMBEDDING_DIMENSIONS
  for (const vdef of VECTOR_INDEX_DEFINITIONS) {
    try {
      await runWriteQuery(
        `CREATE VECTOR INDEX ${vdef.name} IF NOT EXISTS
         FOR (n:${vdef.label}) ON (n.${vdef.property})
         OPTIONS {
           indexConfig: {
             \`vector.dimensions\`: ${dims},
             \`vector.similarity_function\`: 'cosine'
           }
         }`
      );
      vectorIndexesCreated++;
    } catch (err) {
      errors.push(`${vdef.name}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    }
  }

  schemaInitialized = errors.length === 0;
  return {
    ok: errors.length === 0,
    constraintsCreated,
    indexesCreated,
    vectorIndexesCreated,
    embeddingDimensions: dims,
    errors,
  };
}

export function toJsNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object' && 'toNumber' in val && typeof (val as { toNumber: () => number }).toNumber === 'function') {
    return (val as { toNumber: () => number }).toNumber();
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reads actual persisted node, relationship, and embedding counts for a project directly from Neo4j.
 */
export async function getProjectGraphCounts(projectId: string): Promise<GraphEntityCounts> {
  const labelRes = await runReadQuery(
    `MATCH (n {projectId: $projectId})
     WITH labels(n)[0] AS label, count(n) AS cnt,
          sum(CASE WHEN n.embedding IS NOT NULL THEN 1 ELSE 0 END) AS embCnt
     RETURN label, cnt, embCnt`,
    { projectId }
  );

  const byLabel: Record<string, number> = {};
  let totalNodes = 0;
  let embeddedNodes = 0;

  for (const rec of labelRes.records) {
    const label = String(rec.get('label') || 'Unknown');
    const cnt = toJsNumber(rec.get('cnt'));
    const emb = toJsNumber(rec.get('embCnt'));
    byLabel[label] = cnt;
    totalNodes += cnt;
    embeddedNodes += emb;
  }

  // Also include the Project node itself if present
  const projRes = await runReadQuery(
    `MATCH (p:Project {id: $projNodeId}) RETURN count(p) AS cnt`,
    { projNodeId: `project:${projectId}` }
  );
  const projCnt = projRes.records[0] ? toJsNumber(projRes.records[0].get('cnt')) : 0;
  if (projCnt > 0 && !byLabel.Project) {
    byLabel.Project = projCnt;
    totalNodes += projCnt;
  }

  const relRes = await runReadQuery(
    `MATCH (a)-[r]->(b)
     WHERE (a.projectId = $projectId OR a.id = $projNodeId)
       AND (b.projectId = $projectId OR b.id = $projNodeId)
     RETURN count(r) AS relCount`,
    { projectId, projNodeId: `project:${projectId}` }
  );
  const totalRelationships = relRes.records[0] ? toJsNumber(relRes.records[0].get('relCount')) : 0;

  return {
    totalNodes,
    totalRelationships,
    embeddedNodes,
    byLabel,
  };
}
