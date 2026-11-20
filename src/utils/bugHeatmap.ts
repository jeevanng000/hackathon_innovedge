import type { BugSeverity, UnifiedBugFinding } from '../types/autopatch';

export type HeatmapBandStatus = BugSeverity | 'resolved';

export interface BugHeatmapBand {
  id: string;
  startLine: number;
  endLine: number;
  topPct: number;
  heightPct: number;
  status: HeatmapBandStatus;
  densityWeight: number;
  normalizedDensity: number; // 0.25 .. 1.0
  totalCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  resolvedCount: number;
  primaryFindingId: string;
  hasActiveFinding: boolean;
}

const SEVERITY_WEIGHT: Record<BugSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

const SEVERITY_RANK: Record<BugSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

export interface ComputeBugHeatmapParams {
  lineCount: number;
  findings: ReadonlyArray<UnifiedBugFinding>;
  resolvedFindingIds: ReadonlySet<string>;
  activeFindingId?: string | null;
  maxBuckets?: number;
}

/**
 * Computes proportional vertical bands representing bug distribution and
 * severity density across the entire source file.
 */
export function computeBugHeatmapBands({
  lineCount,
  findings,
  resolvedFindingIds,
  activeFindingId = null,
  maxBuckets = 48,
}: ComputeBugHeatmapParams): BugHeatmapBand[] {
  const safeLines = Math.max(1, lineCount);
  if (findings.length === 0) return [];

  const bucketCount = Math.min(safeLines, Math.max(1, maxBuckets));
  const linesPerBucket = safeLines / bucketCount;

  interface BucketAccumulator {
    startLine: number;
    endLine: number;
    findingsMap: Map<string, UnifiedBugFinding>;
  }

  const buckets: BucketAccumulator[] = Array.from({ length: bucketCount }, (_, idx) => {
    const startLine = Math.floor(idx * linesPerBucket) + 1;
    const endLine =
      idx === bucketCount - 1
        ? safeLines
        : Math.max(startLine, Math.floor((idx + 1) * linesPerBucket));
    return {
      startLine,
      endLine,
      findingsMap: new Map<string, UnifiedBugFinding>(),
    };
  });

  for (const finding of findings) {
    const fStart = Math.max(1, Math.min(safeLines, finding.line));
    const fEnd = Math.max(fStart, Math.min(safeLines, finding.endLine || fStart));

    for (const bucket of buckets) {
      if (fStart <= bucket.endLine && fEnd >= bucket.startLine) {
        bucket.findingsMap.set(finding.id, finding);
      }
    }
  }

  const populated = buckets
    .map((bucket, idx) => {
      const list = Array.from(bucket.findingsMap.values());
      if (list.length === 0) return null;

      let criticalCount = 0;
      let warningCount = 0;
      let infoCount = 0;
      let resolvedCount = 0;
      let unresolvedWeight = 0;
      let highestUnresolvedRank = 0;
      let dominantUnresolved: BugSeverity = 'info';

      // Pick primary finding: active if inside bucket, else highest-severity unresolved, else first
      let primaryFinding = list[0];
      let bestPrimaryScore = -1;

      for (const f of list) {
        const isResolved = resolvedFindingIds.has(f.id);
        const rank = SEVERITY_RANK[f.severity];
        const weight = SEVERITY_WEIGHT[f.severity];

        if (isResolved) {
          resolvedCount++;
        } else {
          unresolvedWeight += weight;
          if (f.severity === 'critical') criticalCount++;
          else if (f.severity === 'warning') warningCount++;
          else infoCount++;

          if (rank > highestUnresolvedRank) {
            highestUnresolvedRank = rank;
            dominantUnresolved = f.severity;
          }
        }

        const primaryScore =
          (f.id === activeFindingId ? 100 : 0) + (isResolved ? 0 : 10) + rank;
        if (primaryScore > bestPrimaryScore) {
          bestPrimaryScore = primaryScore;
          primaryFinding = f;
        }
      }

      const allResolved = resolvedCount === list.length;
      const status: HeatmapBandStatus = allResolved ? 'resolved' : dominantUnresolved;
      const densityWeight = allResolved ? list.length : unresolvedWeight;

      const topPct = ((bucket.startLine - 1) / safeLines) * 100;
      const spanLines = bucket.endLine - bucket.startLine + 1;
      const rawHeightPct = (spanLines / safeLines) * 100;

      return {
        id: `hb-${idx}-${bucket.startLine}-${bucket.endLine}`,
        startLine: bucket.startLine,
        endLine: bucket.endLine,
        topPct,
        heightPct: Math.max(2.5, rawHeightPct),
        status,
        densityWeight,
        normalizedDensity: 0.5,
        totalCount: list.length,
        criticalCount,
        warningCount,
        infoCount,
        resolvedCount,
        primaryFindingId: primaryFinding.id,
        hasActiveFinding: Boolean(activeFindingId && bucket.findingsMap.has(activeFindingId)),
      };
    })
    .filter((b): b is BugHeatmapBand => b !== null);

  const maxWeight = Math.max(1, ...populated.map((b) => b.densityWeight));
  return populated.map((b) => ({
    ...b,
    normalizedDensity: Math.min(1, Math.max(0.35, b.densityWeight / maxWeight)),
  }));
}

export interface ScrollViewportMetrics {
  topPct: number;
  heightPct: number;
}

/**
 * Computes proportional viewport thumb coordinates from an element's scroll geometry.
 */
export function computeScrollViewportMetrics(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): ScrollViewportMetrics {
  if (scrollHeight <= 0 || clientHeight <= 0 || scrollHeight <= clientHeight) {
    return { topPct: 0, heightPct: 100 };
  }
  const topPct = Math.max(0, Math.min(100, (scrollTop / scrollHeight) * 100));
  const heightPct = Math.max(8, Math.min(100 - topPct, (clientHeight / scrollHeight) * 100));
  return { topPct, heightPct };
}
