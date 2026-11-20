import { useRef, useState } from 'react';
import {
  Play,
  Upload,
  FilePlus2,
  CheckCircle2,
  ShieldAlert,
  FileCode2,
  ArrowRight,
  FolderOpen,
} from 'lucide-react';
import type { DemoCase } from '../types/autopatch';

interface ProjectsViewProps {
  demoCases: DemoCase[];
  activeDemoId: string | null;
  currentFilename: string;
  onOpenDemoProject: (demo?: DemoCase) => void;
  onStartBlank: () => void;
  onUploadSource: (filename: string, content: string) => void;
  onUploadTest: (filename: string, content: string) => void;
  onBackToDashboard: () => void;
}

const UNIVERSAL_CODE_ACCEPT =
  '.py,.js,.mjs,.cjs,.jsx,.ts,.tsx,.mts,.c,.h,.cpp,.cc,.cxx,.hpp,.java,.go,.rs,.cs,.php,.rb,.sh,.bash,.sql,.kt,.swift,.scala,.dart,.lua,.r,.pl,.txt';

export function ProjectsView({
  demoCases,
  activeDemoId,
  currentFilename,
  onOpenDemoProject,
  onStartBlank,
  onUploadSource,
  onUploadTest,
  onBackToDashboard,
}: ProjectsViewProps) {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const testInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const readFile = (
    file: File | undefined,
    cb: (name: string, content: string) => void
  ) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        cb(file.name, reader.result);
      }
    };
    reader.readAsText(file);
  };

  const primaryDemo = demoCases[0];

  return (
    <div className="max-w-[1240px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-white/10">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-[#A6B0C8]">
            <span>Projects</span>
            <span aria-hidden="true">/</span>
            <span className="font-mono text-[#F4F7FF]">{currentFilename}</span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F4F7FF] text-balance">
            Choose, Upload, or Open a Demo Project
          </h1>
          <p className="text-sm text-[#A6B0C8] max-w-2xl">
            Load one of our bundled Python or multi-language defect cases to see AutoPatch in action immediately, or upload your own source file and test suite.
          </p>
        </div>

        <button
          type="button"
          onClick={onBackToDashboard}
          className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-medium text-[#F4F7FF] bg-[#111930]/75 backdrop-blur-md border border-white/15 hover:bg-white/10 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span>Return to Dashboard</span>
          <ArrowRight className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
        </button>
      </div>

      {/* Hero Quick-Start Row: Prominent Open Demo Project + Drag/Drop Upload */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Open Demo Project CTA Card */}
        <section
          aria-label="Featured demo project"
          className="lg:col-span-7 bg-[#111930]/75 backdrop-blur-md border border-white/12 rounded-xl p-6 shadow-xl shadow-black/25 flex flex-col justify-between gap-5"
        >
          <div className="space-y-2.5">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-[#50D7E6]">
              <FolderOpen className="w-4 h-4" aria-hidden="true" />
              <span>Recommended Quick Start · Python Project</span>
            </div>
            <h2 className="font-display text-xl font-semibold text-[#F4F7FF]">
              {primaryDemo?.title || 'Auth Service'} — Inspect Real Defects &amp; Sandbox Proof
            </h2>
            <p className="text-sm text-[#A6B0C8] leading-relaxed">
              {primaryDemo?.description ||
                'Opens the bundled Python auth_service.py module with unit tests and traceback context so you can scan, inspect findings, review the proposed diff, and verify tests pass.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onOpenDemoProject(primaryDemo)}
              className="inline-flex items-center gap-2 h-11 px-5 text-sm font-semibold text-white bg-[#8B7CFF] hover:bg-[#7A69FF] active:scale-[0.98] rounded-lg shadow-lg shadow-[#8B7CFF]/25 border border-white/15 transition-all whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#50D7E6]"
            >
              <Play className="w-4 h-4 fill-current" aria-hidden="true" />
              <span>Open demo project</span>
            </button>

            <button
              type="button"
              onClick={onStartBlank}
              className="inline-flex items-center gap-2 h-11 px-4 text-sm font-medium text-[#F4F7FF] bg-white/5 hover:bg-white/10 border border-white/12 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <FilePlus2 className="w-4 h-4 text-[#50D7E6]" aria-hidden="true" />
              <span>Start Blank Snippet</span>
            </button>
          </div>
        </section>

        {/* Right: Drag & Drop / Upload Your Own Files Card */}
        <section
          aria-label="Upload project files"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            readFile(e.dataTransfer.files?.[0], onUploadSource);
          }}
          className={`lg:col-span-5 bg-[#111930]/75 backdrop-blur-md border rounded-xl p-6 shadow-xl shadow-black/25 flex flex-col justify-between gap-4 transition-all ${
            isDraggingOver
              ? 'border-[#50D7E6] ring-2 ring-[#50D7E6]/35 bg-[#162344]/85'
              : 'border-white/12'
          }`}
        >
          <input
            ref={sourceInputRef}
            type="file"
            accept={UNIVERSAL_CODE_ACCEPT}
            className="sr-only"
            aria-label="Upload project source file"
            onChange={(e) => {
              readFile(e.target.files?.[0], onUploadSource);
              e.target.value = '';
            }}
          />
          <input
            ref={testInputRef}
            type="file"
            accept={UNIVERSAL_CODE_ACCEPT}
            className="sr-only"
            aria-label="Upload unit test file"
            onChange={(e) => {
              readFile(e.target.files?.[0], onUploadTest);
              e.target.value = '';
            }}
          />

          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-[#8B7CFF]">
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Upload Local Files</span>
            </div>
            <h2 className="font-display text-lg font-semibold text-[#F4F7FF]">
              Analyze Your Own Source &amp; Tests
            </h2>
            <p className="text-xs text-[#A6B0C8] leading-relaxed">
              Drop any Python, TypeScript, JavaScript, C, Java, Go, Rust, or shell file right here, or pick files from your computer. Missing test suites are synthesized automatically when needed.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => sourceInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 h-10 px-3.5 text-xs font-medium text-[#F4F7FF] bg-white/8 hover:bg-white/14 border border-white/15 rounded-lg transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
              <span>Upload Source File</span>
            </button>
            <button
              type="button"
              onClick={() => testInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 h-10 px-3.5 text-xs font-medium text-[#F4F7FF] bg-white/5 hover:bg-white/12 border border-white/12 rounded-lg transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-[#A6B0C8]" aria-hidden="true" />
              <span>Upload Test Suite</span>
            </button>
          </div>
        </section>
      </div>

      {/* Bundled Project Gallery */}
      <section aria-label="Bundled sample projects" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold text-[#F4F7FF]">
            Bundled Sample Projects ({demoCases.length})
          </h2>
          <span className="text-xs text-[#A6B0C8]">
            Python, TypeScript, C, and Java testbeds
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {demoCases.map((demo) => {
            const isSelected = activeDemoId === demo.id;
            const isBlockedCase = demo.expectedOutcome === 'blocked-review';

            return (
              <article
                key={demo.id}
                className={`bg-[#111930]/70 backdrop-blur-md border rounded-xl p-5 flex flex-col justify-between gap-4 transition-all hover:-translate-y-0.5 hover:border-white/25 ${
                  isSelected
                    ? 'border-[#8B7CFF]/70 ring-1 ring-[#8B7CFF]/35'
                    : 'border-white/10'
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-display text-sm font-semibold text-[#F4F7FF] truncate">
                        {demo.title}
                      </h3>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs font-mono text-[#A6B0C8]">
                        <FileCode2 className="w-3.5 h-3.5 text-[#50D7E6] shrink-0" aria-hidden="true" />
                        <span className="truncate">{demo.filename}</span>
                      </div>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md border whitespace-nowrap shrink-0 ${
                        isBlockedCase
                          ? 'bg-[#FFCA70]/10 text-[#FFCA70] border-[#FFCA70]/30'
                          : 'bg-[#51D6A2]/10 text-[#51D6A2] border-[#51D6A2]/30'
                      }`}
                    >
                      {isBlockedCase ? (
                        <>
                          <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                          <span>Human Review</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                          <span>Auto-Verified</span>
                        </>
                      )}
                    </span>
                  </div>

                  <p className="text-xs text-[#A6B0C8] leading-relaxed line-clamp-3">
                    {demo.description}
                  </p>
                </div>

                <div className="pt-3 border-t border-white/10 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-[#A6B0C8] truncate">
                    {demo.language} · {demo.category}
                  </span>

                  <button
                    type="button"
                    onClick={() => onOpenDemoProject(demo)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isSelected
                        ? 'bg-[#8B7CFF] text-white'
                        : 'bg-white/8 hover:bg-[#8B7CFF] text-[#F4F7FF] hover:text-white border border-white/12 hover:border-transparent'
                    }`}
                  >
                    <span>{isSelected ? 'Open in Dashboard' : 'Load Project'}</span>
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
