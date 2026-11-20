import { parse, type Node as AcornNode } from 'acorn';
import { transform } from 'esbuild';
import type {
  AstFinding,
  AstReport,
  CallGraphEdge,
  FunctionMetric,
} from '../src/types/autopatch.ts';

interface AnyNode extends AcornNode {
  [key: string]: unknown;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

/**
 * Minimal VLQ source-map line decoder mapping 1-indexed generated JS line numbers
 * back to 1-indexed original TS/JS source line numbers.
 */
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_MAP = new Map<string, number>();
for (let i = 0; i < B64_CHARS.length; i++) B64_MAP.set(B64_CHARS[i], i);

function decodeVlqSegment(str: string, startIdx: number): [number[], number] {
  const values: number[] = [];
  let idx = startIdx;
  let value = 0;
  let shift = 0;

  while (idx < str.length) {
    const ch = str[idx];
    if (ch === ',' || ch === ';') break;
    const digit = B64_MAP.get(ch);
    if (digit === undefined) {
      idx++;
      continue;
    }
    const continuation = (digit & 32) !== 0;
    value += (digit & 31) << shift;
    idx++;
    if (continuation) {
      shift += 5;
    } else {
      const negate = (value & 1) === 1;
      const signed = value >> 1;
      values.push(negate ? -signed : signed);
      value = 0;
      shift = 0;
    }
  }
  return [values, idx];
}

function buildGeneratedToOriginalLineMap(sourceMapJson: string | undefined): Map<number, number> {
  const lineMap = new Map<number, number>();
  if (!sourceMapJson) return lineMap;
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
      const [fields, nextIdx] = decodeVlqSegment(mappings, idx);
      idx = nextIdx;
      if (fields.length >= 4) {
        origLine += fields[2];
        if (!lineMap.has(genLine)) {
          lineMap.set(genLine, origLine + 1);
        }
      }
    }
  } catch {
    // Fallback to identity mapping handled by caller
  }
  return lineMap;
}

function mapGenLine(genLine: number, lineMap: Map<number, number>, maxOrigLine: number): number {
  const mapped = lineMap.get(genLine) ?? genLine;
  return Math.max(1, Math.min(maxOrigLine, mapped));
}

function exprToText(node: AnyNode | null | undefined): string {
  if (!node) return '';
  switch (node.type) {
    case 'Identifier':
      return String(node.name || '');
    case 'MemberExpression': {
      const obj = exprToText(node.object as AnyNode);
      const prop = exprToText(node.property as AnyNode);
      return node.computed ? `${obj}[${prop}]` : `${obj}.${prop}`;
    }
    case 'CallExpression': {
      const callee = exprToText(node.callee as AnyNode);
      return `${callee}()`;
    }
    case 'Literal':
      return String(node.raw ?? node.value ?? '');
    default:
      return '';
  }
}

function walkAst(node: unknown, visitor: (n: AnyNode, ancestors: AnyNode[]) => void, ancestors: AnyNode[] = []): void {
  if (!node || typeof node !== 'object') return;
  const anyNode = node as AnyNode;
  if (typeof anyNode.type === 'string') {
    visitor(anyNode, ancestors);
    const nextAncestors = [...ancestors, anyNode];
    for (const [key, val] of Object.entries(anyNode)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && typeof (item as AnyNode).type === 'string') {
            walkAst(item, visitor, nextAncestors);
          }
        }
      } else if (val && typeof val === 'object' && typeof (val as AnyNode).type === 'string') {
        walkAst(val, visitor, nextAncestors);
      }
    }
  }
}

function isFunctionNode(node: AnyNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

function getFunctionName(node: AnyNode, parent: AnyNode | undefined): string {
  const id = node.id as AnyNode | null | undefined;
  if (id && id.type === 'Identifier' && typeof id.name === 'string') return id.name;
  if (parent?.type === 'VariableDeclarator' && (parent.id as AnyNode)?.type === 'Identifier') {
    return String((parent.id as AnyNode).name);
  }
  if (parent?.type === 'MethodDefinition' && (parent.key as AnyNode)?.type === 'Identifier') {
    return String((parent.key as AnyNode).name);
  }
  if (parent?.type === 'Property' && (parent.key as AnyNode)?.type === 'Identifier') {
    return String((parent.key as AnyNode).name);
  }
  return '<anonymous>';
}

function hasZeroGuardInNode(fnNode: AnyNode, denom: string): boolean {
  let guarded = false;
  walkAst(fnNode.body, (n) => {
    if (guarded) return;
    if (n.type === 'BinaryExpression') {
      const op = String(n.op ?? n.operator ?? '');
      const left = exprToText(n.left as AnyNode);
      const right = exprToText(n.right as AnyNode);
      if (
        ['===', '==', '!==', '!=', '<=', '<', '>', '>='].includes(op) &&
        ((left === denom && right === '0') || (right === denom && left === '0'))
      ) {
        guarded = true;
      }
    } else if (n.type === 'UnaryExpression' && n.operator === '!') {
      if (exprToText(n.argument as AnyNode) === denom) guarded = true;
    }
  });
  return guarded;
}

function loopBodyHasExit(body: AnyNode): boolean {
  let hasExit = false;
  walkAst(body, (n) => {
    if (
      n.type === 'BreakStatement' ||
      n.type === 'ReturnStatement' ||
      n.type === 'ThrowStatement'
    ) {
      hasExit = true;
    }
  });
  return hasExit;
}

function expressionContainsSqlKeyword(text: string): boolean {
  return /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(text);
}

function isNullGuardCondition(testNode: AnyNode, varName: string): boolean {
  let found = false;
  walkAst(testNode, (n) => {
    if (found) return;
    if (n.type === 'BinaryExpression') {
      const op = String(n.operator ?? '');
      const left = exprToText(n.left as AnyNode);
      const right = exprToText(n.right as AnyNode);
      if (
        ['!=', '!==', '==', '==='].includes(op) &&
        ((left === varName && (right === 'null' || right === 'undefined')) ||
          (right === varName && (left === 'null' || left === 'undefined')))
      ) {
        found = true;
      }
    } else if (n.type === 'UnaryExpression' && n.operator === '!' && exprToText(n.argument as AnyNode) === varName) {
      found = true;
    } else if (n.type === 'LogicalExpression' && n.operator === '&&') {
      if (exprToText(n.left as AnyNode) === varName) found = true;
    }
  });
  return found;
}

/**
 * Genuine JS/TS AST static analyzer using esbuild (TS/JSX type-stripping + syntax check)
 * and Acorn (full ESTree AST walk). Ignores comments and string literals completely.
 */
export async function analyzeJsTsAst(
  sourceCode: string,
  filename: string,
  language: 'javascript' | 'typescript'
): Promise<AstReport> {
  const t0 = performance.now();
  const origLines = sourceCode.split('\n');
  const maxOrigLine = Math.max(1, origLines.length);
  const findings: AstFinding[] = [];
  const functions: FunctionMetric[] = [];
  const callGraph: CallGraphEdge[] = [];

  let jsCode = sourceCode;
  let lineMap = new Map<number, number>();

  try {
    const res = await transform(sourceCode, {
      loader: language === 'typescript' ? 'ts' : 'js',
      format: 'esm',
      sourcefile: filename,
      sourcemap: 'external',
    });
    jsCode = res.code;
    lineMap = buildGeneratedToOriginalLineMap(res.map);
  } catch (err) {
    const errAny = err as { errors?: Array<{ text: string; location?: { line: number; column: number } }> };
    const first = errAny.errors?.[0];
    const line = first?.location?.line ?? 1;
    findings.push({
      id: `ast-syntax-${line}`,
      kind: 'SyntaxError',
      category: 'syntax',
      severity: 'error',
      line,
      col: first?.location?.column ?? 1,
      function: '<module>',
      message: first?.text || (err instanceof Error ? err.message : 'Syntax error'),
      snippet: (origLines[line - 1] || '').trim(),
    });
    return {
      syntaxValid: false,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      findings,
      functions,
      callGraph,
      analysisKind: 'ast-parser',
      parserTool: 'esbuild+acorn',
    };
  }

  let program: AnyNode;
  try {
    program = parse(jsCode, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    }) as unknown as AnyNode;
  } catch (err) {
    const errAny = err as { loc?: { line: number; column: number }; message?: string };
    const line = mapGenLine(errAny.loc?.line ?? 1, lineMap, maxOrigLine);
    findings.push({
      id: `ast-syntax-${line}`,
      kind: 'SyntaxError',
      category: 'syntax',
      severity: 'error',
      line,
      col: errAny.loc?.column ?? 1,
      function: '<module>',
      message: errAny.message || 'AST parse error',
      snippet: (origLines[line - 1] || '').trim(),
    });
    return {
      syntaxValid: false,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      findings,
      functions,
      callGraph,
      analysisKind: 'ast-parser',
      parserTool: 'esbuild+acorn',
    };
  }

  const seenFindingKeys = new Set<string>();
  const pushFinding = (f: AstFinding) => {
    const key = `${f.kind}:${f.line}:${f.variable || f.denominator || f.sink || ''}`;
    if (seenFindingKeys.has(key)) return;
    seenFindingKeys.add(key);
    findings.push(f);
  };

  // Track nullable variables initialized via .get() / .find() inside each function scope
  const findEnclosingFunction = (ancestors: AnyNode[]): { name: string; node: AnyNode | null } => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (isFunctionNode(ancestors[i])) {
        return {
          name: getFunctionName(ancestors[i], ancestors[i - 1]),
          node: ancestors[i],
        };
      }
    }
    return { name: '<module>', node: null };
  };

  walkAst(program, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    const fnCtx = findEnclosingFunction(ancestors);
    const origLine = mapGenLine(node.loc?.start.line ?? 1, lineMap, maxOrigLine);
    const snippet = (origLines[origLine - 1] || '').trim();

    // 1. Extract Function metrics + real McCabe cyclomatic complexity + call graph
    if (isFunctionNode(node)) {
      const fnName = getFunctionName(node, parent);
      if (fnName !== '<anonymous>') {
        let complexity = 1;
        const calls: string[] = [];
        walkAst(node.body, (inner) => {
          if (inner !== node && isFunctionNode(inner)) return;
          if (
            inner.type === 'IfStatement' ||
            inner.type === 'ForStatement' ||
            inner.type === 'ForInStatement' ||
            inner.type === 'ForOfStatement' ||
            inner.type === 'WhileStatement' ||
            inner.type === 'DoWhileStatement' ||
            inner.type === 'CatchClause' ||
            inner.type === 'ConditionalExpression' ||
            (inner.type === 'SwitchCase' && inner.test !== null) ||
            (inner.type === 'LogicalExpression' &&
              (inner.operator === '&&' || inner.operator === '||' || inner.operator === '??'))
          ) {
            complexity++;
          }
          if (inner.type === 'CallExpression') {
            const calleeName = exprToText(inner.callee as AnyNode);
            if (calleeName && calleeName !== fnName && !calls.includes(calleeName)) {
              calls.push(calleeName);
              callGraph.push({ caller: fnName, callee: calleeName });
            }
          }
        });
        functions.push({
          name: fnName,
          startLine: origLine,
          endLine: mapGenLine(node.loc?.end.line ?? origLine, lineMap, maxOrigLine),
          cyclomaticComplexity: complexity,
          calls: calls.slice(0, 8),
        });
      }

      // Check nullable .get()/.find() dereference within this function's block body
      const bodyNode = node.body as AnyNode | undefined;
      if (bodyNode?.type === 'BlockStatement' && Array.isArray(bodyNode.body)) {
        const nullableVars = new Set<string>();
        const guardedVars = new Set<string>();
        for (const stmt of bodyNode.body as AnyNode[]) {
          if (stmt.type === 'VariableDeclaration' && Array.isArray(stmt.declarations)) {
            for (const decl of stmt.declarations as AnyNode[]) {
              const id = decl.id as AnyNode | undefined;
              const init = decl.init as AnyNode | undefined;
              if (
                id?.type === 'Identifier' &&
                init?.type === 'CallExpression' &&
                (init.callee as AnyNode)?.type === 'MemberExpression'
              ) {
                const prop = exprToText((init.callee as AnyNode).property as AnyNode);
                if (prop === 'get' || prop === 'find') {
                  nullableVars.add(String(id.name));
                }
              }
            }
          } else if (stmt.type === 'IfStatement' && stmt.test) {
            const testNode = stmt.test as AnyNode;
            for (const v of nullableVars) {
              if (isNullGuardCondition(testNode, v)) {
                guardedVars.add(v);
                continue;
              }
              if (guardedVars.has(v)) continue;
              // Check if testNode dereferences v.prop or v[...] without optional chaining
              let derefsVar = false;
              walkAst(testNode, (inner, innerAnc) => {
                if (inner.type === 'MemberExpression' && !inner.optional) {
                  const chainParent = innerAnc[innerAnc.length - 1];
                  if (chainParent?.type === 'ChainExpression') return;
                  if (exprToText(inner.object as AnyNode) === v) {
                    derefsVar = true;
                  }
                }
              });
              if (derefsVar) {
                const derefLine = mapGenLine(stmt.loc?.start.line ?? origLine, lineMap, maxOrigLine);
                pushFinding({
                  id: `ast-null-${derefLine}-${v}`,
                  kind: 'NullDereferenceRisk',
                  category: 'runtime',
                  severity: 'error',
                  line: derefLine,
                  function: fnName,
                  variable: v,
                  message: `Nullable lookup variable '${v}' is dereferenced on line ${derefLine} without a null/undefined guard.`,
                  snippet: (origLines[derefLine - 1] || '').trim(),
                });
              }
            }
          }
        }
      }
    }

    // 2. Off-by-one loop boundary: for (...; i <= arr.length; ...)
    if (node.type === 'ForStatement' && node.test) {
      const test = node.test as AnyNode;
      if (test.type === 'BinaryExpression' && test.operator === '<=') {
        const rightText = exprToText(test.right as AnyNode);
        if (/(length|size\(\)|count|\blen\b)$/i.test(rightText)) {
          const loopLine = mapGenLine(test.loc?.start.line ?? origLine, lineMap, maxOrigLine);
          pushFinding({
            id: `ast-idx-${loopLine}`,
            kind: 'IndexBoundaryRisk',
            category: 'runtime',
            severity: 'error',
            line: loopLine,
            function: fnCtx.name,
            sequence: rightText,
            message: `Loop condition '<= ${rightText}' exceeds valid 0-based index bounds (0..len-1).`,
            snippet: (origLines[loopLine - 1] || '').trim(),
          });
        }
      }
    }

    // 3. Unprotected division by non-literal denominator
    if (node.type === 'BinaryExpression' && node.operator === '/') {
      const right = node.right as AnyNode;
      if (right.type === 'Identifier' || right.type === 'MemberExpression') {
        const denom = exprToText(right);
        if (denom && !/^(Math|Number|parseFloat|parseInt)$/.test(denom)) {
          const guarded = fnCtx.node ? hasZeroGuardInNode(fnCtx.node, denom) : false;
          if (!guarded) {
            pushFinding({
              id: `ast-div-${origLine}`,
              kind: 'ZeroDivisionRisk',
              category: 'runtime',
              severity: 'error',
              line: origLine,
              function: fnCtx.name,
              denominator: denom,
              message: `Unprotected division by '${denom}' without a zero-denominator guard.`,
              snippet,
            });
          }
        }
      }
    }

    // 4. Taint sinks: eval() and new Function()
    if (
      node.type === 'CallExpression' &&
      (node.callee as AnyNode)?.type === 'Identifier' &&
      (node.callee as AnyNode).name === 'eval'
    ) {
      pushFinding({
        id: `taint-eval-${origLine}`,
        kind: 'TaintInjectionRisk',
        category: 'security',
        severity: 'error',
        line: origLine,
        function: fnCtx.name,
        sink: 'eval',
        message: `Dynamic code execution sink 'eval()' detected via AST on line ${origLine}.`,
        snippet,
      });
    }
    if (
      node.type === 'NewExpression' &&
      (node.callee as AnyNode)?.type === 'Identifier' &&
      (node.callee as AnyNode).name === 'Function'
    ) {
      pushFinding({
        id: `taint-fn-${origLine}`,
        kind: 'TaintInjectionRisk',
        category: 'security',
        severity: 'error',
        line: origLine,
        function: fnCtx.name,
        sink: 'Function',
        message: `Dynamic code constructor 'new Function()' detected via AST on line ${origLine}.`,
        snippet,
      });
    }

    // 5. SQL injection in TemplateLiteral or BinaryExpression (+)
    if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length > 0) {
      const rawSql = ((node.quasis as AnyNode[]) || [])
        .map((q) => String((q.value as { raw?: string })?.raw || ''))
        .join(' ');
      if (expressionContainsSqlKeyword(rawSql)) {
        pushFinding({
          id: `taint-sql-${origLine}`,
          kind: 'SqlInjectionRisk',
          category: 'security',
          severity: 'error',
          line: origLine,
          function: fnCtx.name,
          sink: 'SQL template',
          message: `Template interpolation in SQL statement exposes SQL injection risk on line ${origLine}.`,
          snippet,
        });
      }
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = node.left as AnyNode;
      const right = node.right as AnyNode;
      if (
        left.type === 'Literal' &&
        typeof left.value === 'string' &&
        expressionContainsSqlKeyword(left.value) &&
        right.type !== 'Literal'
      ) {
        pushFinding({
          id: `taint-sql-${origLine}`,
          kind: 'SqlInjectionRisk',
          category: 'security',
          severity: 'error',
          line: origLine,
          function: fnCtx.name,
          sink: 'SQL concatenation',
          message: `Dynamic string concatenation in SQL query exposes SQL injection risk on line ${origLine}.`,
          snippet,
        });
      }
    }

    // 6. Infinite loop without reachable break/return/throw
    if (
      (node.type === 'WhileStatement' &&
        (node.test as AnyNode)?.type === 'Literal' &&
        Boolean((node.test as AnyNode).value) === true) ||
      (node.type === 'ForStatement' && node.test === null)
    ) {
      if (node.body && !loopBodyHasExit(node.body as AnyNode)) {
        pushFinding({
          id: `cfg-loop-${origLine}`,
          kind: 'InfiniteLoopRisk',
          category: 'cfg',
          severity: 'error',
          line: origLine,
          function: fnCtx.name,
          message: `Unbounded loop on line ${origLine} has no reachable break, return, or throw exit.`,
          snippet,
        });
      }
    }

    // 7. Unreachable dead code immediately after return/throw in a BlockStatement
    if (node.type === 'BlockStatement' && Array.isArray(node.body)) {
      const stmts = node.body as AnyNode[];
      for (let i = 0; i < stmts.length - 1; i++) {
        if (stmts[i].type === 'ReturnStatement' || stmts[i].type === 'ThrowStatement') {
          const deadStmt = stmts[i + 1];
          // Hoisted FunctionDeclaration after return is technically reachable in JS
          if (deadStmt.type === 'FunctionDeclaration') continue;
          const deadLine = mapGenLine(deadStmt.loc?.start.line ?? origLine, lineMap, maxOrigLine);
          pushFinding({
            id: `cfg-dead-${deadLine}`,
            kind: 'DeadCodeRisk',
            category: 'cfg',
            severity: 'warning',
            line: deadLine,
            function: fnCtx.name,
            message: `Unreachable statement on line ${deadLine} follows an unconditional ${stmts[i].type === 'ReturnStatement' ? 'return' : 'throw'}.`,
            snippet: (origLines[deadLine - 1] || '').trim(),
          });
          break;
        }
      }
    }

    // 8. Hardcoded secret literal in VariableDeclarator or Object Property
    if (node.type === 'VariableDeclarator') {
      const id = node.id as AnyNode;
      const init = node.init as AnyNode | null;
      if (
        id?.type === 'Identifier' &&
        /(password|api_key|apiKey|secret|token)/i.test(String(id.name)) &&
        init?.type === 'Literal' &&
        typeof init.value === 'string' &&
        init.value.length >= 6
      ) {
        pushFinding({
          id: `taint-secret-${origLine}`,
          kind: 'HardcodedSecretRisk',
          category: 'security',
          severity: 'warning',
          line: origLine,
          function: fnCtx.name,
          message: `Potential hardcoded secret literal assigned to '${id.name}' on line ${origLine}.`,
          snippet,
        });
      }
    }
  });

  return {
    syntaxValid: true,
    durationMs: Number((performance.now() - t0).toFixed(2)),
    findings,
    functions,
    callGraph,
    analysisKind: 'ast-parser',
    parserTool: 'esbuild+acorn',
  };
}

/**
 * Genuine AST-based statement instrumentation for JS/TS SBFL coverage.
 * Transpiles TS/JS with esbuild + source map, parses compiled JS with Acorn,
 * and injects `globalThis.__AP_HIT__(origLine);` before every executable statement
 * inside function/block bodies, mapping back to 1-indexed original source lines.
 */
export async function instrumentJsTsForSbfl(
  sourceCode: string,
  filename: string,
  language: 'javascript' | 'typescript'
): Promise<{
  code: string;
  instrumented: boolean;
  lineMap: Map<number, number>;
}> {
  const maxOrigLine = Math.max(1, sourceCode.split('\n').length);
  const transformed = await transform(sourceCode, {
    loader: language === 'typescript' ? 'ts' : 'js',
    format: 'esm',
    sourcefile: filename,
    sourcemap: 'external',
  });
  const jsCode = transformed.code;
  const lineMap = buildGeneratedToOriginalLineMap(transformed.map);

  const hookHeader =
    `globalThis.__AP_HIT__ = globalThis.__AP_HIT__ || ((ln) => { if (globalThis.__AP_SET__) globalThis.__AP_SET__.add(ln); });\n`;

  try {
    const program = parse(jsCode, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    }) as unknown as AnyNode;

    interface Edit {
      pos: number;
      insert: string;
    }
    const edits: Edit[] = [];

    const PROBEABLE_TYPES = new Set([
      'ExpressionStatement',
      'ReturnStatement',
      'VariableDeclaration',
      'IfStatement',
      'ForStatement',
      'ForInStatement',
      'ForOfStatement',
      'WhileStatement',
      'DoWhileStatement',
      'ThrowStatement',
      'SwitchStatement',
      'TryStatement',
    ]);

    const collectBlockProbes = (stmts: AnyNode[], insideFunction: boolean) => {
      for (const stmt of stmts) {
        if (insideFunction && PROBEABLE_TYPES.has(stmt.type) && typeof stmt.start === 'number') {
          const origLine = mapGenLine(stmt.loc?.start.line ?? 1, lineMap, maxOrigLine);
          edits.push({ pos: stmt.start, insert: `globalThis.__AP_HIT__(${origLine});` });
        }
      }
    };

    walkAst(program, (node, ancestors) => {
      const insideFunction = ancestors.some((a) => isFunctionNode(a));
      if (node.type === 'BlockStatement' && Array.isArray(node.body)) {
        collectBlockProbes(node.body as AnyNode[], insideFunction || isFunctionNode(ancestors[ancestors.length - 1] || ({} as AnyNode)));
      }
    });

    // Apply edits from back to front so offsets stay exact
    edits.sort((a, b) => b.pos - a.pos);
    let instrumentedCode = jsCode;
    const seenPos = new Set<number>();
    for (const edit of edits) {
      if (seenPos.has(edit.pos)) continue;
      seenPos.add(edit.pos);
      instrumentedCode =
        instrumentedCode.slice(0, edit.pos) + edit.insert + instrumentedCode.slice(edit.pos);
    }

    // Verify instrumented JS parses cleanly before using it
    parse(instrumentedCode, { ecmaVersion: 'latest', sourceType: 'module' });
    return {
      code: hookHeader + instrumentedCode,
      instrumented: edits.length > 0,
      lineMap,
    };
  } catch {
    return {
      code: hookHeader + jsCode,
      instrumented: false,
      lineMap,
    };
  }
}
