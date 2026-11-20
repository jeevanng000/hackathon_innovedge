import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { UnifiedBugFinding } from '../types/autopatch';
import {
  computeBugHeatmapBands,
  type BugHeatmapBand,
  type HeatmapBandStatus,
  type ScrollViewportMetrics,
} from '../utils/bugHeatmap';
import { POPOVER_SPRING } from '../utils/motionPresets';

interface BugHeatmapProps {
  lineCount: number;
  findings: UnifiedBugFinding[];
  resolvedFindingIds: Set<string>;
  activeFindingId: string | null;
  viewport: ScrollViewportMetrics;
  onSelectBand: (band: BugHeatmapBand) => void;
  onScrubScroll: (fraction: number) => void;
}

const BAND_COLORS: Record<
  HeatmapBandStatus,
  { bar: string; activeRing: string; label: string }
> = {
  critical: {
    bar: 'bg-[#FF718B]',
    activeRing: 'ring-2 ring-[#F4F7FF]',
    label: 'Critical',
  },
  warning: {
    bar: 'bg-[#FFCA70]',
    activeRing: 'ring-2 ring-[#F4F7FF]',
    label: 'Warning',
  },
  info: {
    bar: 'bg-[#50D7E6]',
    activeRing: 'ring-2 ring-[#F4F7FF]',
    label: 'Info',
  },
  resolved: {
    bar: 'bg-[#51D6A2]',
    activeRing: 'ring-2 ring-[#F4F7FF]',
    label: 'Fixed',
  },
};

function formatBandTooltip(band: BugHeatmapBand): string {
  const lineText =
    band.startLine === band.endLine
      ? `Line ${band.startLine}`
      : `Lines ${band.startLine}–${band.endLine}`;
  const parts: string[] = [];
  if (band.criticalCount > 0) parts.push(`${band.criticalCount} Critical`);
  if (band.warningCount > 0) parts.push(`${band.warningCount} Warning`);
  if (band.infoCount > 0) parts.push(`${band.infoCount} Info`);
  if (band.resolvedCount > 0) parts.push(`${band.resolvedCount} Fixed`);
  return `${lineText} · ${band.totalCount} bug${band.totalCount === 1 ? '' : 's'} (${parts.join(', ')}) — click to jump`;
}

export function BugHeatmap({
  lineCount,
  findings,
  resolvedFindingIds,
  activeFindingId,
  viewport,
  onSelectBand,
  onScrubScroll,
}: BugHeatmapProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoveredBandId, setHoveredBandId] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const bands = computeBugHeatmapBands({
    lineCount,
    findings,
    resolvedFindingIds,
    activeFindingId,
  });

  const hoveredBand = bands.find((b) => b.id === hoveredBandId) ?? null;

  const computeFractionFromPointer = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  };

  return (
    <aside
      aria-label="Scroll-aligned bug density heatmap"
      className="relative w-7 shrink-0 border-l border-white/10 bg-[#0A0F1F]/90 select-none flex flex-col"
    >
      {/* Track Container */}
      <div
        ref={trackRef}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).dataset.heatmapBand === 'true') return;
          setIsScrubbing(true);
          e.currentTarget.setPointerCapture(e.pointerId);
          onScrubScroll(computeFractionFromPointer(e.clientY));
        }}
        onPointerMove={(e) => {
          if (!isScrubbing) return;
          onScrubScroll(computeFractionFromPointer(e.clientY));
        }}
        onPointerUp={(e) => {
          if (!isScrubbing) return;
          setIsScrubbing(false);
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // Ignore capture release errors
          }
        }}
        onPointerCancel={() => setIsScrubbing(false)}
        title="Bug density heatmap — click any marker to jump to that line or drag to scroll"
        className="relative flex-1 w-full cursor-ns-resize overflow-hidden"
      >
        {/* Subtle horizontal rule guide lines every 25% */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-1/4 border-t border-white/8 pointer-events-none"
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-1/2 border-t border-white/8 pointer-events-none"
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-3/4 border-t border-white/8 pointer-events-none"
        />

        {/* Scroll-aligned viewport lens */}
        {viewport.heightPct < 99.5 && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bg-[#8B7CFF]/15 border-y border-[#8B7CFF]/45 pointer-events-none transition-[top,height] duration-75"
            style={{
              top: `${viewport.topPct}%`,
              height: `${viewport.heightPct}%`,
            }}
          />
        )}

        {/* Severity & Density Heatmap Bands */}
        {bands.map((band) => {
          const style = BAND_COLORS[band.status];
          const widthPct = Math.round(52 + band.normalizedDensity * 48);
          const opacityVal = Number((0.68 + band.normalizedDensity * 0.32).toFixed(2));

          return (
            <button
              key={band.id}
              type="button"
              data-heatmap-band="true"
              onClick={(e) => {
                e.stopPropagation();
                onSelectBand(band);
              }}
              onMouseEnter={() => setHoveredBandId(band.id)}
              onMouseLeave={() => setHoveredBandId(null)}
              onFocus={() => setHoveredBandId(band.id)}
              onBlur={() => setHoveredBandId(null)}
              aria-label={formatBandTooltip(band)}
              title={formatBandTooltip(band)}
              className={`absolute right-0.5 rounded-xs cursor-pointer transition-transform hover:scale-x-105 focus-visible:outline-none ${style.bar} ${
                band.hasActiveFinding ? style.activeRing : ''
              }`}
              style={{
                top: `${Math.min(97, band.topPct)}%`,
                height: `${band.heightPct}%`,
                minHeight: '5px',
                width: `${widthPct}%`,
                opacity: opacityVal,
              }}
            />
          );
        })}
      </div>

      {/* Compact Frosted-Glass Hover Readout Popover anchored left of the rail */}
      <AnimatePresence>
        {hoveredBand && (
          <motion.div
            key={hoveredBand.id}
            initial={{ opacity: 0, x: 6, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 6, scale: 0.96 }}
            transition={POPOVER_SPRING}
            role="status"
            className="pointer-events-none absolute right-8 z-20 px-2.5 py-1.5 rounded-lg bg-[#141E38]/90 backdrop-blur-md text-[#F4F7FF] border border-white/15 shadow-xl shadow-black/40 whitespace-nowrap text-[11px] font-mono tabular-nums"
            style={{
              top: `clamp(4px, ${hoveredBand.topPct}%, calc(100% - 34px))`,
            }}
          >
            <span>
              {hoveredBand.startLine === hoveredBand.endLine
                ? `L${hoveredBand.startLine}`
                : `L${hoveredBand.startLine}–${hoveredBand.endLine}`}
            </span>
            <span aria-hidden="true" className="mx-1.5 text-[#A6B0C8]">
              ·
            </span>
            <span className="font-sans font-medium">
              {BAND_COLORS[hoveredBand.status].label} ({hoveredBand.totalCount})
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
