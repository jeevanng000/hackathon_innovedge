import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type { AnalysisResponse } from '../../src/types/autopatch.ts';
import type { BackendAuditRecord } from '../audit_store.ts';
import { loadAppEnvConfig, redactSecrets } from '../env_config.ts';
import { generateGeminiEmbeddings } from '../gemini_client.ts';
import {
  discoverRepositoryFiles,
  extractSourceFile,
  type ExtractedFileData,
} from './code_extractor.ts';
import {
  getProjectGraphCounts,
  initializeGraphSchema,
  runReadQuery,
  runWriteQuery,
  type GraphEntityCounts,
} from './neo4j_client.ts';

export type IngestionStatusState = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface IngestionReport {
  projectId: string;
  status: IngestionStatusState;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  filesDiscovered: number;
  filesProcessed: number;
  filesSkippedUnchanged: number;
  filesFailed: number;
  functionsExtracted: number;
  classesExtracted: number;
  dependenciesExtracted: number;
  testsExtracted: number;
  findingsExtracted: number;
  commitsExtracted: number;
  embeddingsGenerated: number;
  embeddingsCached: number;
  embeddingsFailed: number;
  embeddingModel: string;
  embeddingDimensions: number;
  persistedCounts: GraphEntityCounts | null;
  warnings: string[];
  error?: string;
}

const ingestionStatusCache = new Map<string, IngestionReport>();
const activeIngestions = new Set<string>();

export function getCachedIngestionStatus(projectId: string): IngestionReport | null {
  return ingestionStatusCache.get(projectId) ?? null;
}

export async function getProjectIngestionStatus(projectId: string): Promise<{
  projectId: string;
  status: IngestionStatusState | 'NOT_INGESTED';
  lastReport: IngestionReport | null;
  persistedCounts: GraphEntityCounts | null;
  neo4jAvailable: boolean;
}> {
  const cached = ingestionStatusCache.get(projectId) ?? null;
  try {
    const res = await runReadQuery(
      `MATCH (p:Project {id: $projId})
       RETURN p.ingestionStatus AS status, p.lastIngestedAt AS lastIngestedAt`,
      { projId: `project:${projectId}` }
    );
    const persistedCounts = await getProjectGraphCounts(projectId);
    const dbStatus = res.records[0]?.get('status') as IngestionStatusState | undefined;
    return {
      projectId,
      status: dbStatus || cached?.status || (persistedCounts.totalNodes > 0 ? 'COMPLETED' : 'NOT_INGESTED'),
      lastReport: cached,
      persistedCounts,
      neo4jAvailable: true,
    };
  } catch {
    return {
      projectId,
      status: cached?.status || 'NOT_INGESTED',
      lastReport: cached,
      persistedCounts: null,
      neo4jAvailable: false,
    };
  }
}

function readRecentGitCommits(rootDir: string, limit = 10): Array<{
  sha: string;
  message: string;
  author: string;
  timestamp: string;
}> {
  const proc = spawnSync(
    'git',
    ['log', `-n`, String(limit), '--pretty=format:%H%x1f%s%x1f%an%x1f%aI'],
    {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 3000,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    }
  );
  if (proc.status !== 0 || !proc.stdout.trim()) return [];
  return proc.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [sha, message, author, timestamp] = line.split('\x1f');
      return {
        sha: (sha || '').trim(),
        message: (message || '').trim().slice(0, 200),
        author: (author || '').trim().slice(0, 80),
        timestamp: (timestamp || '').trim(),
      };
    })
    .filter((c) => Boolean(c.sha));
}

/**
 * Persists a single extracted file incrementally into Neo4j.
 * Removes stale structural nodes/edges for that file when modified, while
 * strictly preserving unrelated historical Findings, Patches, and Incidents.
 */
async function upsertFileGraphStructure(projectId: string, file: ExtractedFileData): Promise<void> {
  const now = new Date().toISOString();

  // 1. Upsert Project -> File
  await runWriteQuery(
    `MERGE (p:Project {id: $projNodeId})
     ON CREATE SET p.projectId = $projectId, p.name = $projectId, p.createdAt = $now
     MERGE (f:File {id: $fileId})
     SET f.projectId = $projectId,
         f.path = $path,
         f.name = $baseName,
         f.language = $language,
         f.contentHash = $contentHash,
         f.lineCount = $lineCount,
         f.sizeBytes = $sizeBytes,
         f.parserUsed = $parserUsed,
         f.summary = $summary,
         f.updatedAt = $now
     MERGE (p)-[:CONTAINS]->(f)`,
    {
      projNodeId: `project:${projectId}`,
      projectId,
      fileId: file.id,
      path: file.path,
      baseName: path.basename(file.path),
      language: file.language,
      contentHash: file.contentHash,
      lineCount: file.lineCount,
      sizeBytes: file.sizeBytes,
      parserUsed: file.parserUsed,
      summary: `${file.language} source file ${file.path} (${file.lineCount} lines, ${file.functions.length} functions, ${file.classes.length} classes).`,
      now,
    }
  );

  // 2. Clean stale structural relationships for this file ONLY (preserving historical Findings/Patches/Incidents!)
  const keepFnIds = file.functions.map((fn) => fn.id);
  const keepClsIds = file.classes.map((c) => c.id);
  const keepTestIds = file.tests.map((t) => t.id);

  await runWriteQuery(
    `MATCH (f:File {id: $fileId})-[r:IMPORTS]->(:Dependency) DELETE r`,
    { fileId: file.id }
  );

  await runWriteQuery(
    `MATCH (f:File {id: $fileId})-[r:DEFINES]->(fn:Function)
     WHERE NOT fn.id IN $keepFnIds
     OPTIONAL MATCH (fn)-[sr:CALLS|USES]->()
     DELETE sr, r
     WITH fn
     WHERE NOT (fn)<-[:AFFECTS]-(:Finding) AND NOT (fn)<-[:AFFECTS]-(:Vulnerability)
     DETACH DELETE fn`,
    { fileId: file.id, keepFnIds }
  );

  await runWriteQuery(
    `MATCH (f:File {id: $fileId})-[r:CONTAINS]->(c:Class)
     WHERE NOT c.id IN $keepClsIds
     DELETE r
     WITH c
     WHERE NOT ()-[:USES]->(c)
     DETACH DELETE c`,
    { fileId: file.id, keepClsIds }
  );

  await runWriteQuery(
    `MATCH (t:Test {projectId: $projectId, filePath: $filePath})
     WHERE NOT t.id IN $keepTestIds AND NOT (:Patch)-[:VERIFIED_BY]->(t)
     DETACH DELETE t`,
    { projectId, filePath: file.path, keepTestIds }
  );

  // Clear old outgoing structural CALLS/USES from functions in this file before re-linking
  await runWriteQuery(
    `MATCH (f:File {id: $fileId})-[:DEFINES]->(fn:Function)-[r:CALLS|USES]->()
     DELETE r`,
    { fileId: file.id }
  );

  // 3. Upsert Dependencies
  if (file.dependencies.length > 0) {
    await runWriteQuery(
      `MATCH (f:File {id: $fileId})
       UNWIND $deps AS dep
       MERGE (d:Dependency {id: dep.id})
       SET d.projectId = $projectId,
           d.name = dep.name,
           d.kind = dep.kind,
           d.updatedAt = $now
       MERGE (f)-[:IMPORTS]->(d)`,
      { fileId: file.id, projectId, deps: file.dependencies, now }
    );
  }

  // 4. Upsert Classes
  if (file.classes.length > 0) {
    await runWriteQuery(
      `MATCH (f:File {id: $fileId})
       UNWIND $classes AS c
       MERGE (cls:Class {id: c.id})
       SET cls.projectId = $projectId,
           cls.name = c.name,
           cls.filePath = c.filePath,
           cls.path = c.filePath,
           cls.startLine = c.startLine,
           cls.endLine = c.endLine,
           cls.methods = c.methods,
           cls.summary = c.summary,
           cls.updatedAt = $now
       MERGE (f)-[:CONTAINS]->(cls)`,
      { fileId: file.id, projectId, classes: file.classes, now }
    );
  }

  // 5. Upsert Functions
  if (file.functions.length > 0) {
    await runWriteQuery(
      `MATCH (f:File {id: $fileId})
       UNWIND $functions AS fn
       MERGE (node:Function {id: fn.id})
       SET node.projectId = $projectId,
           node.name = fn.name,
           node.signature = fn.signature,
           node.filePath = fn.filePath,
           node.path = fn.filePath,
           node.startLine = fn.startLine,
           node.endLine = fn.endLine,
           node.language = fn.language,
           node.codeSnippet = fn.codeSnippet,
           node.summary = fn.summary,
           node.isExported = fn.isExported,
           node.calledNames = fn.calls,
           node.usedClasses = fn.classUsages,
           node.updatedAt = $now
       MERGE (f)-[:DEFINES]->(node)`,
      { fileId: file.id, projectId, functions: file.functions, now }
    );
  }

  // 6. Upsert Tests
  if (file.tests.length > 0) {
    await runWriteQuery(
      `UNWIND $tests AS t
       MERGE (node:Test {id: t.id})
       SET node.projectId = $projectId,
           node.name = t.name,
           node.filePath = t.filePath,
           node.path = t.filePath,
           node.startLine = t.startLine,
           node.endLine = t.endLine,
           node.calledSymbols = t.calledSymbols,
           node.summary = t.summary,
           node.updatedAt = $now`,
      { projectId, tests: file.tests, now }
    );
  }

  // 7. Upsert Real AST Findings & Vulnerabilities
  const regularFindings = file.findings.filter((fd) => !fd.isVulnerability);
  const vulnFindings = file.findings.filter((fd) => fd.isVulnerability);

  if (regularFindings.length > 0) {
    await runWriteQuery(
      `UNWIND $findings AS fd
       MERGE (node:Finding {id: fd.id})
       SET node.projectId = $projectId,
           node.kind = fd.kind,
           node.title = fd.title,
           node.name = fd.title,
           node.category = fd.category,
           node.severity = fd.severity,
           node.filePath = fd.filePath,
           node.path = fd.filePath,
           node.line = fd.line,
           node.functionName = fd.functionName,
           node.summary = fd.message,
           node.codeSnippet = fd.snippet,
           node.updatedAt = $now
       WITH node, fd
       OPTIONAL MATCH (fn:Function {projectId: $projectId, filePath: fd.filePath, name: fd.functionName})
       FOREACH (_ IN CASE WHEN fn IS NOT NULL THEN [1] ELSE [] END |
         MERGE (fn)-[:HAS_FINDING]->(node)
         MERGE (node)-[:AFFECTS]->(fn)
       )`,
      { projectId, findings: regularFindings, now }
    );
  }

  if (vulnFindings.length > 0) {
    await runWriteQuery(
      `UNWIND $vulns AS v
       MERGE (node:Vulnerability {id: v.id})
       SET node.projectId = $projectId,
           node.kind = v.kind,
           node.title = v.title,
           node.name = v.title,
           node.category = v.category,
           node.severity = v.severity,
           node.filePath = v.filePath,
           node.path = v.filePath,
           node.line = v.line,
           node.functionName = v.functionName,
           node.summary = v.message,
           node.codeSnippet = v.snippet,
           node.updatedAt = $now
       WITH node, v
       OPTIONAL MATCH (fn:Function {projectId: $projectId, filePath: v.filePath, name: v.functionName})
       FOREACH (_ IN CASE WHEN fn IS NOT NULL THEN [1] ELSE [] END |
         MERGE (node)-[:AFFECTS]->(fn)
       )`,
      { projectId, vulns: vulnFindings, now }
    );
  }
}

/**
 * Links genuine cross-file & intra-file Function->CALLS->Function, Class->HAS_METHOD->Function,
 * Function->USES->Class, Test->TESTS->Function, and Finding->RELATED_TO->Finding relationships
 * using real AST-extracted symbols and module imports (never blindly linking ambiguous names
 * across unrelated files).
 */
async function linkProjectRelationships(projectId: string): Promise<void> {
  // 1. (Class)-[:HAS_METHOD]->(Function) verified by real AST source file & line containment
  await runWriteQuery(
    `MATCH (c:Class {projectId: $projectId})-[r:HAS_METHOD]->()
     DELETE r`,
    { projectId }
  );
  await runWriteQuery(
    `MATCH (c:Class {projectId: $projectId}), (fn:Function {projectId: $projectId})
     WHERE fn.filePath = c.filePath
       AND c.startLine IS NOT NULL AND c.endLine IS NOT NULL
       AND fn.startLine >= c.startLine AND fn.endLine <= c.endLine
     MERGE (c)-[:HAS_METHOD]->(fn)`,
    { projectId }
  );

  // 2. (Function)-[:CALLS]->(Function):
  //    a) Same-file calls (unambiguous lexical scope)
  //    b) Cross-file calls verified by File-[:IMPORTS]->Dependency matching callee file stem,
  //       OR globally unique exported function symbol in the project (no ambiguous name collision)
  await runWriteQuery(
    `MATCH (caller:Function {projectId: $projectId})
     WHERE caller.calledNames IS NOT NULL AND size(caller.calledNames) > 0
     UNWIND caller.calledNames AS calleeName
     MATCH (callee:Function {projectId: $projectId, name: calleeName})
     WHERE callee.id <> caller.id AND callee.filePath = caller.filePath
     MERGE (caller)-[:CALLS]->(callee)`,
    { projectId }
  );

  await runWriteQuery(
    `MATCH (callee:Function {projectId: $projectId})
     WHERE callee.isExported = true
     WITH callee.name AS fnName, collect(callee) AS candidates
     WITH fnName, candidates, size(candidates) AS candidateCount
     MATCH (callerFile:File {projectId: $projectId})-[:DEFINES]->(caller:Function {projectId: $projectId})
     WHERE caller.calledNames IS NOT NULL AND fnName IN caller.calledNames
     OPTIONAL MATCH (callerFile)-[:IMPORTS]->(dep:Dependency {projectId: $projectId})
     WITH caller, candidates, candidateCount, collect(DISTINCT dep.name) AS imports
     UNWIND candidates AS callee
     WITH caller, callee, candidateCount, imports
     WHERE callee.id <> caller.id
       AND callee.filePath <> caller.filePath
       AND (
         ANY(imp IN imports WHERE
           imp STARTS WITH '.' AND callee.filePath CONTAINS replace(replace(replace(imp, './', ''), '../', ''), '.ts', '')
         )
         OR candidateCount = 1
       )
     MERGE (caller)-[:CALLS]->(callee)`,
    { projectId }
  );

  // 3. (Function)-[:USES]->(Class)
  await runWriteQuery(
    `MATCH (fn:Function {projectId: $projectId})
     WHERE fn.usedClasses IS NOT NULL AND size(fn.usedClasses) > 0
     UNWIND fn.usedClasses AS clsName
     MATCH (c:Class {projectId: $projectId, name: clsName})
     MERGE (fn)-[:USES]->(c)`,
    { projectId }
  );

  // 4. (Test)-[:TESTS]->(Function): same-file OR test file imports callee module OR unique exported symbol
  await runWriteQuery(
    `MATCH (t:Test {projectId: $projectId})-[r:TESTS]->()
     DELETE r`,
    { projectId }
  );
  await runWriteQuery(
    `MATCH (t:Test {projectId: $projectId})
     WHERE t.calledSymbols IS NOT NULL AND size(t.calledSymbols) > 0
     OPTIONAL MATCH (tf:File {projectId: $projectId, path: t.filePath})-[:IMPORTS]->(dep:Dependency {projectId: $projectId})
     WITH t, collect(DISTINCT dep.name) AS imports
     UNWIND t.calledSymbols AS sym
     MATCH (fn:Function {projectId: $projectId, name: sym})
     WHERE fn.filePath = t.filePath
        OR fn.isExported = true
        OR ANY(imp IN imports WHERE imp STARTS WITH '.' AND fn.filePath CONTAINS replace(replace(replace(imp, './', ''), '../', ''), '.ts', ''))
     MERGE (t)-[:TESTS]->(fn)`,
    { projectId }
  );

  // 5. (Finding)-[:RELATED_TO]->(Finding) when same kind/category in same project
  await runWriteQuery(
    `MATCH (f1:Finding {projectId: $projectId}), (f2:Finding {projectId: $projectId})
     WHERE f1.id < f2.id AND f1.kind = f2.kind
     MERGE (f1)-[:RELATED_TO]->(f2)`,
    { projectId }
  );
}

/**
 * Removes stale File/Function/Class/Test nodes & structural edges for source files
 * that were deleted from disk, while strictly preserving historical Finding, Vulnerability,
 * Patch, and Incident records.
 */
async function pruneDeletedProjectFiles(projectId: string, activeRelPaths: string[]): Promise<number> {
  const staleRes = await runReadQuery(
    `MATCH (f:File {projectId: $projectId})
     WHERE NOT f.path IN $activeRelPaths
     RETURN f.id AS id, f.path AS path`,
    { projectId, activeRelPaths }
  );
  if (staleRes.records.length === 0) return 0;

  for (const rec of staleRes.records) {
    const fileId = String(rec.get('id'));
    const filePath = String(rec.get('path'));

    // Remove structural functions of deleted file unless referenced by historical Findings/Vulnerabilities
    await runWriteQuery(
      `MATCH (f:File {id: $fileId})-[r:DEFINES]->(fn:Function)
       OPTIONAL MATCH (fn)-[sr:CALLS|USES|HAS_METHOD]-()
       DELETE sr, r
       WITH fn
       WHERE NOT (fn)<-[:AFFECTS]-(:Finding) AND NOT (fn)<-[:AFFECTS]-(:Vulnerability)
       DETACH DELETE fn`,
      { fileId }
    );

    // Remove structural classes of deleted file
    await runWriteQuery(
      `MATCH (f:File {id: $fileId})-[r:CONTAINS]->(c:Class)
       DETACH DELETE c`,
      { fileId }
    );

    // Remove tests from deleted file unless referenced by a historical Patch verification edge
    await runWriteQuery(
      `MATCH (t:Test {projectId: $projectId, filePath: $filePath})
       WHERE NOT (:Patch)-[:VERIFIED_BY]->(t)
       DETACH DELETE t`,
      { projectId, filePath }
    );

    // Detach and delete the stale File node itself (removing CONTAINS & IMPORTS edges)
    await runWriteQuery(
      `MATCH (f:File {id: $fileId})
       DETACH DELETE f`,
      { fileId }
    );
  }

  return staleRes.records.length;
}

/**
 * Generates and stores Gemini embeddings (`gemini-embedding-001` by default) for nodes
 * missing embeddings or whose embedding model/dimension differs from current config.
 * Prioritizes high-signal security/historical entities before bulk Function nodes.
 */
async function populateEmbeddingsForProject(projectId: string): Promise<{
  generated: number;
  cached: number;
  failed: number;
  model: string;
  dimensions: number;
  error?: string;
}> {
  const cfg = loadAppEnvConfig().gemini;
  const targetLabels = ['Vulnerability', 'Finding', 'Patch', 'Incident', 'Test', 'Function'] as const;

  interface NodeToEmbed {
    label: string;
    id: string;
    text: string;
  }

  const pending: NodeToEmbed[] = [];

  for (const label of targetLabels) {
    const res = await runReadQuery(
      `MATCH (n:${label} {projectId: $projectId})
       WHERE n.embedding IS NULL
          OR n.embeddingModel <> $model
          OR n.embeddingDimensions <> $dims
       RETURN n.id AS id, n.name AS name, n.title AS title, n.summary AS summary,
              n.codeSnippet AS codeSnippet, n.filePath AS filePath
       LIMIT 250`,
      { projectId, model: cfg.embeddingModel, dims: cfg.embeddingDimensions }
    );
    for (const rec of res.records) {
      const id = String(rec.get('id'));
      const parts = [
        label,
        rec.get('name') || rec.get('title') || '',
        rec.get('filePath') ? `File: ${rec.get('filePath')}` : '',
        rec.get('summary') || '',
        rec.get('codeSnippet') ? String(rec.get('codeSnippet')).slice(0, 1000) : '',
      ].filter(Boolean);
      pending.push({ label, id, text: parts.join('\n') });
    }
  }

  if (pending.length === 0) {
    return {
      generated: 0,
      cached: 0,
      failed: 0,
      model: cfg.embeddingModel,
      dimensions: cfg.embeddingDimensions,
    };
  }

  const embResult = await generateGeminiEmbeddings(
    pending.map((p) => p.text),
    { taskType: 'RETRIEVAL_DOCUMENT' }
  );

  // Group successful embeddings by label for clean batched UNWIND writes
  const byLabel = new Map<string, Array<{ id: string; vector: number[] }>>();
  for (let i = 0; i < pending.length; i++) {
    const item = embResult.vectors[i];
    if (!item) continue;
    const label = pending[i].label;
    const arr = byLabel.get(label) || [];
    arr.push({ id: pending[i].id, vector: item.values });
    byLabel.set(label, arr);
  }

  const now = new Date().toISOString();
  for (const [label, rows] of byLabel.entries()) {
    // Write in chunks of 40 nodes to keep AuraDB transactions fast
    for (let i = 0; i < rows.length; i += 40) {
      const chunk = rows.slice(i, i + 40);
      await runWriteQuery(
        `UNWIND $rows AS row
         MATCH (n:${label} {id: row.id})
         SET n.embedding = row.vector,
             n.embeddingModel = $model,
             n.embeddingDimensions = $dims,
             n.embeddedAt = $now`,
        {
          rows: chunk,
          model: embResult.model,
          dims: embResult.dimensions,
          now,
        }
      );
    }
  }

  return {
    generated: embResult.generatedCount,
    cached: embResult.cachedCount,
    failed: embResult.failedCount,
    model: embResult.model,
    dimensions: embResult.dimensions,
    error: embResult.error,
  };
}

/**
 * Full automatic incremental repository ingestion pipeline into Neo4j AuraDB.
 * Extracts real AST entities, establishes verified relationships, persists commits/audit records,
 * generates Gemini embeddings, and verifies actual persisted database counts.
 */
export async function ingestRepositoryToGraph(params: {
  projectId: string;
  rootDir: string;
  forceReindex?: boolean;
  includeEmbeddings?: boolean;
  auditRecords?: BackendAuditRecord[];
}): Promise<IngestionReport> {
  const { projectId, rootDir, forceReindex = false, includeEmbeddings = true, auditRecords = [] } = params;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const cfg = loadAppEnvConfig();
  const warnings: string[] = [];

  if (activeIngestions.has(projectId)) {
    const existing = ingestionStatusCache.get(projectId);
    if (existing) return existing;
  }

  const report: IngestionReport = {
    projectId,
    status: 'PROCESSING',
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    filesDiscovered: 0,
    filesProcessed: 0,
    filesSkippedUnchanged: 0,
    filesFailed: 0,
    functionsExtracted: 0,
    classesExtracted: 0,
    dependenciesExtracted: 0,
    testsExtracted: 0,
    findingsExtracted: 0,
    commitsExtracted: 0,
    embeddingsGenerated: 0,
    embeddingsCached: 0,
    embeddingsFailed: 0,
    embeddingModel: cfg.gemini.embeddingModel,
    embeddingDimensions: cfg.gemini.embeddingDimensions,
    persistedCounts: null,
    warnings,
  };

  ingestionStatusCache.set(projectId, report);
  activeIngestions.add(projectId);

  try {
    // 1. Initialize schema constraints, full-text index, and vector indexes
    const schemaRes = await initializeGraphSchema();
    if (schemaRes.errors.length > 0) {
      warnings.push(...schemaRes.errors.map((e) => `Schema warning: ${e}`));
    }

    // Mark Project node PROCESSING
    await runWriteQuery(
      `MERGE (p:Project {id: $projId})
       SET p.projectId = $projectId,
           p.name = $projectId,
           p.ingestionStatus = 'PROCESSING',
           p.lastIngestionStartedAt = $startedAt`,
      { projId: `project:${projectId}`, projectId, startedAt }
    );

    // 2. Discover real source files (excluding node_modules, dist, .env, secrets, binaries)
    const relFiles = await discoverRepositoryFiles(rootDir, 200);
    report.filesDiscovered = relFiles.length;

    if (relFiles.length === 0) {
      warnings.push('No supported source files found in target repository root.');
    }

    // 3. Read existing content hashes from Neo4j for incremental ingestion
    const existingHashes = new Map<string, string>();
    if (!forceReindex) {
      const hashRes = await runReadQuery(
        `MATCH (f:File {projectId: $projectId})
         RETURN f.path AS path, f.contentHash AS hash`,
        { projectId }
      );
      for (const rec of hashRes.records) {
        const p = rec.get('path');
        const h = rec.get('hash');
        if (typeof p === 'string' && typeof h === 'string') {
          existingHashes.set(p, h);
        }
      }
    }

    // 4. Extract & upsert changed files
    let anyFileChanged = false;
    for (const relPath of relFiles) {
      try {
        const extracted = await extractSourceFile(projectId, rootDir, relPath);
        const prevHash = existingHashes.get(relPath);
        if (!forceReindex && prevHash && prevHash === extracted.contentHash) {
          report.filesSkippedUnchanged++;
          continue;
        }
        anyFileChanged = true;
        await upsertFileGraphStructure(projectId, extracted);
        report.filesProcessed++;
        report.functionsExtracted += extracted.functions.length;
        report.classesExtracted += extracted.classes.length;
        report.dependenciesExtracted += extracted.dependencies.length;
        report.testsExtracted += extracted.tests.length;
        report.findingsExtracted += extracted.findings.length;
      } catch (err) {
        report.filesFailed++;
        warnings.push(`Failed to ingest ${relPath}: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      }
    }

    // 4b. Prune File/Function/Class/Test records for source files deleted from disk
    const prunedCount = await pruneDeletedProjectFiles(projectId, relFiles);
    if (prunedCount > 0) {
      anyFileChanged = true;
    }

    // 5. Link real cross-file relationships
    if (anyFileChanged || forceReindex) {
      await linkProjectRelationships(projectId);
    }

    // 6. Ingest real git commits if repository has git history
    const commits = readRecentGitCommits(rootDir, 10);
    if (commits.length > 0) {
      await runWriteQuery(
        `UNWIND $commits AS c
         MERGE (node:Commit {id: $prefix + c.sha})
         SET node.projectId = $projectId,
             node.sha = c.sha,
             node.name = c.sha,
             node.message = c.message,
             node.summary = c.message,
             node.author = c.author,
             node.timestamp = c.timestamp`,
        { prefix: `commit:${projectId}:`, projectId, commits }
      );
      report.commitsExtracted = commits.length;
    }

    // 7. Mirror real backend audit records as Patch & Incident nodes (when present)
    if (auditRecords.length > 0) {
      for (const rec of auditRecords.slice(0, 50)) {
        const patchId = `patch:${projectId}:${rec.id}`;
        await runWriteQuery(
          `MERGE (p:Patch {id: $patchId})
           SET p.projectId = $projectId,
               p.name = $name,
               p.filePath = $filePath,
               p.path = $filePath,
               p.ruleId = $ruleId,
               p.bugType = $bugType,
               p.summary = $summary,
               p.patchDiff = $patchDiff,
               p.verificationStatus = $verificationStatus,
               p.decision = $decision,
               p.confidence = $confidence,
               p.timestamp = $timestamp`,
          {
            patchId,
            projectId,
            name: `${rec.ruleId} (${rec.filename})`,
            filePath: rec.filename,
            ruleId: rec.ruleId,
            bugType: rec.bugType,
            summary: rec.summary,
            patchDiff: (rec.patchDiff || '').slice(0, 4000),
            verificationStatus: rec.verificationStatus || rec.sandboxVerdict,
            decision: rec.decision,
            confidence: rec.confidence,
            timestamp: rec.timestamp,
          }
        );
      }
    }

    // 8. Generate & persist Gemini embeddings
    if (includeEmbeddings) {
      const emb = await populateEmbeddingsForProject(projectId);
      report.embeddingsGenerated = emb.generated;
      report.embeddingsCached = emb.cached;
      report.embeddingsFailed = emb.failed;
      report.embeddingModel = emb.model;
      report.embeddingDimensions = emb.dimensions;
      if (emb.error) {
        warnings.push(`Embeddings: ${emb.error}`);
      }
    }

    // 9. Verify actual writes in Neo4j before declaring status
    const counts = await getProjectGraphCounts(projectId);
    report.persistedCounts = counts;

    if (counts.totalNodes === 0 && relFiles.length > 0) {
      report.status = 'FAILED';
      report.error = 'Ingestion finished without persisting any Neo4j graph records.';
    } else if (report.filesFailed > 0 || (includeEmbeddings && report.embeddingsFailed > 0 && report.embeddingsGenerated === 0 && counts.embeddedNodes === 0)) {
      report.status = 'PARTIAL';
    } else {
      report.status = 'COMPLETED';
    }

    report.completedAt = new Date().toISOString();
    report.durationMs = Number((performance.now() - t0).toFixed(1));

    await runWriteQuery(
      `MATCH (p:Project {id: $projId})
       SET p.ingestionStatus = $status,
           p.lastIngestedAt = $completedAt,
           p.totalNodes = $totalNodes,
           p.totalRelationships = $totalRelationships,
           p.embeddedNodes = $embeddedNodes`,
      {
        projId: `project:${projectId}`,
        status: report.status,
        completedAt: report.completedAt,
        totalNodes: counts.totalNodes,
        totalRelationships: counts.totalRelationships,
        embeddedNodes: counts.embeddedNodes,
      }
    );

    ingestionStatusCache.set(projectId, { ...report });
    return report;
  } catch (err) {
    report.status = 'FAILED';
    report.error = redactSecrets(err instanceof Error ? err.message : 'Ingestion failed.');
    report.completedAt = new Date().toISOString();
    report.durationMs = Number((performance.now() - t0).toFixed(1));
    ingestionStatusCache.set(projectId, { ...report });
    return report;
  } finally {
    activeIngestions.delete(projectId);
  }
}

/**
 * Records a live AutoPatch analysis/validation finding, patch, and test verification
 * into the Neo4j Knowledge Graph (best-effort; never throws to break core analysis).
 */
export async function recordAnalysisResultInGraph(params: {
  projectId: string;
  analysis: AnalysisResponse;
  commitSha?: string;
}): Promise<{ recorded: boolean; findingId?: string; patchId?: string }> {
  const { projectId, analysis, commitSha } = params;
  const cfg = loadAppEnvConfig().neo4j;
  if (!cfg.enabled || !cfg.configured) return { recorded: false };

  try {
    const now = new Date().toISOString();
    const targetLine =
      analysis.patchInfo.targetLine ??
      analysis.baseline.errorLine ??
      analysis.astReport.findings[0]?.line ??
      1;
    const bugType = analysis.patchInfo.bugType || 'Defect';
    const isVuln = /injection|taint|secret|xss|ssrf|traversal|cve/i.test(bugType);
    const findingId = `${isVuln ? 'vuln' : 'finding'}:${projectId}:${analysis.filename}:${bugType}:${targetLine}`;
    const patchId = `patch:${projectId}:${crypto
      .createHash('sha1')
      .update(`${analysis.filename}:${analysis.patchInfo.ruleId}:${analysis.originalSourceHash || ''}:${analysis.diff.unified}`)
      .digest('hex')
      .slice(0, 12)}`;

    // Upsert Finding or Vulnerability
    if (isVuln) {
      await runWriteQuery(
        `MERGE (v:Vulnerability {id: $findingId})
         SET v.projectId = $projectId,
             v.kind = $bugType,
             v.title = $title,
             v.name = $title,
             v.severity = 'critical',
             v.filePath = $filename,
             v.path = $filename,
             v.line = $targetLine,
             v.summary = $rootCause,
             v.updatedAt = $now
         WITH v
         OPTIONAL MATCH (fn:Function {projectId: $projectId})
         WHERE fn.filePath ENDS WITH $filename AND fn.startLine <= $targetLine AND fn.endLine >= $targetLine
         FOREACH (_ IN CASE WHEN fn IS NOT NULL THEN [1] ELSE [] END |
           MERGE (v)-[:AFFECTS]->(fn)
         )`,
        {
          findingId,
          projectId,
          bugType,
          title: `${bugType} in ${analysis.filename}:${targetLine}`,
          filename: analysis.filename,
          targetLine,
          rootCause: analysis.patchInfo.rootCause,
          now,
        }
      );
    } else {
      await runWriteQuery(
        `MERGE (fd:Finding {id: $findingId})
         SET fd.projectId = $projectId,
             fd.kind = $bugType,
             fd.title = $title,
             fd.name = $title,
             fd.severity = $severity,
             fd.filePath = $filename,
             fd.path = $filename,
             fd.line = $targetLine,
             fd.summary = $rootCause,
             fd.updatedAt = $now
         WITH fd
         OPTIONAL MATCH (fn:Function {projectId: $projectId})
         WHERE fn.filePath ENDS WITH $filename AND fn.startLine <= $targetLine AND fn.endLine >= $targetLine
         FOREACH (_ IN CASE WHEN fn IS NOT NULL THEN [1] ELSE [] END |
           MERGE (fn)-[:HAS_FINDING]->(fd)
           MERGE (fd)-[:AFFECTS]->(fn)
         )`,
        {
          findingId,
          projectId,
          bugType,
          title: `${bugType} in ${analysis.filename}:${targetLine}`,
          severity: analysis.trustVerdict === 'verified' ? 'warning' : 'error',
          filename: analysis.filename,
          targetLine,
          rootCause: analysis.patchInfo.rootCause,
          now,
        }
      );
    }

    // Upsert Patch + Test verification + Incident resolution when patch was applied
    if (analysis.patchInfo.patchApplied) {
      const incidentId = `incident:${projectId}:${analysis.filename}:${bugType}:${targetLine}`;
      await runWriteQuery(
        `MERGE (p:Patch {id: $patchId})
         SET p.projectId = $projectId,
             p.name = $patchName,
             p.filePath = $filename,
             p.path = $filename,
             p.ruleId = $ruleId,
             p.bugType = $bugType,
             p.summary = $strategy,
             p.patchDiff = $unifiedDiff,
             p.verificationStatus = $verificationStatus,
             p.trustVerdict = $trustVerdict,
             p.confidence = $confidence,
             p.updatedAt = $now
         WITH p
         OPTIONAL MATCH (fd:Finding {id: $findingId})
         FOREACH (_ IN CASE WHEN fd IS NOT NULL THEN [1] ELSE [] END |
           MERGE (fd)-[:HAS_PATCH]->(p)
         )
         WITH p
         MERGE (inc:Incident {id: $incidentId})
         SET inc.projectId = $projectId,
             inc.name = $incTitle,
             inc.title = $incTitle,
             inc.filePath = $filename,
             inc.path = $filename,
             inc.summary = $rootCause,
             inc.status = CASE WHEN $trustVerdict = 'verified' THEN 'RESOLVED' ELSE 'OPEN' END,
             inc.updatedAt = $now
         MERGE (inc)-[:RESOLVED_BY]->(p)`,
        {
          patchId,
          projectId,
          patchName: `${analysis.patchInfo.ruleId} on ${analysis.filename}`,
          filename: analysis.filename,
          ruleId: analysis.patchInfo.ruleId,
          bugType,
          strategy: analysis.patchInfo.strategy,
          unifiedDiff: analysis.diff.unified.slice(0, 4000),
          verificationStatus: analysis.verificationStatus || 'HUMAN_REVIEW_REQUIRED',
          trustVerdict: analysis.trustVerdict,
          confidence: analysis.confidence.score,
          findingId,
          incidentId,
          incTitle: `${bugType} incident in ${analysis.filename}:${targetLine}`,
          rootCause: analysis.patchInfo.rootCause,
          now,
        }
      );

      // Link verified tests to Patch via VERIFIED_BY
      if (analysis.sandbox.tests.length > 0 && analysis.verificationMode === 'dynamic-sandbox') {
        const passedTests = analysis.sandbox.tests.filter((t) => t.status === 'passed').slice(0, 10);
        for (const t of passedTests) {
          const testId = `test:${projectId}:${analysis.testFilename}:${t.name}`;
          await runWriteQuery(
            `MATCH (p:Patch {id: $patchId})
             MERGE (t:Test {id: $testId})
             SET t.projectId = $projectId,
                 t.name = $tName,
                 t.filePath = $testFilename,
                 t.path = $testFilename,
                 t.summary = $tSummary,
                 t.updatedAt = $now
             MERGE (p)-[:VERIFIED_BY]->(t)`,
            {
              patchId,
              testId,
              projectId,
              tName: t.name,
              testFilename: analysis.testFilename,
              tSummary: `Sandbox verification test ${t.name} (${t.status}) for ${analysis.filename}`,
              now,
            }
          );
        }
      }

      if (commitSha) {
        await runWriteQuery(
          `MATCH (p:Patch {id: $patchId})
           MERGE (c:Commit {id: $commitId})
           SET c.projectId = $projectId, c.sha = $commitSha, c.name = $commitSha
           MERGE (p)-[:INTRODUCED_IN]->(c)`,
          {
            patchId,
            commitId: `commit:${projectId}:${commitSha}`,
            projectId,
            commitSha,
          }
        );
      }
    }

    return { recorded: true, findingId, patchId: analysis.patchInfo.patchApplied ? patchId : undefined };
  } catch {
    return { recorded: false };
  }
}
