import neo4j from 'neo4j-driver';
import { loadAppEnvConfig, redactSecrets } from '../env_config.ts';
import { generateSingleEmbedding } from '../gemini_client.ts';
import {
  runReadQuery as defaultRunReadQuery,
  toJsNumber,
  VECTOR_INDEX_DEFINITIONS,
} from './neo4j_client.ts';

export type RetrievalMethod =
  | 'vector'
  | 'fulltext'
  | 'exact'
  | 'graph-traversal'
  | 'historical';

export interface RetrievedRelationship {
  type: string;
  direction: 'outgoing' | 'incoming';
  targetId: string;
  targetType: string;
  targetName: string;
  targetFilePath?: string | null;
}

export interface RetrievedEntity {
  entityId: string;
  entityType: string;
  name: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  relevanceScore: number;
  retrievalMethods: RetrievalMethod[];
  summary: string;
  evidenceSnippet: string | null;
  severity?: string | null;
  verificationStatus?: string | null;
  patchDiff?: string | null;
  updatedAt?: string | null;
  relationships: RetrievedRelationship[];
}

export interface HybridRetrievalResult {
  projectId: string;
  query: string;
  entities: RetrievedEntity[];
  relationships: Array<{
    sourceId: string;
    targetId: string;
    type: string;
  }>;
  mechanismsUsed: {
    vector: boolean;
    fulltext: boolean;
    exact: boolean;
    graphTraversal: boolean;
    historical: boolean;
  };
  warnings: string[];
  durationMs: number;
}

export interface RetrievalDeps {
  runReadQuery?: typeof defaultRunReadQuery;
  embedQuery?: (text: string) => Promise<{ values: number[]; model: string; dimensions: number } | null>;
}

export interface HybridRetrieveOptions {
  projectId: string;
  query: string;
  maxDepth?: number;
  maxNodes?: number;
  includeHistorical?: boolean;
  targetFilePath?: string;
  deps?: RetrievalDeps;
}

function escapeLuceneQuery(raw: string): string {
  const tokens = raw
    .replace(/[+\-!(){}[\]^"~*?:\\/]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (tokens.length === 0) return '';
  return tokens.join(' OR ');
}

function extractSearchTokens(raw: string): string[] {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'where', 'when',
    'how', 'why', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'but', 'into',
    'file', 'code', 'bug', 'error', 'issue', 'function', 'class',
  ]);
  const tokens = raw
    .split(/[^A-Za-z0-9_./:-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopWords.has(t.toLowerCase()));
  return Array.from(new Set(tokens)).slice(0, 8);
}

function extractNodeFields(nodeObj: unknown): {
  id: string;
  label: string;
  props: Record<string, unknown>;
} {
  if (!nodeObj || typeof nodeObj !== 'object') {
    return { id: '', label: 'Unknown', props: {} };
  }
  const n = nodeObj as { labels?: string[]; properties?: Record<string, unknown> };
  const props = n.properties && typeof n.properties === 'object' ? n.properties : (nodeObj as Record<string, unknown>);
  const label = Array.isArray(n.labels) && n.labels.length > 0 ? String(n.labels[0]) : String(props.entityType || 'Entity');
  const id = typeof props.id === 'string' ? props.id : '';
  return { id, label, props };
}

function toNullableInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = toJsNumber(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function buildEntityFromProps(
  id: string,
  label: string,
  props: Record<string, unknown>,
  score: number,
  method: RetrievalMethod
): RetrievedEntity {
  const name =
    (typeof props.name === 'string' && props.name) ||
    (typeof props.title === 'string' && props.title) ||
    (typeof props.path === 'string' && props.path) ||
    id;
  const filePath =
    (typeof props.filePath === 'string' && props.filePath) ||
    (typeof props.path === 'string' && props.path) ||
    null;
  const startLine = toNullableInt(props.startLine ?? props.line);
  const endLine = toNullableInt(props.endLine ?? props.line ?? props.startLine);
  const summary =
    (typeof props.summary === 'string' && props.summary) ||
    (typeof props.message === 'string' && props.message) ||
    `${label} ${name}`;
  const snippetRaw =
    (typeof props.codeSnippet === 'string' && props.codeSnippet) ||
    (typeof props.patchDiff === 'string' && props.patchDiff) ||
    null;

  return {
    entityId: id,
    entityType: label,
    name,
    filePath,
    startLine,
    endLine,
    relevanceScore: score,
    retrievalMethods: [method],
    summary: summary.slice(0, 600),
    evidenceSnippet: snippetRaw ? snippetRaw.slice(0, 1200) : null,
    severity: typeof props.severity === 'string' ? props.severity : null,
    verificationStatus:
      typeof props.verificationStatus === 'string' ? props.verificationStatus : null,
    patchDiff: typeof props.patchDiff === 'string' ? props.patchDiff.slice(0, 2000) : null,
    updatedAt: typeof props.updatedAt === 'string' ? props.updatedAt : null,
    relationships: [],
  };
}

function severityBonus(severity?: string | null): number {
  const s = (severity || '').toLowerCase();
  if (s === 'critical') return 0.14;
  if (s === 'error' || s === 'high') return 0.09;
  if (s === 'warning' || s === 'medium') return 0.04;
  return 0;
}

function verificationBonus(status?: string | null): number {
  if (status === 'RUNTIME_VERIFIED') return 0.12;
  if (status === 'STATIC_ANALYSIS_PASSED') return 0.04;
  return 0;
}

function mergeEntity(
  map: Map<string, RetrievedEntity>,
  incoming: RetrievedEntity,
  boostScore: number
): void {
  if (!incoming.entityId) return;
  const existing = map.get(incoming.entityId);
  if (!existing) {
    map.set(incoming.entityId, {
      ...incoming,
      relevanceScore: Number(
        (
          boostScore +
          severityBonus(incoming.severity) +
          verificationBonus(incoming.verificationStatus)
        ).toFixed(4)
      ),
    });
    return;
  }

  for (const m of incoming.retrievalMethods) {
    if (!existing.retrievalMethods.includes(m)) {
      existing.retrievalMethods.push(m);
    }
  }
  // Multi-mechanism agreement raises confidence
  const combined =
    Math.max(existing.relevanceScore, boostScore) +
    0.15 * Math.min(existing.relevanceScore, boostScore) +
    0.05 * (existing.retrievalMethods.length - 1);
  existing.relevanceScore = Number(Math.min(1.99, combined).toFixed(4));
  if (!existing.evidenceSnippet && incoming.evidenceSnippet) {
    existing.evidenceSnippet = incoming.evidenceSnippet;
  }
  if (!existing.filePath && incoming.filePath) {
    existing.filePath = incoming.filePath;
  }
}

/**
 * Genuine 4-mechanism Hybrid GraphRAG Retrieval:
 *  1. Neo4j cosine vector similarity search across all configured entity vector indexes.
 *  2. Neo4j full-text Lucene keyword search (`autopatch_entity_fulltext`).
 *  3. Exact symbol / file-path / entity ID lookup.
 *  4. Bounded knowledge-graph traversal (depth 1..3) + historical finding/patch/incident expansion.
 *
 * Strictly enforces `projectId` isolation on every query and degrades gracefully if vector
 * indexes or embeddings are unavailable.
 */
export async function hybridRetrieve(
  options: HybridRetrieveOptions
): Promise<HybridRetrievalResult> {
  const t0 = performance.now();
  const cfg = loadAppEnvConfig();
  const runReadQuery = options.deps?.runReadQuery ?? defaultRunReadQuery;
  const embedQuery =
    options.deps?.embedQuery ??
    ((text: string) => generateSingleEmbedding(text, 'RETRIEVAL_QUERY'));

  const projectId = options.projectId;
  const query = (options.query || '').trim();
  const maxDepth = Math.max(1, Math.min(3, Math.round(options.maxDepth ?? cfg.neo4j.maxTraversalDepth)));
  const maxNodes = Math.max(4, Math.min(60, Math.round(options.maxNodes ?? cfg.neo4j.maxNodes)));
  const includeHistorical = options.includeHistorical !== false;

  const warnings: string[] = [];
  const entityMap = new Map<string, RetrievedEntity>();
  const edgeSet = new Map<string, { sourceId: string; targetId: string; type: string }>();
  const mechanismsUsed = {
    vector: false,
    fulltext: false,
    exact: false,
    graphTraversal: false,
    historical: false,
  };

  if (!query && !options.targetFilePath) {
    return {
      projectId,
      query,
      entities: [],
      relationships: [],
      mechanismsUsed,
      warnings: ['Empty retrieval query provided.'],
      durationMs: Number((performance.now() - t0).toFixed(1)),
    };
  }

  // -------------------------------------------------------------------------
  // 1. VECTOR SIMILARITY RETRIEVAL (cosine across Neo4j vector indexes)
  // -------------------------------------------------------------------------
  if (query) {
    try {
      const expectedDims = cfg.gemini.embeddingDimensions;
      const emb = await embedQuery(query);
      if (emb && Array.isArray(emb.values) && emb.values.length > 0) {
        if (emb.values.length !== expectedDims) {
          warnings.push(
            `Embedding dimension mismatch (${emb.values.length} vs configured ${expectedDims}); skipping vector index search.`
          );
        } else {
          const perIndexLimit = Math.max(4, Math.min(10, Math.ceil(maxNodes / 2)));
          let vectorHits = 0;
          for (const vdef of VECTOR_INDEX_DEFINITIONS) {
            if (!includeHistorical && ['Finding', 'Vulnerability', 'Patch', 'Incident'].includes(vdef.label)) {
              continue;
            }
            try {
              const res = await runReadQuery(
                `CALL db.index.vector.queryNodes($indexName, $k, $vector)
                 YIELD node, score
                 WHERE node.projectId = $projectId
                 RETURN node, labels(node)[0] AS label, score
                 ORDER BY score DESC
                 LIMIT $limit`,
                {
                  indexName: vdef.name,
                  k: neo4j.int(perIndexLimit * 3),
                  vector: emb.values,
                  projectId,
                  limit: neo4j.int(perIndexLimit),
                }
              );
              for (const rec of res.records) {
                const { id, label, props } = extractNodeFields(rec.get('node'));
                const rawScore = toJsNumber(rec.get('score'));
                if (!id || rawScore < 0.25) continue;
                const resolvedLabel = String(rec.get('label') || label);
                const entity = buildEntityFromProps(id, resolvedLabel, props, rawScore, 'vector');
                mergeEntity(entityMap, entity, rawScore);
                vectorHits++;
              }
            } catch (err) {
              const msg = redactSecrets(err instanceof Error ? err.message : String(err));
              if (!warnings.some((w) => w.includes(vdef.name))) {
                warnings.push(`Vector index ${vdef.name} unavailable: ${msg.slice(0, 120)}`);
              }
            }
          }
          if (vectorHits > 0) {
            mechanismsUsed.vector = true;
          }
        }
      } else {
        warnings.push('Query embedding unavailable; continuing with keyword and graph retrieval.');
      }
    } catch (err) {
      warnings.push(
        `Vector search degraded: ${redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 140)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. FULL-TEXT KEYWORD SEARCH (autopatch_entity_fulltext)
  // -------------------------------------------------------------------------
  const luceneQuery = escapeLuceneQuery(query);
  if (luceneQuery) {
    try {
      const ftRes = await runReadQuery(
        `CALL db.index.fulltext.queryNodes('autopatch_entity_fulltext', $luceneQuery)
         YIELD node, score
         WHERE node.projectId = $projectId
         RETURN node, labels(node)[0] AS label, score
         ORDER BY score DESC
         LIMIT $limit`,
        {
          luceneQuery,
          projectId,
          limit: neo4j.int(Math.min(20, maxNodes)),
        }
      );
      if (ftRes.records.length > 0) {
        mechanismsUsed.fulltext = true;
        const maxFt = Math.max(
          1,
          ...ftRes.records.map((r) => toJsNumber(r.get('score')))
        );
        for (const rec of ftRes.records) {
          const { id, label, props } = extractNodeFields(rec.get('node'));
          if (!id) continue;
          const normScore = Math.min(0.95, 0.35 + 0.55 * (toJsNumber(rec.get('score')) / maxFt));
          const resolvedLabel = String(rec.get('label') || label);
          const entity = buildEntityFromProps(id, resolvedLabel, props, normScore, 'fulltext');
          mergeEntity(entityMap, entity, normScore);
        }
      }
    } catch (err) {
      warnings.push(
        `Full-text index search unavailable: ${redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. EXACT SYMBOL / FILE-PATH / ENTITY LOOKUP
  // -------------------------------------------------------------------------
  const tokens = extractSearchTokens(
    [query, options.targetFilePath || ''].filter(Boolean).join(' ')
  );
  if (tokens.length > 0 || options.targetFilePath) {
    try {
      const exactRes = await runReadQuery(
        `MATCH (n {projectId: $projectId})
         WHERE (n.id = $rawQuery)
            OR ($targetFilePath <> '' AND (n.path = $targetFilePath OR n.filePath = $targetFilePath OR coalesce(n.path, '') ENDS WITH $targetFilePath OR coalesce(n.filePath, '') ENDS WITH $targetFilePath))
            OR ANY(tok IN $tokens WHERE
                 toLower(coalesce(n.name, '')) = toLower(tok)
              OR toLower(coalesce(n.title, '')) CONTAINS toLower(tok)
              OR toLower(coalesce(n.path, '')) CONTAINS toLower(tok)
              OR toLower(coalesce(n.kind, '')) CONTAINS toLower(tok)
            )
         RETURN n AS node, labels(n)[0] AS label
         LIMIT $limit`,
        {
          projectId,
          rawQuery: query,
          targetFilePath: options.targetFilePath || '',
          tokens,
          limit: neo4j.int(Math.min(20, maxNodes)),
        }
      );
      if (exactRes.records.length > 0) {
        mechanismsUsed.exact = true;
        for (const rec of exactRes.records) {
          const { id, label, props } = extractNodeFields(rec.get('node'));
          if (!id) continue;
          const resolvedLabel = String(rec.get('label') || label);
          const isExactIdOrName =
            id === query ||
            (typeof props.name === 'string' &&
              tokens.some((t) => t.toLowerCase() === String(props.name).toLowerCase()));
          const score = isExactIdOrName ? 0.92 : 0.68;
          const entity = buildEntityFromProps(id, resolvedLabel, props, score, 'exact');
          mergeEntity(entityMap, entity, score);
        }
      }
    } catch (err) {
      warnings.push(
        `Exact entity lookup failed: ${redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. BOUNDED KNOWLEDGE GRAPH TRAVERSAL (depth 1..3, project-isolated)
  // -------------------------------------------------------------------------
  const seedIds = Array.from(entityMap.values())
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 8)
    .map((e) => e.entityId);

  if (seedIds.length > 0) {
    try {
      // Cypher variable-length path bound is validated integer 1..3
      const depthPattern = `*1..${maxDepth}`;
      const travRes = await runReadQuery(
        `MATCH (seed {projectId: $projectId})
         WHERE seed.id IN $seedIds
         MATCH p = (seed)-[rels${depthPattern}]-(neighbor {projectId: $projectId})
         WHERE neighbor.id <> seed.id
         WITH seed, neighbor, labels(neighbor)[0] AS nLabel,
              relationships(p) AS pathRels, length(p) AS hop
         ORDER BY hop ASC
         LIMIT $edgeLimit
         RETURN seed.id AS seedId, neighbor, nLabel, hop,
                [r IN pathRels | {
                  type: type(r),
                  startId: startNode(r).id,
                  endId: endNode(r).id
                }] AS relChain`,
        {
          projectId,
          seedIds,
          edgeLimit: neo4j.int(maxNodes * 3),
        }
      );

      if (travRes.records.length > 0) {
        mechanismsUsed.graphTraversal = true;
        for (const rec of travRes.records) {
          const seedId = String(rec.get('seedId') || '');
          const hop = Math.max(1, toJsNumber(rec.get('hop')));
          const { id, label, props } = extractNodeFields(rec.get('neighbor'));
          const resolvedLabel = String(rec.get('nLabel') || label);
          const relChain = (rec.get('relChain') as Array<{
            type: string;
            startId: string;
            endId: string;
          }>) || [];

          if (id && entityMap.size < maxNodes * 2) {
            const decayedScore = Number((0.62 / hop).toFixed(4));
            const entity = buildEntityFromProps(
              id,
              resolvedLabel,
              props,
              decayedScore,
              'graph-traversal'
            );
            mergeEntity(entityMap, entity, decayedScore);
          }

          for (const rel of relChain) {
            if (!rel?.startId || !rel?.endId || !rel?.type) continue;
            const key = `${rel.startId}|${rel.type}|${rel.endId}`;
            if (!edgeSet.has(key)) {
              edgeSet.set(key, {
                sourceId: rel.startId,
                targetId: rel.endId,
                type: rel.type,
              });
            }
          }

          // Attach immediate relationship summary to the seed entity
          const seedEntity = entityMap.get(seedId);
          const neighborEntity = entityMap.get(id);
          if (seedEntity && neighborEntity && relChain.length === 1) {
            const r0 = relChain[0];
            const direction: 'outgoing' | 'incoming' =
              r0.startId === seedId ? 'outgoing' : 'incoming';
            if (
              !seedEntity.relationships.some(
                (r) => r.targetId === id && r.type === r0.type && r.direction === direction
              )
            ) {
              seedEntity.relationships.push({
                type: r0.type,
                direction,
                targetId: id,
                targetType: resolvedLabel,
                targetName: neighborEntity.name,
                targetFilePath: neighborEntity.filePath,
              });
            }
          }
        }
      }
    } catch (err) {
      warnings.push(
        `Graph traversal degraded: ${redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. HISTORICAL FINDINGS / PATCHES / INCIDENTS EXPANSION
  // -------------------------------------------------------------------------
  if (includeHistorical) {
    try {
      const histRes = await runReadQuery(
        `MATCH (h {projectId: $projectId})
         WHERE (h:Finding OR h:Vulnerability OR h:Patch OR h:Incident)
           AND (
             $targetFilePath <> '' AND (coalesce(h.filePath, '') ENDS WITH $targetFilePath OR coalesce(h.path, '') ENDS WITH $targetFilePath)
             OR ANY(tok IN $tokens WHERE
                  toLower(coalesce(h.title, '')) CONTAINS toLower(tok)
               OR toLower(coalesce(h.summary, '')) CONTAINS toLower(tok)
               OR toLower(coalesce(h.kind, '')) CONTAINS toLower(tok)
               OR toLower(coalesce(h.bugType, '')) CONTAINS toLower(tok)
             )
           )
         RETURN h AS node, labels(h)[0] AS label
         LIMIT 10`,
        {
          projectId,
          targetFilePath: options.targetFilePath || '',
          tokens,
        }
      );
      if (histRes.records.length > 0) {
        mechanismsUsed.historical = true;
        for (const rec of histRes.records) {
          const { id, label, props } = extractNodeFields(rec.get('node'));
          if (!id) continue;
          const resolvedLabel = String(rec.get('label') || label);
          const entity = buildEntityFromProps(id, resolvedLabel, props, 0.72, 'historical');
          mergeEntity(entityMap, entity, 0.72);
        }
      }
    } catch (err) {
      warnings.push(
        `Historical retrieval degraded: ${redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
      );
    }
  }

  const rankedEntities = Array.from(entityMap.values())
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxNodes);

  const keptIds = new Set(rankedEntities.map((e) => e.entityId));
  const keptEdges = Array.from(edgeSet.values()).filter(
    (e) => keptIds.has(e.sourceId) && keptIds.has(e.targetId)
  );

  return {
    projectId,
    query,
    entities: rankedEntities,
    relationships: keptEdges,
    mechanismsUsed,
    warnings,
    durationMs: Number((performance.now() - t0).toFixed(1)),
  };
}

/**
 * Returns a bounded subgraph of persisted Neo4j nodes and relationships for a single project.
 */
export async function getProjectSubgraph(
  projectId: string,
  limit = 80,
  deps?: RetrievalDeps
): Promise<{
  projectId: string;
  nodes: Array<{
    id: string;
    label: string;
    name: string;
    filePath: string | null;
    startLine: number | null;
    severity?: string | null;
    verificationStatus?: string | null;
    hasEmbedding: boolean;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
  }>;
}> {
  const runReadQuery = deps?.runReadQuery ?? defaultRunReadQuery;
  const safeLimit = Math.max(10, Math.min(200, Math.round(limit)));

  const nodeRes = await runReadQuery(
    `MATCH (n {projectId: $projectId})
     RETURN n.id AS id, labels(n)[0] AS label,
            coalesce(n.name, n.title, n.path, n.id) AS name,
            coalesce(n.filePath, n.path) AS filePath,
            coalesce(n.startLine, n.line) AS startLine,
            n.severity AS severity,
            n.verificationStatus AS verificationStatus,
            (n.embedding IS NOT NULL) AS hasEmbedding
     LIMIT $limit`,
    { projectId, limit: neo4j.int(safeLimit) }
  );

  const nodes = nodeRes.records.map((rec) => ({
    id: String(rec.get('id')),
    label: String(rec.get('label') || 'Entity'),
    name: String(rec.get('name') || ''),
    filePath: rec.get('filePath') ? String(rec.get('filePath')) : null,
    startLine: toNullableInt(rec.get('startLine')),
    severity: rec.get('severity') ? String(rec.get('severity')) : null,
    verificationStatus: rec.get('verificationStatus')
      ? String(rec.get('verificationStatus'))
      : null,
    hasEmbedding: Boolean(rec.get('hasEmbedding')),
  }));

  const nodeIds = nodes.map((n) => n.id);
  if (nodeIds.length === 0) {
    return { projectId, nodes: [], edges: [] };
  }

  const edgeRes = await runReadQuery(
    `MATCH (a {projectId: $projectId})-[r]->(b {projectId: $projectId})
     WHERE a.id IN $nodeIds AND b.id IN $nodeIds
     RETURN a.id AS source, b.id AS target, type(r) AS type
     LIMIT $edgeLimit`,
    { projectId, nodeIds, edgeLimit: neo4j.int(safeLimit * 3) }
  );

  const edges = edgeRes.records.map((rec) => ({
    source: String(rec.get('source')),
    target: String(rec.get('target')),
    type: String(rec.get('type')),
  }));

  return { projectId, nodes, edges };
}

/**
 * Retrieves detailed properties and direct 1-hop relationships for a specific entity,
 * strictly enforcing project isolation.
 */
export async function getProjectEntityDetails(
  projectId: string,
  entityId: string,
  deps?: RetrievalDeps
): Promise<{
  found: boolean;
  entity: RetrievedEntity | null;
  properties: Record<string, unknown> | null;
}> {
  const runReadQuery = deps?.runReadQuery ?? defaultRunReadQuery;

  const res = await runReadQuery(
    `MATCH (n {projectId: $projectId, id: $entityId})
     OPTIONAL MATCH (n)-[r]-(m {projectId: $projectId})
     RETURN n AS node, labels(n)[0] AS label,
            collect(DISTINCT CASE WHEN m IS NOT NULL THEN {
              type: type(r),
              direction: CASE WHEN startNode(r).id = n.id THEN 'outgoing' ELSE 'incoming' END,
              targetId: m.id,
              targetType: labels(m)[0],
              targetName: coalesce(m.name, m.title, m.path, m.id),
              targetFilePath: coalesce(m.filePath, m.path)
            } END) AS rels
     LIMIT 1`,
    { projectId, entityId }
  );

  if (res.records.length === 0) {
    return { found: false, entity: null, properties: null };
  }

  const rec = res.records[0];
  const { id, label, props } = extractNodeFields(rec.get('node'));
  const resolvedLabel = String(rec.get('label') || label);
  const entity = buildEntityFromProps(id, resolvedLabel, props, 1.0, 'exact');

  const rawRels = (rec.get('rels') as Array<RetrievedRelationship | null>) || [];
  entity.relationships = rawRels.filter((r): r is RetrievedRelationship => Boolean(r && r.targetId));

  // Strip raw embedding vector from public entity detail response to keep payloads crisp
  const cleanProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'embedding') {
      cleanProps.hasEmbedding = Array.isArray(v) && v.length > 0;
      cleanProps.embeddingDimensions = Array.isArray(v) ? v.length : 0;
    } else {
      cleanProps[k] = v;
    }
  }

  return { found: true, entity, properties: cleanProps };
}
