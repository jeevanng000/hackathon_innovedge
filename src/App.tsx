import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { DEMO_CASES } from './data/demoCases';
import type {
  AnalysisResponse,
  AutoPatchBug,
  AutoPatchReport,
  BatchFileResult,
  DemoCase,
  SafeChangeHistoryEntry,
  SafePatchDecision,
  WorkflowStageId,
  WorkspaceFileItem,
} from './types/autopatch';
import {
  adaptDeterministicAnalysisToReport,
  applyPatchToCode,
  createHistoryEntry,
  getAdjacentBugId,
  mergeAutoPatchReports,
  pairSourceAndTestFiles,
  validateSubmissionInput,
} from './utils/autopatchWorkflow';
import { detectLanguageFromCodeOrFilename } from './utils/languageDetect';
import { isEditableTargetElement } from './utils/unifiedFindings';
import { AuroraBackdrop } from './components/AuroraBackdrop';
import { TopBar, type MainScreen } from './components/TopBar';
import { WelcomeHeroInput } from './components/WelcomeHeroInput';
import { WorkspaceDashboard } from './components/WorkspaceDashboard';
import { BugGlassModal } from './components/BugGlassModal';
import { DebuggingDock } from './components/DebuggingDock';
import { SafeChangeHistoryView } from './components/SafeChangeHistoryView';

const HISTORY_STORAGE_KEY = 'autopatch.safeHistory.v1';
const THEME_STORAGE_KEY = 'autopatch.theme.v1';

function loadStoredHistory(): SafeChangeHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SafeChangeHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function loadInitialTheme(): boolean {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

async function runSingleFileScan(params: {
  mode: 'gemini' | 'local-sandbox';
  filename: string;
  sourceCode: string;
  testCode: string;
  testFilename?: string;
  errorStatement: string;
  onPartialReport?: (partial: AutoPatchReport) => void;
}): Promise<AutoPatchReport> {
  const safeName = params.filename.trim() || 'snippet.py';
  const lang = detectLanguageFromCodeOrFilename(params.sourceCode, safeName);

  const runSandbox = async (): Promise<AutoPatchReport> => {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: safeName,
        testFilename: params.testFilename || `test_${safeName}`,
        language: lang,
        sourceCode: params.sourceCode,
        testCode: params.testCode,
        bugContext: params.errorStatement,
        includeAiScan: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Local sandbox analysis failed.');
    }
    return adaptDeterministicAnalysisToReport(data as AnalysisResponse);
  };

  if (params.mode === 'local-sandbox') {
    return runSandbox();
  }

  // Launch fast deterministic AST + sandbox analysis in parallel with Gemini AutoPatch
  // so the user receives near-instant progressive output even on tough/large files.
  let geminiSettled = false;

  const sandboxPromise: Promise<AutoPatchReport | null> = runSandbox()
    .then((sandboxReport) => {
      if (!geminiSettled) {
        params.onPartialReport?.(sandboxReport);
      }
      return sandboxReport;
    })
    .catch(() => null);

  const geminiPromise: Promise<AutoPatchReport> = (async () => {
    const res = await fetch('/api/autopatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceCode: params.sourceCode,
        errorStatement: params.errorStatement,
        filename: safeName,
        language: lang,
        testCode: params.testCode,
        testFilename: params.testFilename,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Gemini scan failed.');
    }
    return data as AutoPatchReport;
  })();

  try {
    const geminiReport = await geminiPromise;
    geminiSettled = true;
    const sandboxReport = await Promise.race([
      sandboxPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 120)),
    ]);
    return sandboxReport
      ? mergeAutoPatchReports(geminiReport, sandboxReport)
      : geminiReport;
  } catch (err) {
    const sandboxReport = await sandboxPromise;
    if (sandboxReport) {
      return sandboxReport;
    }
    throw err;
  }
}

export default function App() {
  const [isDark, setIsDark] = useState<boolean>(() => loadInitialTheme());
  const [activeScreen, setActiveScreen] = useState<MainScreen>('workspace');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const [filename, setFilename] = useState('snippet.py');
  const [sourceCode, setSourceCode] = useState('');
  const [testCode, setTestCode] = useState('');
  const [testFilename, setTestFilename] = useState<string | undefined>(undefined);
  const [errorStatement, setErrorStatement] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const [filesQueue, setFilesQueue] = useState<WorkspaceFileItem[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<Record<string, BatchFileResult>>({});

  const [geminiConfigured, setGeminiConfigured] = useState<boolean | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [currentStage, setCurrentStage] = useState<WorkflowStageId>(1);
  const [report, setReport] = useState<AutoPatchReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const [activeBugId, setActiveBugId] = useState<string | null>(null);
  const [modalBugId, setModalBugId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, SafePatchDecision>>({});
  const [dockExpanded, setDockExpanded] = useState(false);

  const [historyEntries, setHistoryEntries] = useState<SafeChangeHistoryEntry[]>(() =>
    loadStoredHistory()
  );

  const stageTimersRef = useRef<number[]>([]);
  const autostartTriggeredRef = useRef(false);
  const activeFileIdRef = useRef<string | null>(activeFileId);

  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    } catch {
      // Ignore storage errors
    }
  }, [isDark]);

  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(historyEntries));
    } catch {
      // Ignore storage errors
    }
  }, [historyEntries]);

  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (active && typeof data?.geminiConfigured === 'boolean') {
          setGeminiConfigured(data.geminiConfigured);
        }
      })
      .catch(() => {
        if (active) setGeminiConfigured(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const clearStageTimers = useCallback(() => {
    for (const t of stageTimersRef.current) {
      window.clearTimeout(t);
    }
    stageTimersRef.current = [];
  }, []);

  useEffect(() => () => clearStageTimers(), [clearStageTimers]);

  const syncEditorToFile = useCallback(
    (
      file: WorkspaceFileItem,
      nextBatchResult?: BatchFileResult | null
    ) => {
      setActiveFileId(file.id);
      setFilename(file.filename);
      setSourceCode(file.sourceCode);
      setTestCode(file.testCode);
      setTestFilename(file.testFilename);
      setErrorStatement(file.errorStatement);

      if (nextBatchResult) {
        setReport(nextBatchResult.report);
        setDecisions(nextBatchResult.decisions);
        setErrorMessage(nextBatchResult.errorMessage);
        setErrorCode(nextBatchResult.errorCode);
        setCurrentStage(nextBatchResult.currentStage);
        setActiveBugId(nextBatchResult.report?.bugs[0]?.id ?? null);
        setModalBugId(null);
      }
    },
    []
  );

  const handleAddFiles = useCallback(
    (loadedFiles: Array<{ name: string; content: string }>) => {
      setValidationError(null);
      const existingRaw = filesQueue.flatMap((item) => {
        const list: Array<{ name: string; content: string; errorStatement?: string }> = [
          {
            name: item.filename,
            content: item.id === activeFileId ? sourceCode : item.sourceCode,
            errorStatement: item.id === activeFileId ? errorStatement : item.errorStatement,
          },
        ];
        if (item.testCode.trim()) {
          list.push({
            name: item.testFilename || `test_${item.filename}`,
            content: item.testCode,
          });
        }
        return list;
      });

      const mergedByName = new Map<
        string,
        { name: string; content: string; errorStatement?: string }
      >();
      for (const f of existingRaw) {
        mergedByName.set(f.name.toLowerCase(), f);
      }
      for (const f of loadedFiles) {
        mergedByName.set(f.name.toLowerCase(), f);
      }

      const paired = pairSourceAndTestFiles(Array.from(mergedByName.values()));
      setFilesQueue(paired);

      if (paired.length > 0) {
        const preferred =
          paired.find((p) =>
            loadedFiles.some(
              (lf) => lf.name.toLowerCase() === p.filename.toLowerCase()
            )
          ) ?? paired[0];
        syncEditorToFile(preferred, batchResults[preferred.id] ?? null);
      }
    },
    [activeFileId, batchResults, errorStatement, filesQueue, sourceCode, syncEditorToFile]
  );

  const handleSelectFile = useCallback(
    (fileId: string) => {
      const next = filesQueue.find((f) => f.id === fileId);
      if (!next) return;
      // Persist current editor edits into previous active file item before switching
      if (activeFileId && activeFileId !== fileId) {
        setFilesQueue((prev) =>
          prev.map((item) =>
            item.id === activeFileId
              ? { ...item, filename, sourceCode, testCode, errorStatement }
              : item
          )
        );
      }
      syncEditorToFile(next, batchResults[fileId] ?? null);
    },
    [
      activeFileId,
      batchResults,
      errorStatement,
      filename,
      filesQueue,
      sourceCode,
      syncEditorToFile,
      testCode,
    ]
  );

  const handleRemoveFile = useCallback(
    (fileId: string) => {
      const remaining = filesQueue.filter((f) => f.id !== fileId);
      setFilesQueue(remaining);
      setBatchResults((prev) => {
        const copy = { ...prev };
        delete copy[fileId];
        return copy;
      });
      if (activeFileId === fileId) {
        if (remaining.length > 0) {
          syncEditorToFile(remaining[0], batchResults[remaining[0].id] ?? null);
        } else {
          setActiveFileId(null);
          setFilename('snippet.py');
          setSourceCode('');
          setTestCode('');
          setTestFilename(undefined);
          setErrorStatement('');
          setReport(null);
          setDecisions({});
          setActiveBugId(null);
          setModalBugId(null);
        }
      }
    },
    [activeFileId, batchResults, filesQueue, syncEditorToFile]
  );

  const handleClearFiles = useCallback(() => {
    setFilesQueue([]);
    setBatchResults({});
    setActiveFileId(null);
    setFilename('snippet.py');
    setSourceCode('');
    setTestCode('');
    setTestFilename(undefined);
    setErrorStatement('');
    setReport(null);
    setDecisions({});
    setActiveBugId(null);
    setModalBugId(null);
  }, []);

  const updateActiveFileField = useCallback(
    (patch: Partial<Pick<WorkspaceFileItem, 'filename' | 'sourceCode' | 'errorStatement'>>) => {
      if (!activeFileId) return;
      setFilesQueue((prev) =>
        prev.map((item) => (item.id === activeFileId ? { ...item, ...patch } : item))
      );
    },
    [activeFileId]
  );

  const executeScan = useCallback(
    async (params: {
      mode: 'gemini' | 'local-sandbox';
      codeOverride?: string;
      errOverride?: string;
      filenameOverride?: string;
      testCodeOverride?: string;
    }) => {
      const hasOverride = params.codeOverride !== undefined;
      const itemsToScan: WorkspaceFileItem[] =
        !hasOverride && filesQueue.length > 0
          ? filesQueue.map((item) =>
              item.id === activeFileId
                ? {
                    ...item,
                    filename: filename.trim() || item.filename,
                    sourceCode,
                    testCode,
                    errorStatement,
                  }
                : item
            )
          : [
              {
                id: activeFileId || 'single-snippet',
                filename: (params.filenameOverride ?? filename).trim() || 'snippet.py',
                sourceCode: params.codeOverride ?? sourceCode,
                testCode: params.testCodeOverride ?? testCode,
                testFilename,
                errorStatement: params.errOverride ?? errorStatement,
                language: detectLanguageFromCodeOrFilename(
                  params.codeOverride ?? sourceCode,
                  (params.filenameOverride ?? filename).trim() || 'snippet.py'
                ),
              },
            ];

      const validItems = itemsToScan.filter((item) =>
        validateSubmissionInput(item.sourceCode.trim() || item.errorStatement.trim()).valid
      );

      if (validItems.length === 0) {
        const firstCheck = validateSubmissionInput(
          (itemsToScan[0]?.sourceCode ?? '').trim() ||
            (itemsToScan[0]?.errorStatement ?? '').trim()
        );
        setValidationError(firstCheck.error ?? 'Input required.');
        return;
      }

      setValidationError(null);
      setActiveScreen('workspace');
      setHasSubmitted(true);
      setIsScanning(true);
      setErrorMessage(null);
      setErrorCode(null);
      setReport(null);
      setModalBugId(null);
      setActiveBugId(null);
      setDecisions({});

      if (!hasOverride && filesQueue.length > 0) {
        setFilesQueue(validItems);
      }

      const initialBatch: Record<string, BatchFileResult> = {};
      for (const item of validItems) {
        initialBatch[item.id] = {
          fileId: item.id,
          filename: item.filename,
          status: 'pending',
          currentStage: 1,
          report: null,
          decisions: {},
          errorMessage: null,
          errorCode: null,
        };
      }
      setBatchResults(initialBatch);

      clearStageTimers();
      setCurrentStage(2);
      stageTimersRef.current.push(
        window.setTimeout(() => setCurrentStage(3), 260),
        window.setTimeout(() => setCurrentStage(4), 560),
        window.setTimeout(() => setCurrentStage(5), 880)
      );

      const activeTargetId =
        (activeFileId && validItems.some((i) => i.id === activeFileId)
          ? activeFileId
          : validItems[0].id);

      let firstCompletedReport: AutoPatchReport | null = null;
      let firstError: string | null = null;
      let nextIndex = 0;

      const processItem = async (item: WorkspaceFileItem) => {
        setBatchResults((prev) => ({
          ...prev,
          [item.id]: {
            ...prev[item.id],
            status: 'scanning',
            currentStage: 3,
          },
        }));

        const isViewedTarget = () =>
          validItems.length === 1 ||
          activeFileIdRef.current === item.id ||
          (!activeFileIdRef.current && item.id === activeTargetId);

        try {
          const nextReport = await runSingleFileScan({
            mode: params.mode,
            filename: item.filename,
            sourceCode: item.sourceCode,
            testCode: item.testCode,
            testFilename: item.testFilename,
            errorStatement: item.errorStatement,
            onPartialReport: (partial) => {
              setBatchResults((prev) => ({
                ...prev,
                [item.id]: {
                  ...(prev[item.id] ?? {
                    fileId: item.id,
                    filename: item.filename,
                    decisions: {},
                    errorMessage: null,
                    errorCode: null,
                  }),
                  status: 'scanning',
                  currentStage: 4,
                  report: partial,
                },
              }));

              if (isViewedTarget()) {
                setCurrentStage(4);
                setReport(partial);
                setActiveBugId((prev) => prev ?? partial.bugs[0]?.id ?? null);
              }
            },
          });

          setBatchResults((prev) => ({
            ...prev,
            [item.id]: {
              fileId: item.id,
              filename: item.filename,
              status: 'completed',
              currentStage: 5,
              report: nextReport,
              decisions: prev[item.id]?.decisions ?? {},
              errorMessage: null,
              errorCode: null,
            },
          }));

          if (!firstCompletedReport) {
            firstCompletedReport = nextReport;
          }

          if (isViewedTarget()) {
            setActiveFileId(item.id);
            setFilename(item.filename);
            setSourceCode(item.sourceCode);
            setTestCode(item.testCode);
            setTestFilename(item.testFilename);
            setErrorStatement(item.errorStatement);
            setReport(nextReport);
            const firstBugId = nextReport.bugs[0]?.id ?? null;
            setActiveBugId((prev) =>
              prev && nextReport.bugs.some((b) => b.id === prev) ? prev : firstBugId
            );
            if (validItems.length === 1 && firstBugId) {
              setModalBugId((prev) => prev ?? firstBugId);
            }
          }
        } catch (err) {
          const typedErr = err as Error & { code?: string };
          const msg = typedErr.message || 'Unable to run AutoPatch workflow.';
          if (!firstError) firstError = msg;

          setBatchResults((prev) => ({
            ...prev,
            [item.id]: {
              ...prev[item.id],
              status: 'error',
              currentStage: 5,
              errorMessage: msg,
              errorCode: typedErr.code ?? null,
            },
          }));

          if (isViewedTarget()) {
            setErrorMessage(msg);
            setErrorCode(typedErr.code ?? null);
          }
        }
      };

      const workerCount = Math.min(4, validItems.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (nextIndex < validItems.length) {
            const current = validItems[nextIndex++];
            await processItem(current);
          }
        })
      );

      clearStageTimers();
      setCurrentStage(5);
      setIsScanning(false);

      if (validItems.length > 1 && !firstCompletedReport && firstError) {
        setErrorMessage(firstError);
      }
    },
    [
      activeFileId,
      clearStageTimers,
      errorStatement,
      filename,
      filesQueue,
      sourceCode,
      testCode,
      testFilename,
    ]
  );

  // Support ?autostart=1 for automated workspace checks
  useEffect(() => {
    if (autostartTriggeredRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      autostartTriggeredRef.current = true;
      const demo = DEMO_CASES[0];
      setFilesQueue([]);
      setActiveFileId(null);
      setBatchResults({});
      setFilename(demo.filename);
      setSourceCode(demo.sourceCode);
      setTestCode(demo.testCode);
      setErrorStatement(demo.bugContext ?? '');
      void executeScan({
        mode: geminiConfigured ? 'gemini' : 'local-sandbox',
        codeOverride: demo.sourceCode,
        errOverride: demo.bugContext ?? '',
        filenameOverride: demo.filename,
        testCodeOverride: demo.testCode,
      });
    }
  }, [executeScan, geminiConfigured]);

  const handleSelectPreset = (preset: DemoCase) => {
    setValidationError(null);
    setFilesQueue([]);
    setActiveFileId(null);
    setBatchResults({});
    setFilename(preset.filename);
    setSourceCode(preset.sourceCode);
    setTestCode(preset.testCode);
    setTestFilename(preset.testFilename);
    setErrorStatement(preset.bugContext ?? '');
  };

  const handleResetToWelcome = () => {
    clearStageTimers();
    setActiveScreen('workspace');
    setHasSubmitted(false);
    setIsScanning(false);
    setCurrentStage(1);
    setReport(null);
    setBatchResults({});
    setErrorMessage(null);
    setErrorCode(null);
    setActiveBugId(null);
    setModalBugId(null);
    setDecisions({});
    setValidationError(null);
    setDockExpanded(false);
  };

  const handleAcceptPatch = (bug: AutoPatchBug) => {
    if (decisions[bug.id] === 'Accepted') {
      setModalBugId(null);
      return;
    }
    const { updatedCode } = applyPatchToCode(sourceCode, bug);
    setSourceCode(updatedCode);
    const nextDecisions: Record<string, SafePatchDecision> = {
      ...decisions,
      [bug.id]: 'Accepted',
    };
    setDecisions(nextDecisions);

    if (activeFileId) {
      setFilesQueue((prev) =>
        prev.map((item) =>
          item.id === activeFileId ? { ...item, sourceCode: updatedCode } : item
        )
      );
      setBatchResults((prev) =>
        prev[activeFileId]
          ? {
              ...prev,
              [activeFileId]: {
                ...prev[activeFileId],
                decisions: nextDecisions,
              },
            }
          : prev
      );
    }

    const entry = createHistoryEntry({
      bug,
      decision: 'Accepted',
      filename: filename || 'snippet.py',
      executionSource: report?.execution_source ?? 'gemini',
    });
    setHistoryEntries((prev) => [entry, ...prev]);
    setModalBugId(null);
  };

  const handleRejectPatch = (bug: AutoPatchBug) => {
    const nextDecisions: Record<string, SafePatchDecision> = {
      ...decisions,
      [bug.id]: 'Rejected',
    };
    setDecisions(nextDecisions);

    if (activeFileId) {
      setBatchResults((prev) =>
        prev[activeFileId]
          ? {
              ...prev,
              [activeFileId]: {
                ...prev[activeFileId],
                decisions: nextDecisions,
              },
            }
          : prev
      );
    }

    const entry = createHistoryEntry({
      bug,
      decision: 'Rejected',
      filename: filename || 'snippet.py',
      executionSource: report?.execution_source ?? 'gemini',
    });
    setHistoryEntries((prev) => [entry, ...prev]);
    setModalBugId(null);
  };

  const orderedBatchResults = useMemo(() => {
    if (filesQueue.length > 0) {
      return filesQueue
        .map((f) => batchResults[f.id])
        .filter((r): r is BatchFileResult => Boolean(r));
    }
    return Object.values(batchResults);
  }, [batchResults, filesQueue]);

  const bugs = useMemo(() => report?.bugs ?? [], [report]);
  const modalBug = useMemo(
    () => bugs.find((b) => b.id === modalBugId) ?? null,
    [bugs, modalBugId]
  );
  const modalBugIndex = useMemo(
    () => (modalBug ? bugs.findIndex((b) => b.id === modalBug.id) : -1),
    [bugs, modalBug]
  );

  // Power-user keyboard navigation for detected bugs
  useEffect(() => {
    if (!hasSubmitted || activeScreen !== 'workspace' || bugs.length === 0) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableTargetElement(e.target as HTMLElement | null)) return;

      if (e.key === 'n' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextId = getAdjacentBugId(bugs, modalBugId ?? activeBugId, 'next');
        if (nextId) {
          setActiveBugId(nextId);
          if (modalBugId) setModalBugId(nextId);
        }
      } else if (e.key === 'p' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevId = getAdjacentBugId(bugs, modalBugId ?? activeBugId, 'prev');
        if (prevId) {
          setActiveBugId(prevId);
          if (modalBugId) setModalBugId(prevId);
        }
      } else if (e.key === 'Enter' && !modalBugId && activeBugId) {
        e.preventDefault();
        setModalBugId(activeBugId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeBugId, activeScreen, bugs, hasSubmitted, modalBugId]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-screen flex flex-col overflow-x-hidden text-slate-900 dark:text-slate-100">
        <AuroraBackdrop />

        <TopBar
          activeScreen={activeScreen}
          onSelectScreen={setActiveScreen}
          hasStartedWorkspace={hasSubmitted}
          onResetToWelcome={handleResetToWelcome}
          historyCount={historyEntries.length}
          isDark={isDark}
          onToggleTheme={() => setIsDark((prev) => !prev)}
        />

        <main className="flex-1 w-full">
          <AnimatePresence mode="wait" initial={false}>
            {activeScreen === 'history' ? (
              <motion.div
                key="history-view"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <SafeChangeHistoryView
                  entries={historyEntries}
                  onClearHistory={() => setHistoryEntries([])}
                  onBackToWorkspace={() => setActiveScreen('workspace')}
                />
              </motion.div>
            ) : (
              <motion.div
                key="workspace-view"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="mx-auto max-w-6xl px-4 sm:px-6 py-5 sm:py-7 pb-28 space-y-6"
              >
                <WelcomeHeroInput
                  filename={filename}
                  sourceCode={sourceCode}
                  errorStatement={errorStatement}
                  presets={DEMO_CASES}
                  queuedFiles={filesQueue}
                  activeFileId={activeFileId}
                  isCompact={hasSubmitted}
                  isScanning={isScanning}
                  geminiConfigured={geminiConfigured}
                  validationError={validationError}
                  onChangeFilename={(next) => {
                    setFilename(next);
                    updateActiveFileField({ filename: next });
                  }}
                  onChangeSourceCode={(next) => {
                    setSourceCode(next);
                    updateActiveFileField({ sourceCode: next });
                    if (validationError) setValidationError(null);
                  }}
                  onChangeErrorStatement={(next) => {
                    setErrorStatement(next);
                    updateActiveFileField({ errorStatement: next });
                  }}
                  onSelectPreset={handleSelectPreset}
                  onSelectFile={handleSelectFile}
                  onAddFiles={handleAddFiles}
                  onRemoveFile={handleRemoveFile}
                  onClearFiles={handleClearFiles}
                  onSubmitScan={(mode) => void executeScan({ mode })}
                />

                {hasSubmitted && (
                  <WorkspaceDashboard
                    filename={filename}
                    sourceCode={sourceCode}
                    report={report}
                    activeBugId={activeBugId}
                    decisions={decisions}
                    isScanning={isScanning}
                    currentStage={currentStage}
                    errorMessage={errorMessage}
                    errorCode={errorCode}
                    batchResults={orderedBatchResults}
                    activeFileId={activeFileId}
                    onSelectFile={handleSelectFile}
                    onSelectBug={(id) => {
                      setActiveBugId(id);
                      setModalBugId(id);
                    }}
                    onRunLocalSandboxFallback={() =>
                      void executeScan({ mode: 'local-sandbox' })
                    }
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Glassmorphism Error Pop-Up */}
        <BugGlassModal
          bug={modalBug}
          bugsCount={bugs.length}
          currentIndex={modalBugIndex}
          decision={modalBug ? decisions[modalBug.id] : undefined}
          onClose={() => setModalBugId(null)}
          onNavigate={(dir) => {
            const nextId = getAdjacentBugId(bugs, modalBugId, dir);
            if (nextId) {
              setActiveBugId(nextId);
              setModalBugId(nextId);
            }
          }}
          onAcceptPatch={handleAcceptPatch}
          onRejectPatch={handleRejectPatch}
        />

        {/* Lower-Mid Debugging Dock */}
        <DebuggingDock
          visible={hasSubmitted && activeScreen === 'workspace'}
          expanded={dockExpanded}
          onToggleExpand={() => setDockExpanded((prev) => !prev)}
          isScanning={isScanning}
          currentStage={currentStage}
          report={report}
          decisions={decisions}
          errorMessage={errorMessage}
          onSelectBug={(id) => {
            setActiveBugId(id);
            setModalBugId(id);
          }}
        />
      </div>
    </MotionConfig>
  );
}
