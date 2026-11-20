import { useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Cpu,
  FileCode2,
  FlaskConical,
  Paperclip,
  RotateCw,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { DemoCase, WorkspaceFileItem } from '../types/autopatch';

interface WelcomeHeroInputProps {
  filename: string;
  sourceCode: string;
  errorStatement: string;
  presets: DemoCase[];
  queuedFiles: WorkspaceFileItem[];
  activeFileId: string | null;
  isCompact: boolean;
  isScanning: boolean;
  geminiConfigured: boolean | null;
  validationError: string | null;
  onChangeFilename: (name: string) => void;
  onChangeSourceCode: (code: string) => void;
  onChangeErrorStatement: (err: string) => void;
  onSelectPreset: (preset: DemoCase) => void;
  onSelectFile: (fileId: string) => void;
  onAddFiles: (files: Array<{ name: string; content: string }>) => void;
  onRemoveFile: (fileId: string) => void;
  onClearFiles: () => void;
  onSubmitScan: (mode: 'gemini' | 'local-sandbox') => void;
}

export function WelcomeHeroInput({
  filename,
  sourceCode,
  errorStatement,
  presets,
  queuedFiles,
  activeFileId,
  isCompact,
  isScanning,
  geminiConfigured,
  validationError,
  onChangeFilename,
  onChangeSourceCode,
  onChangeErrorStatement,
  onSelectPreset,
  onSelectFile,
  onAddFiles,
  onRemoveFile,
  onClearFiles,
  onSubmitScan,
}: WelcomeHeroInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showErrorField, setShowErrorField] = useState(Boolean(errorStatement.trim()));
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const readFileList = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const loaded = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        content: await file.text(),
      }))
    );
    const nonEmpty = loaded.filter((f) => f.content.length > 0 || f.name.trim().length > 0);
    if (nonEmpty.length > 0) {
      onAddFiles(nonEmpty);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    void readFileList(e.target.files);
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    void readFileList(e.dataTransfer?.files ?? null);
  };

  const lineCount = sourceCode ? sourceCode.split('\n').length : 0;
  const totalQueuedCount = queuedFiles.length;

  // Compact docked top bar after user submits so workspace stays front-and-center
  if (isCompact && !compactExpanded) {
    return (
      <section
        aria-label="Submitted code summary bar"
        className="workspace-spring mx-auto w-full max-w-6xl"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/85 dark:border-white/15 bg-white/80 dark:bg-slate-900/75 backdrop-blur-xl px-4 py-2.5 shadow-lg shadow-indigo-500/5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-500/12 text-indigo-600 dark:text-indigo-300">
              <FileCode2 className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs sm:text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {filename || 'snippet.py'}
                </span>
                <span className="tabular-nums rounded-md bg-slate-100 dark:bg-white/10 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                  {lineCount} lines
                </span>
                {totalQueuedCount > 1 && (
                  <span className="tabular-nums rounded-md bg-indigo-500/12 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
                    {totalQueuedCount} files
                  </span>
                )}
              </div>
              {errorStatement.trim() && (
                <p className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400 max-w-md">
                  {errorStatement.trim().split('\n')[0]}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setCompactExpanded(true)}
              className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-slate-200/80 dark:border-white/15 bg-white dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:shadow-md cursor-pointer"
            >
              <span>Edit Input</span>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              disabled={isScanning}
              onClick={() => onSubmitScan('gemini')}
              className="tactile-btn gemini-accent-gradient inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-500/20 disabled:opacity-60 cursor-pointer"
            >
              <RotateCw
                className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>
                {isScanning
                  ? 'Scanning...'
                  : totalQueuedCount > 1
                  ? `Re-scan All (${totalQueuedCount})`
                  : 'Re-scan'}
              </span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Code and problem input"
      className={`workspace-spring mx-auto w-full ${
        isCompact
          ? 'max-w-6xl py-0'
          : 'max-w-3xl min-h-[calc(100vh-8rem)] flex flex-col justify-center py-8 sm:py-12'
      }`}
    >
      {/* Centered Gemini-like Welcome Greeting */}
      {!isCompact && (
        <div className="mb-7 text-center space-y-3 px-2">
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/25 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Autonomous 5-Stage Bug Detection &amp; Repair</span>
          </div>
          <h1 className="font-display text-3xl sm:text-[40px] font-semibold tracking-tight text-slate-900 dark:text-white leading-tight">
            Find the root cause.{' '}
            <span className="gemini-text-gradient">Patch with proof.</span>
          </h1>
          <p className="mx-auto max-w-xl text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
            Paste your code snippet, drop a traceback or problem statement, or upload one or more
            source &amp; test files. AutoPatch executes across all files seamlessly.
          </p>
        </div>
      )}

      {/* Floating Input Card */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`workspace-spring relative rounded-3xl border bg-white/85 dark:bg-slate-900/80 backdrop-blur-xl shadow-2xl shadow-indigo-500/10 p-4 sm:p-5 transition-colors ${
          isDragging
            ? 'border-indigo-500 ring-2 ring-indigo-500/30'
            : 'border-slate-200/90 dark:border-white/15'
        }`}
      >
        {/* Top Meta Strip inside Input Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-200/70 dark:border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode2
              className="h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-400"
              aria-hidden="true"
            />
            <label htmlFor="autopatch-filename" className="sr-only">
              Filename
            </label>
            <input
              id="autopatch-filename"
              type="text"
              value={filename}
              onChange={(e) => onChangeFilename(e.target.value)}
              placeholder="snippet.py"
              className="w-36 sm:w-44 rounded-lg border border-transparent hover:border-slate-200 dark:hover:border-white/15 focus:border-indigo-500/60 bg-slate-100/70 dark:bg-white/5 px-2.5 py-1 font-mono text-xs text-slate-800 dark:text-slate-100 focus:outline-none transition-colors"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileUpload}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-slate-200/80 dark:border-white/15 bg-slate-50 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:shadow-md hover:shadow-indigo-500/10 cursor-pointer"
            >
              <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Upload Files</span>
            </button>

            <button
              type="button"
              onClick={() => setShowErrorField((prev) => !prev)}
              className={`tactile-btn inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium cursor-pointer ${
                showErrorField || errorStatement.trim()
                  ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                  : 'border-slate-200/80 dark:border-white/15 bg-slate-50 dark:bg-white/5 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{showErrorField ? 'Hide Traceback' : 'Add Error Log'}</span>
            </button>

            {isCompact && (
              <button
                type="button"
                onClick={() => setCompactExpanded(false)}
                aria-label="Collapse input editor"
                className="tactile-btn inline-flex items-center gap-1 rounded-xl border border-slate-200/80 dark:border-white/15 bg-slate-50 dark:bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Collapse</span>
              </button>
            )}
          </div>
        </div>

        {/* Multi-file Queued Strip */}
        {queuedFiles.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-2xl border border-slate-200/70 dark:border-white/10 bg-slate-50/75 dark:bg-white/[0.03] px-2.5 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
              Files ({queuedFiles.length}):
            </span>
            {queuedFiles.map((item) => {
              const isSelected = item.id === activeFileId;
              return (
                <div
                  key={item.id}
                  className={`inline-flex items-center gap-1 rounded-lg border pl-2 pr-1 py-1 text-xs font-mono transition-colors ${
                    isSelected
                      ? 'border-indigo-500/50 bg-indigo-500/12 text-indigo-800 dark:text-indigo-200 font-semibold'
                      : 'border-slate-200/80 dark:border-white/10 bg-white/80 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:border-indigo-400/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectFile(item.id)}
                    className="inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <span className="truncate max-w-[160px]">{item.filename}</span>
                    {item.testCode.trim() && (
                      <span
                        title={item.testFilename || 'Paired unit tests'}
                        className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-sans font-medium text-emerald-700 dark:text-emerald-300"
                      >
                        <FlaskConical className="h-2.5 w-2.5" aria-hidden="true" />
                        tests
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${item.filename}`}
                    onClick={() => onRemoveFile(item.id)}
                    className="rounded p-0.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 cursor-pointer"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            {queuedFiles.length > 1 && (
              <button
                type="button"
                onClick={onClearFiles}
                className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                <span>Clear</span>
              </button>
            )}
          </div>
        )}

        {/* Code / Problem Textarea */}
        <label htmlFor="autopatch-code-input" className="sr-only">
          Code snippet or problem statement
        </label>
        <textarea
          id="autopatch-code-input"
          value={sourceCode}
          onChange={(e) => onChangeSourceCode(e.target.value)}
          rows={isCompact ? 5 : 7}
          placeholder="Paste your code snippet, drop multiple files here, or describe the failing behavior..."
          className="code-editor code-scroll w-full resize-y rounded-2xl border border-slate-200/70 dark:border-white/10 bg-slate-50/75 dark:bg-black/25 p-3.5 text-xs sm:text-[13px] leading-relaxed text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-indigo-500/60 focus:outline-none transition-colors"
        />

        {/* Optional Error / Problem Statement Field */}
        {(showErrorField || errorStatement.trim().length > 0) && (
          <div className="mt-3">
            <label
              htmlFor="autopatch-error-input"
              className="block mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
            >
              Error / Traceback / Problem Context (Optional)
            </label>
            <textarea
              id="autopatch-error-input"
              value={errorStatement}
              onChange={(e) => onChangeErrorStatement(e.target.value)}
              rows={2}
              placeholder="e.g. TypeError: 'NoneType' object is not subscriptable on line 6..."
              className="code-editor code-scroll w-full resize-y rounded-xl border border-slate-200/70 dark:border-white/10 bg-slate-50/75 dark:bg-black/25 p-2.5 text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-indigo-500/60 focus:outline-none"
            />
          </div>
        )}

        {validationError && (
          <p
            role="alert"
            className="mt-2.5 text-xs font-medium text-red-600 dark:text-red-400"
          >
            {validationError}
          </p>
        )}

        {/* Action Footer inside Floating Bar */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onSelectPreset(preset)}
                className="tactile-btn rounded-xl border border-slate-200/80 dark:border-white/10 bg-slate-100/80 dark:bg-white/[0.04] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-indigo-400/50 hover:text-indigo-700 dark:hover:text-indigo-200 hover:shadow-md hover:shadow-indigo-500/10 cursor-pointer"
              >
                {preset.title}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              disabled={isScanning}
              onClick={() => {
                setCompactExpanded(false);
                onSubmitScan('local-sandbox');
              }}
              className="tactile-btn inline-flex items-center gap-1.5 rounded-xl border border-slate-200/80 dark:border-white/15 bg-white dark:bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:shadow-md hover:shadow-indigo-500/10 disabled:opacity-50 cursor-pointer"
            >
              <Cpu className="h-3.5 w-3.5 text-indigo-500" aria-hidden="true" />
              <span>
                {totalQueuedCount > 1
                  ? `Run Sandbox (${totalQueuedCount})`
                  : 'Run Local Sandbox'}
              </span>
            </button>

            <button
              type="button"
              disabled={isScanning}
              onClick={() => {
                setCompactExpanded(false);
                onSubmitScan(geminiConfigured === false ? 'local-sandbox' : 'gemini');
              }}
              className="tactile-btn gemini-accent-gradient inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:shadow-indigo-500/35 disabled:opacity-60 cursor-pointer"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>
                {isScanning
                  ? 'Running AutoPatch...'
                  : totalQueuedCount > 1
                  ? `Analyze & Patch All (${totalQueuedCount} Files)`
                  : 'Analyze & Patch'}
              </span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

