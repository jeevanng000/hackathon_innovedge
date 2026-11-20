import { useState } from 'react';
import {
  Search,
  Download,
  Trash2,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  AlertTriangle,
  Mic,
} from 'lucide-react';
import type { AuditEntry } from '../types/autopatch';
import {
  type AuditFilter,
  filterAuditEntries,
  formatAuditTimestamp,
  serializeAuditToCsv,
} from '../utils/diffAndAudit';

interface AuditLedgerViewProps {
  entries: AuditEntry[];
  onClearEntries: () => void;
  onGoToWorkbench: () => void;
}

function triggerFileDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function AuditLedgerView({
  entries,
  onClearEntries,
  onGoToWorkbench,
}: AuditLedgerViewProps) {
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [query, setQuery] = useState('');

  const filtered = filterAuditEntries(entries, filter, query);

  const acceptedCount = entries.filter((e) => e.decision === 'accepted').length;
  const rejectedCount = entries.filter((e) => e.decision === 'rejected').length;
  const overrideCount = entries.filter((e) => e.decision === 'override').length;
  const blockedCount = entries.filter((e) => e.decision === 'blocked').length;

  const filterOptions: Array<{ id: AuditFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'rejected', label: 'Rejected' },
    { id: 'override', label: 'Override' },
    { id: 'blocked', label: 'Blocked' },
  ];

  const handleExportCsv = () => {
    const csv = serializeAuditToCsv(filtered);
    triggerFileDownload('autopatch-audit-ledger.csv', csv, 'text/csv;charset=utf-8');
  };

  const handleExportJson = () => {
    const json = JSON.stringify(filtered, null, 2);
    triggerFileDownload('autopatch-audit-ledger.json', json, 'application/json');
  };

  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-white/10">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-[#A6B0C8]">
            <span>History</span>
            <span aria-hidden="true">/</span>
            <span className="text-[#F4F7FF]">Change &amp; Audit Ledger</span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F4F7FF]">
            Patch Change History &amp; Audit Trail
          </h1>
          <p className="text-sm text-[#A6B0C8]">
            Every analyzed file, line target, sandbox verification result, confidence score, and human approval or rejection decision.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-[#F4F7FF] bg-[#111930]/75 backdrop-blur-md border border-white/12 hover:bg-white/10 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-[#F4F7FF] bg-[#111930]/75 backdrop-blur-md border border-white/12 hover:bg-white/10 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
            <span>Export JSON</span>
          </button>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClearEntries}
              className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium text-[#FF718B] bg-[#FF718B]/10 border border-[#FF718B]/30 hover:bg-[#FF718B]/20 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Clear History</span>
            </button>
          )}
        </div>
      </div>

      {/* Summary Metrics Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl px-4 py-3.5 text-xs text-[#A6B0C8] font-mono tabular-nums shadow-lg shadow-black/20">
        <div>
          <span>Total </span>
          <strong className="text-[#F4F7FF]">{entries.length}</strong>
        </div>
        <div>
          <span>Accepted </span>
          <strong className="text-[#51D6A2]">{acceptedCount}</strong>
        </div>
        <div>
          <span>Rejected </span>
          <strong className="text-[#F4F7FF]">{rejectedCount}</strong>
        </div>
        <div>
          <span>Overrides </span>
          <strong className="text-[#FFCA70]">{overrideCount}</strong>
        </div>
        <div>
          <span>Blocked </span>
          <strong className="text-[#FF718B]">{blockedCount}</strong>
        </div>
      </div>

      {/* Search & Segmented Filter Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search
            className="w-4 h-4 text-[#A6B0C8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by file, bug type, rule, or note..."
            aria-label="Search change history"
            className="w-full pl-9 pr-3 py-2 text-xs text-[#F4F7FF] placeholder:text-[#A6B0C8]/65 bg-[#111930]/75 backdrop-blur-md border border-white/12 rounded-lg focus:outline-none focus:border-[#8B7CFF] focus:ring-2 focus:ring-[#8B7CFF]/25"
          />
        </div>

        <div
          role="group"
          aria-label="Filter history entries by decision"
          className="inline-flex items-center gap-1 p-1 bg-[#111930]/75 backdrop-blur-md border border-white/10 rounded-lg overflow-x-auto"
        >
          {filterOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              aria-pressed={filter === opt.id}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === opt.id
                  ? 'bg-[#8B7CFF] text-white shadow-sm'
                  : 'text-[#A6B0C8] hover:text-[#F4F7FF]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Populated Table or Empty State */}
      {entries.length === 0 ? (
        <section className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl px-6 py-14 text-center space-y-3 shadow-lg shadow-black/20">
          <h2 className="font-display text-base font-semibold text-[#F4F7FF]">
            No Patch Decisions Recorded Yet
          </h2>
          <p className="text-xs text-[#A6B0C8] max-w-md mx-auto">
            Run a scan on any source file and accept, reject, or override a proposed fix to build an exportable change history.
          </p>
          <button
            type="button"
            onClick={onGoToWorkbench}
            className="inline-flex items-center px-4 py-2 text-xs font-medium text-white bg-[#8B7CFF] hover:bg-[#7A69FF] rounded-lg transition-colors cursor-pointer"
          >
            Open Dashboard
          </button>
        </section>
      ) : filtered.length === 0 ? (
        <section className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl px-6 py-12 text-center space-y-2 shadow-lg shadow-black/20">
          <p className="text-sm font-medium text-[#F4F7FF]">
            No history records match your current filter.
          </p>
          <button
            type="button"
            onClick={() => {
              setFilter('all');
              setQuery('');
            }}
            className="text-xs font-medium text-[#50D7E6] hover:text-[#F4F7FF] cursor-pointer"
          >
            Reset search &amp; filters
          </button>
        </section>
      ) : (
        <section className="bg-[#111930]/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-xl shadow-black/25">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 bg-[#0D1426]/85 text-xs text-[#A6B0C8]">
                  <th className="py-2.5 px-4 font-medium whitespace-nowrap">Timestamp</th>
                  <th className="py-2.5 px-4 font-medium whitespace-nowrap">File &amp; Line</th>
                  <th className="py-2.5 px-4 font-medium whitespace-nowrap">Bug Type</th>
                  <th className="py-2.5 px-4 font-medium text-right whitespace-nowrap">
                    Confidence
                  </th>
                  <th className="py-2.5 px-4 font-medium text-right whitespace-nowrap">
                    Sandbox
                  </th>
                  <th className="py-2.5 px-4 font-medium whitespace-nowrap">Decision</th>
                  <th className="py-2.5 px-4 font-medium">Patch Summary &amp; Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-xs">
                {filtered.map((entry) => (
                  <tr
                    key={entry.id}
                    className="hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="py-3 px-4 font-mono tabular-nums text-[#A6B0C8] whitespace-nowrap align-top">
                      {formatAuditTimestamp(entry.timestamp)}
                    </td>
                    <td className="py-3 px-4 font-mono text-[#F4F7FF] whitespace-nowrap align-top">
                      <span>{entry.filename}</span>
                      {entry.line != null && (
                        <span className="text-[#50D7E6] tabular-nums">
                          :{entry.line}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-[#F4F7FF]/90 whitespace-nowrap align-top">
                      {entry.bugType}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-right text-[#F4F7FF] whitespace-nowrap align-top">
                      {entry.confidence}%
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-right text-[#A6B0C8] whitespace-nowrap align-top">
                      {entry.sandboxPassed}/{entry.sandboxTotal}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap align-top">
                      {entry.decision === 'accepted' && (
                        <span className="inline-flex items-center gap-1 font-medium text-[#51D6A2]">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Accepted</span>
                        </span>
                      )}
                      {entry.decision === 'rejected' && (
                        <span className="inline-flex items-center gap-1 font-medium text-[#A6B0C8]">
                          <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Rejected</span>
                        </span>
                      )}
                      {entry.decision === 'override' && (
                        <span className="inline-flex items-center gap-1 font-medium text-[#FFCA70]">
                          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Human Override</span>
                        </span>
                      )}
                      {entry.decision === 'blocked' && (
                        <span className="inline-flex items-center gap-1 font-medium text-[#FF718B]">
                          <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Blocked</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-[#F4F7FF]/85 align-top max-w-sm">
                      <p className="leading-relaxed">{entry.summary}</p>
                      {entry.overrideReason && (
                        <p className="mt-1 text-[11px] text-[#FFCA70]">
                          Override note: {entry.overrideReason}
                        </p>
                      )}
                      {entry.voiceNoteCount && entry.voiceNoteCount > 0 && (
                        <p className="mt-1 flex items-start gap-1 text-[11px] text-[#A6B0C8]">
                          <Mic
                            className="w-3 h-3 mt-0.5 text-[#FF718B] shrink-0"
                            aria-hidden="true"
                          />
                          <span>
                            {entry.voiceNoteCount} voice note{entry.voiceNoteCount === 1 ? '' : 's'}
                            {entry.voiceNotesSummary ? `: ${entry.voiceNotesSummary}` : ''}
                          </span>
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
