import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuditEntry, VerificationStatus } from '../src/types/autopatch.ts';

export interface BackendAuditRecord extends AuditEntry {
  projectId?: string;
  originalSourceHash?: string;
  modifiedSourceHash?: string;
  patchDiff?: string;
  developerApproval?: {
    approved: boolean;
    approver?: string;
    reason?: string;
    recordedAt: string;
  };
  verificationStatus?: VerificationStatus;
  findingId?: string;
  prevEntryHash: string;
  entryHash: string;
}

export interface BackendAuditStore {
  readonly mode: 'in-memory-volatile' | 'backend-append-only' | 'persistent-db';
  append(entry: Omit<BackendAuditRecord, 'prevEntryHash' | 'entryHash'>): Promise<BackendAuditRecord>;
  list(limit?: number): Promise<BackendAuditRecord[]>;
  getById(id: string): Promise<BackendAuditRecord | null>;
  verifyChain(): Promise<{ valid: boolean; totalRecords: number; brokenAtIndex?: number }>;
}

export function computeContentSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function computeRecordHash(
  record: Omit<BackendAuditRecord, 'entryHash'>,
  prevEntryHash: string
): string {
  const canonical = JSON.stringify({
    prevEntryHash,
    id: record.id,
    timestamp: record.timestamp,
    projectId: record.projectId ?? null,
    filename: record.filename,
    line: record.line,
    bugType: record.bugType,
    ruleId: record.ruleId,
    confidence: record.confidence,
    baselinePassed: record.baselinePassed,
    baselineTotal: record.baselineTotal,
    sandboxPassed: record.sandboxPassed,
    sandboxTotal: record.sandboxTotal,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
    sandboxVerdict: record.sandboxVerdict,
    verificationStatus: record.verificationStatus ?? null,
    decision: record.decision,
    originalSourceHash: record.originalSourceHash ?? null,
    modifiedSourceHash: record.modifiedSourceHash ?? null,
    overrideReason: record.overrideReason ?? null,
    patchDiff: record.patchDiff ?? null,
    developerApproval: record.developerApproval ?? null,
    findingId: record.findingId ?? null,
    summary: record.summary,
  });
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Authoritative server-side append-only hash-chained audit log persisted as NDJSON.
 * Each entry cryptographically chains to the previous entry's SHA-256 hash so
 * tampering or deletion can be detected via `verifyChain()`.
 */
export class AppendOnlyFileAuditStore implements BackendAuditStore {
  readonly mode = 'backend-append-only' as const;
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private lastHash = 'GENESIS';
  private loaded = false;
  private cache: BackendAuditRecord[] = [];
  private corruptedLineIndices: number[] = [];

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.corruptedLineIndices = [];
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const parsed: BackendAuditRecord[] = [];
      for (let idx = 0; idx < lines.length; idx++) {
        try {
          const item = JSON.parse(lines[idx]) as unknown;
          if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof (item as BackendAuditRecord).entryHash !== 'string' ||
            typeof (item as BackendAuditRecord).id !== 'string'
          ) {
            this.corruptedLineIndices.push(idx);
            continue;
          }
          parsed.push(item as BackendAuditRecord);
        } catch {
          this.corruptedLineIndices.push(idx);
        }
      }
      this.cache = parsed;
      this.lastHash = parsed.length > 0 ? parsed[parsed.length - 1].entryHash : 'GENESIS';
    } catch {
      this.cache = [];
      this.lastHash = 'GENESIS';
    }
    this.loaded = true;
  }

  async append(
    entry: Omit<BackendAuditRecord, 'prevEntryHash' | 'entryHash'>
  ): Promise<BackendAuditRecord> {
    const task = this.writeQueue.then(async () => {
      await this.ensureLoaded();
      const prevEntryHash = this.lastHash;
      const base: Omit<BackendAuditRecord, 'entryHash'> = {
        ...entry,
        id: entry.id || `aud-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        timestamp: entry.timestamp || new Date().toISOString(),
        prevEntryHash,
      };
      const entryHash = computeRecordHash(base, prevEntryHash);
      const fullRecord: BackendAuditRecord = { ...base, entryHash };

      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.filePath, `${JSON.stringify(fullRecord)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });

      this.cache.push(fullRecord);
      this.lastHash = entryHash;
      return fullRecord;
    });

    this.writeQueue = task.catch(() => {});
    return task;
  }

  async list(limit = 100): Promise<BackendAuditRecord[]> {
    await this.ensureLoaded();
    const bounded = Math.max(1, Math.min(limit, 500));
    return this.cache.slice(-bounded).reverse();
  }

  async getById(id: string): Promise<BackendAuditRecord | null> {
    await this.ensureLoaded();
    return this.cache.find((e) => e.id === id) ?? null;
  }

  async verifyChain(): Promise<{ valid: boolean; totalRecords: number; brokenAtIndex?: number }> {
    await this.ensureLoaded();
    if (this.corruptedLineIndices.length > 0) {
      return {
        valid: false,
        totalRecords: this.cache.length + this.corruptedLineIndices.length,
        brokenAtIndex: this.corruptedLineIndices[0],
      };
    }
    let expectedPrev = 'GENESIS';
    for (let i = 0; i < this.cache.length; i++) {
      const rec = this.cache[i];
      if (rec.prevEntryHash !== expectedPrev) {
        return { valid: false, totalRecords: this.cache.length, brokenAtIndex: i };
      }
      const { entryHash, ...rest } = rec;
      const recomputed = computeRecordHash(rest, expectedPrev);
      if (recomputed !== entryHash) {
        return { valid: false, totalRecords: this.cache.length, brokenAtIndex: i };
      }
      expectedPrev = entryHash;
    }
    return { valid: true, totalRecords: this.cache.length };
  }
}

export class VolatileMemoryAuditStore implements BackendAuditStore {
  readonly mode = 'in-memory-volatile' as const;
  private readonly maxEntries: number;
  private readonly entries: BackendAuditRecord[] = [];
  private lastHash = 'GENESIS';

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  async append(
    entry: Omit<BackendAuditRecord, 'prevEntryHash' | 'entryHash'>
  ): Promise<BackendAuditRecord> {
    const prevEntryHash = this.lastHash;
    const base: Omit<BackendAuditRecord, 'entryHash'> = {
      ...entry,
      id: entry.id || `aud-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      timestamp: entry.timestamp || new Date().toISOString(),
      prevEntryHash,
    };
    const entryHash = computeRecordHash(base, prevEntryHash);
    const fullRecord: BackendAuditRecord = { ...base, entryHash };
    this.entries.push(fullRecord);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.lastHash = entryHash;
    return fullRecord;
  }

  async list(limit = 100): Promise<BackendAuditRecord[]> {
    const bounded = Math.max(1, Math.min(limit, this.maxEntries));
    return this.entries.slice(-bounded).reverse();
  }

  async getById(id: string): Promise<BackendAuditRecord | null> {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  async verifyChain(): Promise<{ valid: boolean; totalRecords: number; brokenAtIndex?: number }> {
    let expectedPrev = this.entries[0]?.prevEntryHash ?? 'GENESIS';
    for (let i = 0; i < this.entries.length; i++) {
      const rec = this.entries[i];
      if (rec.prevEntryHash !== expectedPrev) {
        return { valid: false, totalRecords: this.entries.length, brokenAtIndex: i };
      }
      const { entryHash, ...rest } = rec;
      if (computeRecordHash(rest, expectedPrev) !== entryHash) {
        return { valid: false, totalRecords: this.entries.length, brokenAtIndex: i };
      }
      expectedPrev = entryHash;
    }
    return { valid: true, totalRecords: this.entries.length };
  }
}
