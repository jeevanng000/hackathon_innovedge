import { History, Moon, Plus, Sparkles, Sun, TerminalSquare } from 'lucide-react';

export type MainScreen = 'workspace' | 'history';

interface TopBarProps {
  activeScreen: MainScreen;
  onSelectScreen: (screen: MainScreen) => void;
  hasStartedWorkspace: boolean;
  onResetToWelcome: () => void;
  historyCount: number;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function TopBar({
  activeScreen,
  onSelectScreen,
  hasStartedWorkspace,
  onResetToWelcome,
  historyCount,
  isDark,
  onToggleTheme,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/70 dark:border-white/10 bg-white/75 dark:bg-[#0B1120]/75 backdrop-blur-xl transition-colors duration-300">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6">
        {/* Left: Brand Identity */}
        <button
          type="button"
          onClick={onResetToWelcome}
          className="tactile-btn group flex items-center gap-2 rounded-xl px-1.5 py-1 text-left cursor-pointer shrink-0"
          aria-label="AutoPatch Home"
        >
          <span className="gemini-accent-gradient flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm shadow-indigo-500/25">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-sm sm:text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              AutoPatch
            </span>
            <span className="hidden md:inline text-xs font-medium text-slate-500 dark:text-slate-400">
              Autonomous Repair
            </span>
          </div>
        </button>

        {/* Center: Clean Minimal Navigation */}
        <nav aria-label="Primary views" className="flex items-center gap-1 sm:gap-2 min-w-0">
          <button
            type="button"
            onClick={() => onSelectScreen('workspace')}
            className={`tactile-btn relative flex items-center gap-1.5 rounded-xl px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium whitespace-nowrap cursor-pointer ${
              activeScreen === 'workspace'
                ? 'bg-slate-900/5 dark:bg-white/10 text-slate-900 dark:text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Workspace</span>
          </button>

          <button
            type="button"
            onClick={() => onSelectScreen('history')}
            aria-label="Safe Change History"
            className={`tactile-btn relative flex items-center gap-1.5 rounded-xl px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium whitespace-nowrap cursor-pointer ${
              activeScreen === 'history'
                ? 'bg-slate-900/5 dark:bg-white/10 text-slate-900 dark:text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Safe Change History</span>
            <span className="sm:hidden">History</span>
            {historyCount > 0 && (
              <span className="tabular-nums ml-0.5 rounded-md bg-indigo-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
                {historyCount}
              </span>
            )}
          </button>
        </nav>

        {/* Right: New Scan & Theme Toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {hasStartedWorkspace && (
            <button
              type="button"
              onClick={onResetToWelcome}
              className="tactile-btn hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-slate-200/80 dark:border-white/15 bg-white/80 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:shadow-md hover:shadow-indigo-500/10 cursor-pointer whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>New Scan</span>
            </button>
          )}

          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="tactile-btn flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200/80 dark:border-white/15 bg-white/80 dark:bg-white/5 text-slate-700 dark:text-slate-200 hover:shadow-md hover:shadow-indigo-500/10 cursor-pointer"
          >
            {isDark ? (
              <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4 text-indigo-600" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
