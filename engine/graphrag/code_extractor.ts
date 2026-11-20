import { parse, type Node as AcornNode } from 'acorn';
import { transform } from 'esbuild';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeJsTsAst } from '../js_ts_ast.ts';
import { detectLanguageFromFilename } from '../../src/utils/languageDetect.ts';

export interface ExtractedFunction {
  id: string;
  name: string;
  signature: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  codeSnippet: string;
  summary: string;
  calls: string[];
  classUsages: string[];
  isExported: boolean;
}

export interface ExtractedClass {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  methods: string[];
  summary: string;
}

export interface ExtractedDependency {
  id: string;
  name: string;
  kind: 'internal' | 'external';
  filePath: string;
}

export interface ExtractedTest {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  calledSymbols: string[];
  summary: string;
}

export interface ExtractedFinding {
  id: string;
  kind: string;
  title: string;
  category: string;
  severity: string;
  filePath: string;
  line: number;
  functionName: string;
  message: string;
  snippet: string;
  isVulnerability: boolean;
}

export interface ExtractedFileData {
  id: string;
  path: string;
  language: string;
  contentHash: string;
  lineCount: number;
  sizeBytes: number;
  parserUsed: 'esbuild+acorn' | 'python3-ast' | 'static-metadata';
  functions: ExtractedFunction[];
  classes: ExtractedClass[];
  dependencies: ExtractedDependency[];
  tests: ExtractedTest[];
  findings: ExtractedFinding[];
}

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.playwright-cli',
  '.autopatch-data',
  '.aistudio',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.next',
]);

const SUPPORTED_SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
]);

const SENSITIVE_FILENAME_RX =
  /(^\.env($|\.)|\.(pem|key|p12|pfx|crt|cer|jks|keystore|sqlite|db|bin|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip|tar|gz|lock)$|package-lock\.json|yarn\.lock|bun\.lock|id_rsa|secret|credential)/i;

export function isExcludedRepoPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) return true;
  }
  const base = parts[parts.length - 1] || '';
  if (SENSITIVE_FILENAME_RX.test(base)) return true;
  return false;
}

function isPathStrictlyInside(parentRealPath: string, childRealPath: string): boolean {
  const rel = path.relative(parentRealPath, childRealPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function discoverRepositoryFiles(
  rootDir: string,
  maxFiles = 200
): Promise<string[]> {
  const resolvedRoot = path.resolve(rootDir);
  let realRoot = resolvedRoot;
  try {
    realRoot = await fs.realpath(resolvedRoot);
  } catch {
    return [];
  }
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      // Never follow symlinks so out-of-repo files or secrets cannot be ingested
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(resolvedRoot, fullPath).replace(/\\/g, '/');
      if (isExcludedRepoPath(relPath)) continue;

      let realEntry: string;
      try {
        realEntry = await fs.realpath(fullPath);
      } catch {
        continue;
      }
      if (!isPathStrictlyInside(realRoot, realEntry)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_SOURCE_EXTS.has(ext)) continue;
        try {
          const stat = await fs.lstat(fullPath);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > 300_000) continue;
          results.push(relPath);
        } catch {
          // ignore unreadable file
        }
      }
    }
  }

  await walk(resolvedRoot);
  return results;
}

interface AnyNode extends AcornNode {
  [key: string]: unknown;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

function walkAst(node: unknown, visitor: (n: AnyNode, parent: AnyNode | null) => void, parent: AnyNode | null = null): void {
  if (!node || typeof node !== 'object') return;
  const anyNode = node as AnyNode;
  if (typeof anyNode.type === 'string') {
    visitor(anyNode, parent);
    for (const [k, v] of Object.entries(anyNode)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === 'object' && typeof (item as AnyNode).type === 'string') {
            walkAst(item, visitor, anyNode);
          }
        }
      } else if (v && typeof v === 'object' && typeof (v as AnyNode).type === 'string') {
        walkAst(v, visitor, anyNode);
      }
    }
  }
}

function getCalleeIdentifier(callee: AnyNode | null | undefined): string {
  if (!callee) return '';
  if (callee.type === 'Identifier') return String(callee.name || '');
  if (callee.type === 'MemberExpression' && !callee.computed) {
    const prop = callee.property as AnyNode | undefined;
    if (prop?.type === 'Identifier') return String(prop.name || '');
  }
  return '';
}

function formatParams(params: unknown): string {
  if (!Array.isArray(params)) return '';
  return (params as AnyNode[])
    .map((p) => {
      if (p.type === 'Identifier') return String(p.name || '');
      if (p.type === 'AssignmentPattern' && (p.left as AnyNode)?.type === 'Identifier') {
        return `${String((p.left as AnyNode).name)}=...`;
      }
      if (p.type === 'RestElement' && (p.argument as AnyNode)?.type === 'Identifier') {
        return `...${String((p.argument as AnyNode).name)}`;
      }
      if (p.type === 'ObjectPattern') return '{...}';
      if (p.type === 'ArrayPattern') return '[...]';
      return 'arg';
    })
    .filter(Boolean)
    .join(', ');
}

function decodeVlqLineMap(sourceMapJson: string | undefined): Map<number, number> {
  const map = new Map<number, number>();
  if (!sourceMapJson) return map;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const cmap = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) cmap.set(chars[i], i);

  try {
    const parsed = JSON.parse(sourceMapJson) as { mappings?: string };
    const mappings = parsed.mappings || '';
    let genLine = 1;
    let origLine = 0;
    let idx = 0;
    while (idx < mappings.length) {
      const ch = mappings[idx];
      if (ch === ';') {
        genLine++;
        idx++;
        continue;
      }
      if (ch === ',') {
        idx++;
        continue;
      }
      const fields: number[] = [];
      let val = 0;
      let shift = 0;
      while (idx < mappings.length && mappings[idx] !== ',' && mappings[idx] !== ';') {
        const d = cmap.get(mappings[idx++]);
        if (d === undefined) continue;
        val += (d & 31) << shift;
        if ((d & 32) !== 0) {
          shift += 5;
        } else {
          const neg = (val & 1) === 1;
          const signed = val >> 1;
          fields.push(neg ? -signed : signed);
          val = 0;
          shift = 0;
        }
      }
      if (fields.length >= 4) {
        origLine += fields[2];
        if (!map.has(genLine)) map.set(genLine, origLine + 1);
      }
    }
  } catch {
    // identity fallback
  }
  return map;
}

async function extractJsTsFile(
  projectId: string,
  relPath: string,
  content: string,
  contentHash: string
): Promise<ExtractedFileData> {
  const ext = path.extname(relPath).toLowerCase();
  const loader: 'ts' | 'tsx' | 'js' | 'jsx' =
    ext === '.tsx' ? 'tsx' : ext === '.ts' ? 'ts' : ext === '.jsx' ? 'jsx' : 'js';
  const language = ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';
  const origLines = content.split('\n');
  const maxLine = Math.max(1, origLines.length);

  const functions: ExtractedFunction[] = [];
  const classes: ExtractedClass[] = [];
  const dependencies: ExtractedDependency[] = [];
  const tests: ExtractedTest[] = [];
  const findings: ExtractedFinding[] = [];
  const depSet = new Set<string>();

  const isTestFile = /(^|\/)(test_.*|.*\.test\.[jt]sx?|.*\.spec\.[jt]sx?)$/i.test(relPath);

  let jsCode = content;
  let lineMap = new Map<number, number>();
  let parsedOk = false;

  try {
    const transformed = await transform(content, {
      loader,
      format: 'esm',
      sourcefile: relPath,
      sourcemap: 'external',
    });
    jsCode = transformed.code;
    lineMap = decodeVlqLineMap(transformed.map);

    const program = parse(jsCode, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    }) as unknown as AnyNode;
    parsedOk = true;

    const toOrig = (genLine: number | undefined): number => {
      if (!genLine) return 1;
      const mapped = lineMap.get(genLine) ?? genLine;
      return Math.max(1, Math.min(maxLine, mapped));
    };

    const collectBodyRefs = (bodyNode: unknown, selfName: string) => {
      const calls = new Set<string>();
      const classUsages = new Set<string>();
      walkAst(bodyNode, (n) => {
        if (n.type === 'CallExpression') {
          const callee = getCalleeIdentifier(n.callee as AnyNode);
          if (callee && callee !== selfName && callee.length > 1) {
            calls.add(callee);
          }
        } else if (n.type === 'NewExpression') {
          const cname = getCalleeIdentifier(n.callee as AnyNode);
          if (cname && /^[A-Z]/.test(cname)) {
            classUsages.add(cname);
          }
        }
      });
      return {
        calls: Array.from(calls).slice(0, 40),
        classUsages: Array.from(classUsages).slice(0, 20),
      };
    };

    const seenFnIds = new Set<string>();

    walkAst(program, (node, parent) => {
      // Imports / dependencies
      if (node.type === 'ImportDeclaration') {
        const src = (node.source as AnyNode)?.value;
        if (typeof src === 'string' && src.trim() && !depSet.has(src)) {
          depSet.add(src);
          dependencies.push({
            id: `dep:${projectId}:${src}`,
            name: src,
            kind: src.startsWith('.') || src.startsWith('/') ? 'internal' : 'external',
            filePath: relPath,
          });
        }
      }

      // Classes
      if (node.type === 'ClassDeclaration' && (node.id as AnyNode)?.type === 'Identifier') {
        const clsName = String((node.id as AnyNode).name);
        const startLine = toOrig(node.loc?.start.line);
        const endLine = toOrig(node.loc?.end.line);
        const methods: string[] = [];
        const body = (node.body as AnyNode)?.body;
        if (Array.isArray(body)) {
          for (const m of body as AnyNode[]) {
            if (m.type === 'MethodDefinition' && (m.key as AnyNode)?.type === 'Identifier') {
              methods.push(String((m.key as AnyNode).name));
            }
          }
        }
        classes.push({
          id: `cls:${projectId}:${relPath}:${clsName}:${startLine}`,
          name: clsName,
          filePath: relPath,
          startLine,
          endLine,
          methods,
          summary: `Class ${clsName} in ${relPath} (L${startLine}-L${endLine}) with methods: ${methods.join(', ') || 'none'}.`,
        });
      }

      // Functions (FunctionDeclaration, exported const arrow/function, class methods)
      if (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression'
      ) {
        let fnName = '';
        let isExported = false;
        if (node.type === 'FunctionDeclaration' && (node.id as AnyNode)?.type === 'Identifier') {
          fnName = String((node.id as AnyNode).name);
          isExported =
            parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration';
        } else if (parent?.type === 'VariableDeclarator' && (parent.id as AnyNode)?.type === 'Identifier') {
          fnName = String((parent.id as AnyNode).name);
        } else if (parent?.type === 'MethodDefinition' && (parent.key as AnyNode)?.type === 'Identifier') {
          const mName = String((parent.key as AnyNode).name);
          if (mName !== 'constructor') fnName = mName;
        }

        if (fnName) {
          const startLine = toOrig(node.loc?.start.line);
          const endLine = toOrig(node.loc?.end.line);
          const fnId = `fn:${projectId}:${relPath}:${fnName}:${startLine}`;
          if (!seenFnIds.has(fnId)) {
            seenFnIds.add(fnId);
            const sig = `${fnName}(${formatParams(node.params)})`;
            const { calls, classUsages } = collectBodyRefs(node.body, fnName);
            const snippet = origLines.slice(startLine - 1, Math.min(endLine, startLine + 24)).join('\n').slice(0, 1600);
            functions.push({
              id: fnId,
              name: fnName,
              signature: sig,
              filePath: relPath,
              startLine,
              endLine,
              language,
              codeSnippet: snippet,
              summary: `Function ${sig} in ${relPath} (L${startLine}-L${endLine}). Calls: ${calls.slice(0, 8).join(', ') || 'none'}.`,
              calls,
              classUsages,
              isExported,
            });
            if (isTestFile && fnName.startsWith('test')) {
              tests.push({
                id: `test:${projectId}:${relPath}:${fnName}:${startLine}`,
                name: fnName,
                filePath: relPath,
                startLine,
                endLine,
                calledSymbols: calls,
                summary: `Test ${fnName} in ${relPath} (L${startLine}-L${endLine}) exercising: ${calls.slice(0, 8).join(', ') || 'module'}.`,
              });
            }
          }
        }
      }

      // node:test / vitest / jest test('name', () => ...) calls
      if (node.type === 'CallExpression') {
        const callee = getCalleeIdentifier(node.callee as AnyNode);
        if ((callee === 'test' || callee === 'it') && Array.isArray(node.arguments) && node.arguments.length >= 2) {
          const firstArg = node.arguments[0] as AnyNode;
          const secondArg = node.arguments[1] as AnyNode;
          if (firstArg?.type === 'Literal' && typeof firstArg.value === 'string') {
            const testName = firstArg.value.trim().slice(0, 120);
            const startLine = toOrig(node.loc?.start.line);
            const endLine = toOrig(node.loc?.end.line);
            const { calls } = collectBodyRefs(secondArg, testName);
            tests.push({
              id: `test:${projectId}:${relPath}:${crypto.createHash('sha1').update(`${testName}:${startLine}`).digest('hex').slice(0, 10)}`,
              name: testName,
              filePath: relPath,
              startLine,
              endLine,
              calledSymbols: calls,
              summary: `Automated test "${testName}" in ${relPath} (L${startLine}-L${endLine}) exercising: ${calls.slice(0, 8).join(', ') || 'module'}.`,
            });
          }
        }
      }
    });

    // Run real AST static security/bug scan on non-test TS/JS files to capture real findings
    if (!isTestFile && (ext === '.ts' || ext === '.js')) {
      const astReport = await analyzeJsTsAst(content, path.basename(relPath), language);
      for (const f of astReport.findings) {
        const isVuln = f.category === 'security';
        findings.push({
          id: `${isVuln ? 'vuln' : 'finding'}:${projectId}:${relPath}:${f.kind}:${f.line}`,
          kind: f.kind,
          title: `${f.kind} in ${path.basename(relPath)}:${f.line}`,
          category: f.category || 'runtime',
          severity: f.severity,
          filePath: relPath,
          line: f.line,
          functionName: f.function || '<module>',
          message: f.message,
          snippet: f.snippet,
          isVulnerability: isVuln,
        });
      }
    }
  } catch {
    // Parser encountered syntax outside standard TS/JS ESM; keep file metadata cleanly
  }

  return {
    id: `file:${projectId}:${relPath}`,
    path: relPath,
    language,
    contentHash,
    lineCount: origLines.length,
    sizeBytes: Buffer.byteLength(content, 'utf-8'),
    parserUsed: parsedOk ? 'esbuild+acorn' : 'static-metadata',
    functions,
    classes,
    dependencies,
    tests,
    findings,
  };
}

const PY_AST_EXTRACTOR_SCRIPT = `
import ast, json, sys
src = sys.stdin.read()
lines = src.splitlines()
out = {"ok": False, "functions": [], "classes": [], "dependencies": [], "tests": []}
try:
    tree = ast.parse(src)
    out["ok"] = True
except Exception:
    print(json.dumps(out))
    sys.exit(0)

seen_deps = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name not in seen_deps:
                seen_deps.add(alias.name)
                out["dependencies"].append({"name": alias.name, "kind": "external"})
    elif isinstance(node, ast.ImportFrom):
        mod = ("." * (node.level or 0)) + (node.module or "")
        if mod and mod not in seen_deps:
            seen_deps.add(mod)
            out["dependencies"].append({"name": mod, "kind": "internal" if mod.startswith(".") else "external"})

for node in ast.walk(tree):
    if isinstance(node, ast.ClassDef):
        methods = [n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        out["classes"].append({
            "name": node.name,
            "startLine": node.lineno,
            "endLine": getattr(node, "end_lineno", node.lineno),
            "methods": methods,
        })
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [a.arg for a in node.args.args]
        calls = []
        class_usages = []
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                cname = ""
                if isinstance(sub.func, ast.Name):
                    cname = sub.func.id
                elif isinstance(sub.func, ast.Attribute):
                    cname = sub.func.attr
                if cname and cname != node.name:
                    if cname[0].isupper():
                        if cname not in class_usages:
                            class_usages.append(cname)
                    if cname not in calls:
                        calls.append(cname)
        start_l = node.lineno
        end_l = getattr(node, "end_lineno", start_l)
        snippet = "\\n".join(lines[start_l - 1 : min(end_l, start_l + 24)])[:1600]
        rec = {
            "name": node.name,
            "signature": f"{node.name}({', '.join(args)})",
            "startLine": start_l,
            "endLine": end_l,
            "calls": calls[:40],
            "classUsages": class_usages[:20],
            "codeSnippet": snippet,
        }
        out["functions"].append(rec)
        if node.name.startswith("test_"):
            out["tests"].append(rec)

print(json.dumps(out))
`;

function extractPythonFile(
  projectId: string,
  relPath: string,
  content: string,
  contentHash: string
): ExtractedFileData {
  const lineCount = content.split('\n').length;
  const sizeBytes = Buffer.byteLength(content, 'utf-8');

  const proc = spawnSync('python3', ['-I', '-c', PY_AST_EXTRACTOR_SCRIPT], {
    input: content,
    encoding: 'utf-8',
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
  });

  if (proc.status !== 0 || !proc.stdout.trim()) {
    return {
      id: `file:${projectId}:${relPath}`,
      path: relPath,
      language: 'python',
      contentHash,
      lineCount,
      sizeBytes,
      parserUsed: 'static-metadata',
      functions: [],
      classes: [],
      dependencies: [],
      tests: [],
      findings: [],
    };
  }

  try {
    const parsed = JSON.parse(proc.stdout.trim()) as {
      ok: boolean;
      functions: Array<{
        name: string;
        signature: string;
        startLine: number;
        endLine: number;
        calls: string[];
        classUsages: string[];
        codeSnippet: string;
      }>;
      classes: Array<{ name: string; startLine: number; endLine: number; methods: string[] }>;
      dependencies: Array<{ name: string; kind: 'internal' | 'external' }>;
      tests: Array<{ name: string; startLine: number; endLine: number; calls: string[] }>;
    };

    const functions: ExtractedFunction[] = (parsed.functions || []).map((fn) => ({
      id: `fn:${projectId}:${relPath}:${fn.name}:${fn.startLine}`,
      name: fn.name,
      signature: fn.signature,
      filePath: relPath,
      startLine: fn.startLine,
      endLine: fn.endLine,
      language: 'python',
      codeSnippet: fn.codeSnippet,
      summary: `Python function ${fn.signature} in ${relPath} (L${fn.startLine}-L${fn.endLine}). Calls: ${fn.calls.slice(0, 8).join(', ') || 'none'}.`,
      calls: fn.calls,
      classUsages: fn.classUsages,
      isExported: !fn.name.startsWith('_'),
    }));

    const classes: ExtractedClass[] = (parsed.classes || []).map((c) => ({
      id: `cls:${projectId}:${relPath}:${c.name}:${c.startLine}`,
      name: c.name,
      filePath: relPath,
      startLine: c.startLine,
      endLine: c.endLine,
      methods: c.methods,
      summary: `Python class ${c.name} in ${relPath} (L${c.startLine}-L${c.endLine}) with methods: ${c.methods.join(', ') || 'none'}.`,
    }));

    const dependencies: ExtractedDependency[] = (parsed.dependencies || []).map((d) => ({
      id: `dep:${projectId}:${d.name}`,
      name: d.name,
      kind: d.kind,
      filePath: relPath,
    }));

    const tests: ExtractedTest[] = (parsed.tests || []).map((t) => ({
      id: `test:${projectId}:${relPath}:${t.name}:${t.startLine}`,
      name: t.name,
      filePath: relPath,
      startLine: t.startLine,
      endLine: t.endLine,
      calledSymbols: t.calls,
      summary: `Python test ${t.name} in ${relPath} (L${t.startLine}-L${t.endLine}) exercising: ${t.calls.slice(0, 8).join(', ') || 'module'}.`,
    }));

    return {
      id: `file:${projectId}:${relPath}`,
      path: relPath,
      language: 'python',
      contentHash,
      lineCount,
      sizeBytes,
      parserUsed: parsed.ok ? 'python3-ast' : 'static-metadata',
      functions,
      classes,
      dependencies,
      tests,
      findings: [],
    };
  } catch {
    return {
      id: `file:${projectId}:${relPath}`,
      path: relPath,
      language: 'python',
      contentHash,
      lineCount,
      sizeBytes,
      parserUsed: 'static-metadata',
      functions: [],
      classes: [],
      dependencies: [],
      tests: [],
      findings: [],
    };
  }
}

export async function extractSourceFile(
  projectId: string,
  rootDir: string,
  relPath: string
): Promise<ExtractedFileData> {
  if (
    !relPath ||
    relPath.includes('\0') ||
    path.isAbsolute(relPath) ||
    relPath.split(/[\\/]/).includes('..') ||
    isExcludedRepoPath(relPath)
  ) {
    throw new Error('Disallowed or excluded repository file path.');
  }
  const resolvedRoot = path.resolve(rootDir);
  const realRoot = await fs.realpath(resolvedRoot);
  const fullPath = path.resolve(resolvedRoot, relPath);
  if (!isPathStrictlyInside(resolvedRoot, fullPath)) {
    throw new Error('Path traversal rejected in extractSourceFile.');
  }
  const lstat = await fs.lstat(fullPath);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new Error('Symbolic links and non-regular files are excluded from extraction.');
  }
  if (lstat.size === 0 || lstat.size > 300_000) {
    throw new Error('Source file is empty or exceeds maximum extraction size.');
  }
  const realFile = await fs.realpath(fullPath);
  if (!isPathStrictlyInside(realRoot, realFile)) {
    throw new Error('Symlink containment check rejected file outside repository root.');
  }
  const ext = path.extname(relPath).toLowerCase();
  if (!SUPPORTED_SOURCE_EXTS.has(ext)) {
    throw new Error('Unsupported source file extension.');
  }
  const content = await fs.readFile(realFile, 'utf-8');
  const contentHash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex');

  if (ext === '.py') {
    return extractPythonFile(projectId, relPath, content, contentHash);
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return extractJsTsFile(projectId, relPath, content, contentHash);
  }

  return {
    id: `file:${projectId}:${relPath}`,
    path: relPath,
    language: detectLanguageFromFilename(relPath),
    contentHash,
    lineCount: content.split('\n').length,
    sizeBytes: Buffer.byteLength(content, 'utf-8'),
    parserUsed: 'static-metadata',
    functions: [],
    classes: [],
    dependencies: [],
    tests: [],
    findings: [],
  };
}
