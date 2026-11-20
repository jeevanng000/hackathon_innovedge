/**
 * Pure Spectrum-Based Fault Localization (SBFL) statistical formulas.
 * Mirrors the Python sys.settrace SBFL computation for deterministic unit testing.
 */

export function computeOchiai(
  failedCovering: number,
  passedCovering: number,
  totalFailed: number
): number {
  const denom = Math.sqrt(totalFailed * (failedCovering + passedCovering));
  if (totalFailed <= 0 || denom === 0) return 0;
  return Number((failedCovering / denom).toFixed(3));
}

export function computeTarantula(
  failedCovering: number,
  passedCovering: number,
  totalFailed: number,
  totalPassed: number
): number {
  const failRatio = totalFailed > 0 ? failedCovering / totalFailed : 0;
  const passRatio = totalPassed > 0 ? passedCovering / totalPassed : 0;
  const denom = failRatio + passRatio;
  if (denom === 0) return 0;
  return Number((failRatio / denom).toFixed(3));
}

export function classifySuspiciousness(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}
