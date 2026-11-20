export type SupportedLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'c'
  | 'cpp'
  | 'java'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'bash'
  | 'sql'
  | 'generic';

export interface LanguageOption {
  id: SupportedLanguage;
  label: string;
  extensions: string[];
  executionMode: 'sandbox-runtime' | 'static-verifier';
  analysisKind: 'ast-parser' | 'compiler-diagnostics' | 'heuristic';
  runtimeLabel: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  {
    id: 'python',
    label: 'Python',
    extensions: ['.py'],
    executionMode: 'sandbox-runtime',
    analysisKind: 'ast-parser',
    runtimeLabel: 'Python 3 AST + Isolated Namespace Sandbox',
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    executionMode: 'sandbox-runtime',
    analysisKind: 'ast-parser',
    runtimeLabel: 'esbuild + Acorn AST + Isolated Node.js Sandbox',
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts'],
    executionMode: 'sandbox-runtime',
    analysisKind: 'ast-parser',
    runtimeLabel: 'esbuild + Acorn AST + Isolated Node.js Sandbox',
  },
  {
    id: 'c',
    label: 'C',
    extensions: ['.c', '.h'],
    executionMode: 'sandbox-runtime',
    analysisKind: 'compiler-diagnostics',
    runtimeLabel: 'GCC Compiler Diagnostics + Isolated Binary Sandbox',
  },
  {
    id: 'cpp',
    label: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
    executionMode: 'sandbox-runtime',
    analysisKind: 'compiler-diagnostics',
    runtimeLabel: 'G++ Compiler Diagnostics + Isolated Binary Sandbox',
  },
  {
    id: 'bash',
    label: 'Bash / Shell',
    extensions: ['.sh', '.bash'],
    executionMode: 'sandbox-runtime',
    analysisKind: 'compiler-diagnostics',
    runtimeLabel: 'Bash Syntax Check + Isolated Shell Sandbox',
  },
  {
    id: 'java',
    label: 'Java',
    extensions: ['.java'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local javac Runtime)',
  },
  {
    id: 'go',
    label: 'Go',
    extensions: ['.go'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local Go Runtime)',
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: ['.rs'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local rustc Runtime)',
  },
  {
    id: 'csharp',
    label: 'C#',
    extensions: ['.cs'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local .NET Runtime)',
  },
  {
    id: 'php',
    label: 'PHP',
    extensions: ['.php'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local PHP Runtime)',
  },
  {
    id: 'ruby',
    label: 'Ruby',
    extensions: ['.rb'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local Ruby Runtime)',
  },
  {
    id: 'sql',
    label: 'SQL',
    extensions: ['.sql'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic SQL Query Analysis Only',
  },
  {
    id: 'generic',
    label: 'Other / Generic',
    extensions: ['.kt', '.swift', '.scala', '.dart', '.lua', '.r', '.pl', '.txt'],
    executionMode: 'static-verifier',
    analysisKind: 'heuristic',
    runtimeLabel: 'Static Heuristic Analysis Only (No Local Runtime)',
  },
];

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.id));

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGE_SET.has(value);
}

export const EXECUTABLE_SANDBOX_LANGUAGES: ReadonlySet<SupportedLanguage> = new Set([
  'python',
  'javascript',
  'typescript',
  'c',
  'cpp',
  'bash',
]);

export function detectLanguageFromFilename(filename: string): SupportedLanguage {
  const lower = (filename || '').trim().toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return 'generic';
  const ext = lower.slice(dotIdx);

  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.extensions.includes(ext)) {
      return lang.id;
    }
  }
  return 'generic';
}

/**
 * Detects language from code content signatures when a judge pastes raw code
 * into the default blank editor, falling back to the filename extension.
 */
export function detectLanguageFromCodeOrFilename(
  sourceCode: string,
  filename: string
): SupportedLanguage {
  const code = (sourceCode || '').trim();
  const isDefaultName =
    !filename ||
    filename === 'snippet.py' ||
    filename === 'live_judge_code.py' ||
    filename === 'module.py' ||
    filename === 'untitled';

  if (code) {
    if (/^\s*(--|\/\*[\s\S]*?\*\/\s*)?(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/im.test(code) && !/\b(def |function |class |import |#include)\b/.test(code)) {
      return 'sql';
    }
    if (/^\s*#include\s+[<"](iostream|vector|string|map|algorithm)[>"]|\bstd::/m.test(code)) {
      return 'cpp';
    }
    if (/^\s*#include\s+[<"][\w./]+[>"]/m.test(code)) {
      return 'c';
    }
    if (/\bpublic\s+(?:final\s+)?class\s+\w+|\bSystem\.out\.print/m.test(code)) {
      return 'java';
    }
    if (/\bfn\s+\w+\s*\([^)]*\)\s*(?:->|\{)|\blet\s+mut\s+\w+/m.test(code)) {
      return 'rust';
    }
    if (/^\s*package\s+\w+[\s\S]*\bfunc\s+/m.test(code)) {
      return 'go';
    }
    if (/^\s*<\?php\b|\$[A-Za-z_]\w*\s*=/m.test(code) && /;\s*$/m.test(code)) {
      return 'php';
    }
    if (/^\s*#!/m.test(code) && /\b(bash|sh)\b/.test(code.split('\n')[0])) {
      return 'bash';
    }
    if (/\busing\s+System;|\bnamespace\s+[\w.]+/m.test(code)) {
      return 'csharp';
    }
    if (
      /\b(?:interface|type)\s+[A-Z]\w*|\b(?:export\s+)?function\s+\w+\s*\([^)]*:\s*(?:number|string|boolean|any|Record|Array)\b/m.test(
        code
      )
    ) {
      return 'typescript';
    }
    if (
      /\b(?:const|let|var)\s+\w+\s*=|\bfunction\s+\w+\s*\(|\bconsole\.log\s*\(/m.test(code) &&
      !/\bdef\s+\w+\s*\(/.test(code)
    ) {
      return isDefaultName ? 'javascript' : detectLanguageFromFilename(filename);
    }
    if (/^\s*def\s+\w+\s*\([^)]*\)\s*:/m.test(code) || /^\s*from\s+[\w.]+\s+import\s+/m.test(code)) {
      return 'python';
    }
  }

  return detectLanguageFromFilename(filename);
}

export function getLanguageMeta(id: SupportedLanguage): LanguageOption {
  return (
    SUPPORTED_LANGUAGES.find((l) => l.id === id) ??
    SUPPORTED_LANGUAGES[SUPPORTED_LANGUAGES.length - 1]
  );
}
