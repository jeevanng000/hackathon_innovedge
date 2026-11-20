import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  GitBranch,
  Cpu,
} from 'lucide-react';
import type { AnalysisResponse } from '../types/autopatch';
import { classifySuspiciousness } from '../utils/sbfl';
import { VIEW_TRANSITION } from '../utils/motionPresets';

interface AnalysisDiagnosticsPanelProps {
  analysis: AnalysisResponse;
}

type DiagnosticsTab = 'sbfl' | 'static' | 'apr';

export function AnalysisDiagnosticsPanel({ analysis }: AnalysisDiagnosticsPanelProps) {
  const hasMutants = (analysis.patchInfo.evaluatedMutants?.length ?? 0) > 0;
  const hasSbfl = (analysis.sbfl?.rankings.length ?? 0) > 0;
  const [activeTab, setActiveTab] = useState<DiagnosticsTab>(
    hasSbfl ? 'sbfl' : 'static'
  );

  const findings = analysis.astReport.findings ?? [];
  const functions = analysis.astReport.functions ?? [];
  const callGraph = analysis.astReport.callGraph ?? [];
  const sbfl = analysis.sbfl;
  const mutants = analysis.patchInfo.evaluatedMutants ?? [];
  const isPython = !analysis.language || analysis.language === 'python';

  const tabs: Array<{ id: DiagnosticsTab; label: string }> = [
    { id: 'sbfl', label: 'SBFL Spectrum (Ochiai / Tarantula)' },
    { id: 'static', label: 'Static Analysis, Taint & CFG' },
    {
      id: 'apr',
      label: hasMutants ? `APR Repair Trace (${mutants.length})` : 'APR Repair Trace',
    },
  ];

  return (
    <section
      aria-label="Fault localization, static CFG, taint, and APR analysis"
      className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-lg shadow-black/20"
    >
      {/* Panel Header + Segmented Tabs */}
      <div className="px-4 py-3 bg-[#0D1426]/80 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Analysis deep-dive tabs"
          className="inline-flex items-center gap-1 p-1 bg-[#0B1020]/80 border border-white/10 rounded-lg overflow-x-auto max-w-full"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-[#8B7CFF] text-white shadow-sm'
                  : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="text-xs font-mono tabular-nums text-[#A6B0C8]">
          {analysis.patchInfo.aprStrategy || 'Template-Based APR'}
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {/* Tab 1: SBFL Spectrum & Activity Matrix */}
        {activeTab === 'sbfl' && (
          <motion.div
            key="sbfl"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={VIEW_TRANSITION}
            className="p-5 space-y-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="font-display text-sm font-semibold text-[#F4F7FF]">
                  Spectrum-Based Fault Localization (Activity Matrix)
                </h2>
                <p className="text-xs text-[#A6B0C8] mt-0.5">
                  {isPython ? (
                    <>
                      Recorded via Python{' '}
                      <code className="font-mono text-[#50D7E6]">sys.settrace</code>{' '}
                      across baseline test execution. Lines executed more often by failing tests rank highest.
                    </>
                  ) : (
                    'Computed across baseline test execution traces and failure lines. Statements correlated with failing tests rank highest.'
                  )}
                </p>
              </div>
              {sbfl && (
                <div className="text-xs font-mono tabular-nums text-[#A6B0C8]">
                  {sbfl.rankings.length} traced lines · {sbfl.totalFailed} failed ·{' '}
                  {sbfl.totalPassed} passed
                </div>
              )}
            </div>

            {!sbfl || sbfl.rankings.length === 0 ? (
              <p className="text-xs text-[#A6B0C8] py-3">
                No line-level execution spectrum available for this case (see Static Analysis, Taint &amp; CFG tab for structural localization).
              </p>
            ) : (
              <div className="code-scroll overflow-x-auto border border-white/10 rounded-lg bg-[#0B1020]/60">
                <table className="w-full text-left border-collapse font-mono text-xs">
                  <thead>
                    <tr className="border-b border-white/10 bg-[#0D1426]/90 text-[11px] text-[#A6B0C8]">
                      <th className="py-2 px-3 font-medium w-12 text-right">Line</th>
                      <th className="py-2 px-3 font-medium">Statement</th>
                      {sbfl.tests.map((t, idx) => (
                        <th
                          key={t.name}
                          title={`${t.name} (${t.status})`}
                          className="py-2 px-2 font-medium text-center whitespace-nowrap"
                        >
                          <div className="text-[10px] text-[#A6B0C8]">T{idx + 1}</div>
                          <div
                            className={
                              t.status === 'failed'
                                ? 'text-[#FF718B] font-semibold'
                                : 'text-[#51D6A2]'
                            }
                          >
                            {t.status === 'failed' ? 'FAIL' : 'PASS'}
                          </div>
                        </th>
                      ))}
                      <th className="py-2 px-3 font-medium text-right whitespace-nowrap">
                        Ochiai
                      </th>
                      <th className="py-2 px-3 font-medium text-right whitespace-nowrap">
                        Tarantula
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {sbfl.rankings.slice(0, 10).map((row) => {
                      const level = classifySuspiciousness(row.ochiai);
                      return (
                        <tr key={row.line} className="hover:bg-white/[0.04]">
                          <td className="py-2 px-3 text-right tabular-nums text-[#A6B0C8]">
                            {row.line}
                          </td>
                          <td className="py-2 px-3 text-[#F4F7FF] max-w-[320px] truncate">
                            {row.code.trim() || ' '}
                          </td>
                          {row.testHits.map((hit, idx) => (
                            <td key={idx} className="py-2 px-2 text-center tabular-nums">
                              {hit ? (
                                <span
                                  className={
                                    sbfl.tests[idx]?.status === 'failed'
                                      ? 'text-[#FF718B] font-semibold'
                                      : 'text-[#50D7E6]'
                                  }
                                >
                                  ●
                                </span>
                              ) : (
                                <span className="text-white/20">·</span>
                              )}
                            </td>
                          ))}
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <div className="w-12 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    level === 'high'
                                      ? 'bg-[#FF718B]'
                                      : level === 'medium'
                                      ? 'bg-[#FFCA70]'
                                      : 'bg-[#50D7E6]'
                                  }`}
                                  style={{ width: `${Math.round(row.ochiai * 100)}%` }}
                                />
                              </div>
                              <span
                                className={
                                  level === 'high'
                                    ? 'text-[#FF718B] font-semibold'
                                    : 'text-[#F4F7FF]'
                                }
                              >
                                {row.ochiai.toFixed(3)}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-[#A6B0C8]">
                            {row.tarantula.toFixed(3)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {sbfl && sbfl.tests.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-[#A6B0C8]">
                {sbfl.tests.map((t, idx) => (
                  <span key={t.name}>
                    <strong className="text-[#F4F7FF]">T{idx + 1}</strong>: {t.name}
                  </span>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* Tab 2: Static Analysis, Taint & CFG Metrics */}
        {activeTab === 'static' && (
          <motion.div
            key="static"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={VIEW_TRANSITION}
            className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6"
          >
            {/* Static AST / Taint / CFG Findings */}
            <div className="space-y-3">
              <h2 className="font-display text-sm font-semibold text-[#F4F7FF]">
                AST, Taint &amp; Control-Flow Findings ({findings.length})
              </h2>

              {findings.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-[#51D6A2] py-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>No static security, data-flow, or CFG warnings detected.</span>
                </div>
              ) : (
                <ul className="divide-y divide-white/10 border border-white/10 rounded-lg px-3.5 bg-[#0B1020]/50">
                  {findings.map((finding) => (
                    <li key={finding.id} className="py-3 space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#F4F7FF]">
                          {finding.category === 'security' ? (
                            <ShieldAlert
                              className="w-3.5 h-3.5 text-[#FF718B] shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <AlertTriangle
                              className={`w-3.5 h-3.5 shrink-0 ${
                                finding.severity === 'error'
                                  ? 'text-[#FF718B]'
                                  : 'text-[#FFCA70]'
                              }`}
                              aria-hidden="true"
                            />
                          )}
                          <span>{finding.kind}</span>
                        </span>
                        <span className="font-mono text-[#A6B0C8] tabular-nums">
                          Line {finding.line} · {finding.category || 'ast'}
                        </span>
                      </div>
                      <p className="text-xs text-[#A6B0C8]">{finding.message}</p>
                      {finding.snippet && (
                        <code className="block font-mono text-[11.5px] text-[#F4F7FF] bg-[#0B1020]/90 border border-white/10 rounded px-2.5 py-1 overflow-x-auto">
                          {finding.snippet}
                        </code>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Cyclomatic Complexity & Interprocedural Call Graph */}
            <div className="space-y-4">
              <div className="space-y-2.5">
                <h2 className="font-display text-sm font-semibold text-[#F4F7FF] inline-flex items-center gap-1.5">
                  <GitBranch className="w-4 h-4 text-[#50D7E6]" aria-hidden="true" />
                  <span>Control-Flow Complexity &amp; Call Graph</span>
                </h2>

                {functions.length === 0 ? (
                  <p className="text-xs text-[#A6B0C8]">
                    No function AST nodes parsed (repair syntax errors first to build CFG metrics).
                  </p>
                ) : (
                  <div className="border border-white/10 rounded-lg overflow-hidden bg-[#0B1020]/50">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-white/10 bg-[#0D1426]/90 text-[11px] text-[#A6B0C8]">
                          <th className="py-2 px-3 font-medium">Function</th>
                          <th className="py-2 px-3 font-medium text-right">Lines</th>
                          <th className="py-2 px-3 font-medium text-right">McCabe CC</th>
                          <th className="py-2 px-3 font-medium">Callees</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06] font-mono">
                        {functions.map((fn) => (
                          <tr key={fn.name} className="hover:bg-white/[0.04]">
                            <td className="py-2 px-3 text-[#F4F7FF] font-medium">
                              {fn.name}()
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums text-[#A6B0C8]">
                              {fn.startLine}–{fn.endLine}
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums text-[#50D7E6]">
                              {fn.cyclomaticComplexity}
                            </td>
                            <td className="py-2 px-3 text-[#A6B0C8] truncate max-w-[180px]">
                              {fn.calls.length > 0 ? fn.calls.join(', ') : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {callGraph.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-[#F4F7FF]">
                    Interprocedural Call Edges ({callGraph.length})
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[#A6B0C8]">
                    {callGraph.slice(0, 10).map((edge, i) => (
                      <span key={`${edge.caller}-${edge.callee}-${i}`}>
                        {edge.caller} → {edge.callee}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* Tab 3: APR Repair Trace & Mutant Fitness Evaluations */}
        {activeTab === 'apr' && (
          <motion.div
            key="apr"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={VIEW_TRANSITION}
            className="p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#8B7CFF]" aria-hidden="true" />
                <h2 className="font-display text-sm font-semibold text-[#F4F7FF]">
                  Automated Program Repair Execution Trace
                </h2>
              </div>
              <span className="font-mono text-xs tabular-nums text-[#A6B0C8]">
                {analysis.patchInfo.aprStrategy || 'Template-Based APR'} ·{' '}
                {analysis.patchInfo.durationMs.toFixed(1)} ms
              </span>
            </div>

            <div className="text-xs text-[#F4F7FF]/90 space-y-1">
              <div>
                <span className="text-[#A6B0C8]">Active Rule / Strategy: </span>
                <code className="font-mono text-[#50D7E6]">
                  {analysis.patchInfo.ruleId}
                </code>
              </div>
              <p className="text-[#A6B0C8] leading-relaxed">
                {analysis.patchInfo.strategy}
              </p>
            </div>

            {mutants.length > 0 ? (
              <div className="border border-white/10 rounded-lg overflow-hidden bg-[#0B1020]/50">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/10 bg-[#0D1426]/90 text-[11px] text-[#A6B0C8]">
                      <th className="py-2 px-3 font-medium text-right w-14">Line</th>
                      <th className="py-2 px-3 font-medium">Mutation Operator</th>
                      <th className="py-2 px-3 font-medium">Candidate Code</th>
                      <th className="py-2 px-3 font-medium text-right">Fitness</th>
                      <th className="py-2 px-3 font-medium text-right">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] font-mono">
                    {mutants.map((m, idx) => (
                      <tr
                        key={`${m.line}-${m.operator}-${idx}`}
                        className={
                          m.selected ? 'bg-[#51D6A2]/10' : 'hover:bg-white/[0.04]'
                        }
                      >
                        <td className="py-2 px-3 text-right tabular-nums text-[#A6B0C8]">
                          L{m.line}
                        </td>
                        <td className="py-2 px-3 font-sans text-[#F4F7FF]">
                          {m.operator}
                        </td>
                        <td className="py-2 px-3 text-[#F4F7FF] max-w-[260px] truncate">
                          {m.mutatedLine}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-[#F4F7FF]">
                          {m.passed}/{m.total} ({Math.round(m.fitness * 100)}%)
                        </td>
                        <td className="py-2 px-3 text-right font-sans font-medium">
                          {m.selected ? (
                            <span className="text-[#51D6A2]">Selected</span>
                          ) : (
                            <span className="text-[#A6B0C8]">Discarded</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[#A6B0C8]">
                Resolved deterministically via direct AST / static fix template without requiring evolutionary search mutations.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
