import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPatchToCode,
  buildBatchMarkdownExport,
  computeBatchSummary,
  computeTestSummary,
  createHistoryEntry,
  findErroredLineIndices,
  getAdjacentBugId,
  mergeAutoPatchReports,
  normalizeAutoPatchSeverity,
  normalizeGeminiReport,
  pairSourceAndTestFiles,
  sortAutoPatchBugs,
  validateSubmissionInput,
} from './autopatchWorkflow.ts';
import type { AutoPatchBug, BatchFileResult } from '../types/autopatch.ts';

const SAMPLE_BUG: AutoPatchBug = {
  id: 'bug-zero-div',
  title: 'Unchecked division by zero on empty cart',
  severity: 'Critical',
  confidence: 96,
  errored_statement: 'return round(total_revenue / total_units, 2)',
  root_cause:
    'When items is empty ([]), total_units evaluates to 0, raising ZeroDivisionError.',
  before_code: '    return round(total_revenue / total_units, 2)',
  after_code:
    '    if total_units <= 0:\n        return 0.0\n    return round(total_revenue / total_units, 2)',
  test_cases: [
    { input: 'items=[]', expected_output: '0.0', status: 'fail', case_type: 'boundary' },
    {
      input: 'items=[{"price": 20, "qty": 2}]',
      expected_output: '20.0',
      status: 'pass',
      case_type: 'normal',
    },
  ],
};

test('validateSubmissionInput rejects blank and overly short input', () => {
  assert.equal(validateSubmissionInput('').valid, false);
  assert.equal(validateSubmissionInput('   ').valid, false);
  assert.equal(validateSubmissionInput('x = 1').valid, false);
  assert.equal(validateSubmissionInput('def f(x): return 1 / x').valid, true);
});

test('normalizeAutoPatchSeverity handles casing and unknown values', () => {
  assert.equal(normalizeAutoPatchSeverity('critical'), 'Critical');
  assert.equal(normalizeAutoPatchSeverity('HIGH'), 'High');
  assert.equal(normalizeAutoPatchSeverity('low'), 'Low');
  assert.equal(normalizeAutoPatchSeverity('unknown'), 'Medium');
});

test('normalizeGeminiReport ranks bugs by severity then confidence and preserves case_type', () => {
  const report = normalizeGeminiReport({
    bugs: [
      {
        id: 'b-low',
        title: 'Minor style',
        severity: 'low',
        confidence: 99,
        errored_statement: 'x = 1',
        root_cause: 'unused var',
        before_code: 'x = 1',
        after_code: '',
        test_cases: [{ case_type: 'normal', input: 'a=1', expected_output: '1', status: 'pass' }],
      },
      {
        id: 'b-high-70',
        title: 'Lower conf high',
        severity: 'high',
        confidence: 70,
        errored_statement: 'y = 2',
        root_cause: 'fails on None',
        before_code: 'y = 2',
        after_code: 'y = 2',
        test_cases: [{ case_type: 'invalid', input: 'None', expected_output: 'error', status: 'fail' }],
      },
      {
        id: 'b-crit',
        title: 'SQL Injection',
        severity: 'critical',
        confidence: 95,
        errored_statement: 'cursor.execute(q)',
        root_cause: 'unsanitized input',
        before_code: 'cursor.execute(q)',
        after_code: 'cursor.execute(q, (u,))',
        test_cases: [{ case_type: 'boundary', input: "' OR 1=1 --", expected_output: '[]', status: 'fail' }],
      },
      {
        id: 'b-high-92',
        title: 'Null subscript',
        severity: 'high',
        confidence: 145,
        errored_statement: 'if user["password"] == password:',
        root_cause: 'user can be None',
        before_code: 'if user["password"] == password:',
        after_code: 'if user and user["password"] == password:',
        test_cases: [{ case_type: 'invalid', input: 'unknown user', expected_output: 'INVALID', status: 'fail' }],
      },
    ],
    summary: {
      health_score: -10,
      overview: 'Four issues found.',
      prioritized_actions: ['Fix SQL injection first'],
    },
  });

  assert.deepEqual(
    report.bugs.map((b) => b.id),
    ['b-crit', 'b-high-92', 'b-high-70', 'b-low']
  );
  assert.equal(report.bugs[1].severity, 'High');
  assert.equal(report.bugs[1].confidence, 100);
  assert.equal(report.bugs[0].test_cases[0].case_type, 'boundary');
  assert.equal(report.bugs[1].test_cases[0].case_type, 'invalid');
  assert.equal(report.summary.health_score, 0);
  assert.equal(report.execution_source, 'gemini');
});

test('sortAutoPatchBugs keeps order deterministic across equal severities', () => {
  const sorted = sortAutoPatchBugs([
    { ...SAMPLE_BUG, id: 'med', severity: 'Medium', confidence: 95 },
    { ...SAMPLE_BUG, id: 'crit-80', severity: 'Critical', confidence: 80 },
    { ...SAMPLE_BUG, id: 'crit-98', severity: 'Critical', confidence: 98 },
  ]);
  assert.deepEqual(
    sorted.map((b) => b.id),
    ['crit-98', 'crit-80', 'med']
  );
});

test('applyPatchToCode applies exact before_code replacement cleanly', () => {
  const original = [
    'def calc(items):',
    '    total_revenue = sum(i["p"] for i in items)',
    '    total_units = sum(i["q"] for i in items)',
    '    return round(total_revenue / total_units, 2)',
  ].join('\n');

  const { updatedCode, applied } = applyPatchToCode(original, SAMPLE_BUG);
  assert.equal(applied, true);
  assert.ok(updatedCode.includes('if total_units <= 0:'));
  assert.ok(updatedCode.includes('return 0.0'));
});

test('findErroredLineIndices locates errored statement line numbers', () => {
  const code = [
    'def calc(items):',
    '    total_units = 0',
    '    return round(total_revenue / total_units, 2)',
  ].join('\n');
  const lines = findErroredLineIndices(code, SAMPLE_BUG.errored_statement);
  assert.equal(lines.has(3), true);
  assert.equal(lines.has(1), false);
});

test('computeTestSummary reflects accepted patch recovery', () => {
  const before = computeTestSummary([SAMPLE_BUG], {});
  assert.equal(before.passed, 1);
  assert.equal(before.failed, 1);
  assert.equal(before.total, 2);

  const afterAccept = computeTestSummary([SAMPLE_BUG], { [SAMPLE_BUG.id]: 'Accepted' });
  assert.equal(afterAccept.passed, 2);
  assert.equal(afterAccept.failed, 0);
});

test('createHistoryEntry and getAdjacentBugId work deterministically', () => {
  const entry = createHistoryEntry({
    bug: SAMPLE_BUG,
    decision: 'Accepted',
    filename: 'pricing.py',
    executionSource: 'gemini',
    timestamp: '2026-11-19T00:00:00.000Z',
  });
  assert.equal(entry.decision, 'Accepted');
  assert.equal(entry.severity, 'Critical');

  const bugs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(getAdjacentBugId(bugs, 'a', 'next'), 'b');
  assert.equal(getAdjacentBugId(bugs, 'c', 'next'), 'a');
  assert.equal(getAdjacentBugId(bugs, 'a', 'prev'), 'c');
});

test('pairSourceAndTestFiles pairs matching test suites and keeps unmatched files standalone', () => {
  const paired = pairSourceAndTestFiles([
    { name: 'src/calculator.py', content: 'def add(a, b): return a + b' },
    { name: 'tests/test_calculator.py', content: 'from calculator import add\nassert add(1, 2) == 3' },
    { name: 'billing.ts', content: 'export const fee = (x: number) => x * 1.1;' },
    { name: 'billing.test.ts', content: 'console.assert(fee(10) === 11);' },
    { name: 'standalone_test.js', content: 'console.assert(true);' },
  ]);

  assert.equal(paired.length, 3);
  assert.equal(paired[0].filename, 'calculator.py');
  assert.equal(paired[0].testFilename, 'test_calculator.py');
  assert.ok(paired[0].testCode.includes('assert add(1, 2) == 3'));

  assert.equal(paired[1].filename, 'billing.ts');
  assert.equal(paired[1].testFilename, 'billing.test.ts');
  assert.ok(paired[1].testCode.includes('console.assert'));

  assert.equal(paired[2].filename, 'standalone_test.js');
  assert.equal(paired[2].testCode, '');
});

test('normalizeGeminiReport preserves all prioritized actions beyond old 3-item cap', () => {
  const manyBugs = Array.from({ length: 8 }, (_, idx) => ({
    id: `bug-${idx + 1}`,
    title: `Defect #${idx + 1}`,
    severity: 'medium',
    confidence: 90 - idx,
    errored_statement: `line_${idx + 1}()`,
    root_cause: 'Missing guard',
    before_code: `line_${idx + 1}()`,
    after_code: `safe_${idx + 1}()`,
    test_cases: [],
  }));

  const report = normalizeGeminiReport({ bugs: manyBugs });
  assert.equal(report.bugs.length, 8);
  assert.equal(report.summary.prioritized_actions.length, 8);
});

test('computeBatchSummary and buildBatchMarkdownExport summarize multiple files accurately', () => {
  const report1 = normalizeGeminiReport({
    bugs: [SAMPLE_BUG],
    summary: { health_score: 60, overview: 'Division issue found.' },
  });
  const report2 = normalizeGeminiReport({
    bugs: [],
    summary: { health_score: 98, overview: 'Clean module.' },
  });

  const results: BatchFileResult[] = [
    {
      fileId: 'f1',
      filename: 'pricing.py',
      status: 'completed',
      currentStage: 5,
      report: report1,
      decisions: { [SAMPLE_BUG.id]: 'Accepted' },
      errorMessage: null,
      errorCode: null,
    },
    {
      fileId: 'f2',
      filename: 'helpers.py',
      status: 'completed',
      currentStage: 5,
      report: report2,
      decisions: {},
      errorMessage: null,
      errorCode: null,
    },
  ];

  const summary = computeBatchSummary(results);
  assert.equal(summary.totalFiles, 2);
  assert.equal(summary.completedFiles, 2);
  assert.equal(summary.totalBugs, 1);
  assert.equal(summary.acceptedPatches, 1);
  assert.equal(summary.averageHealthScore, 99);

  const md = buildBatchMarkdownExport(results);
  assert.ok(md.includes('## pricing.py'));
  assert.ok(md.includes('## helpers.py'));
  assert.ok(md.includes('Total Bugs Detected:** 1'));
});

test('mergeAutoPatchReports combines unique bugs without duplicating matching statements or titles', () => {
  const aiReport = normalizeGeminiReport({
    bugs: [
      {
        id: 'ai-sqli',
        title: 'SQL Injection via f-string query',
        severity: 'critical',
        confidence: 97,
        errored_statement: 'cursor.execute(f"SELECT * FROM users WHERE name = \'{username}\'")',
        root_cause: 'Unsanitized SQL interpolation.',
        before_code: 'cursor.execute(f"SELECT * FROM users WHERE name = \'{username}\'")',
        after_code: 'cursor.execute("SELECT * FROM users WHERE name = ?", (username,))',
        test_cases: [],
      },
    ],
    summary: {
      health_score: 72,
      overview: 'AI detected SQL injection.',
      prioritized_actions: ['[Critical] SQL Injection via f-string query'],
    },
    trace_logs: ['AI semantic pass finished.'],
  });

  const sandboxReport = {
    ...normalizeGeminiReport({
      bugs: [
        {
          id: 'det-dup',
          title: 'Duplicate SQLi match',
          severity: 'high',
          confidence: 90,
          errored_statement: 'cursor.execute(f"SELECT * FROM users WHERE name = \'{username}\'")',
          root_cause: 'Detected via taint analysis.',
          before_code: 'cursor.execute(f"SELECT * FROM users WHERE name = \'{username}\'")',
          after_code: '',
          test_cases: [],
        },
        {
          id: 'det-div0',
          title: 'Unchecked division by zero on empty cart',
          severity: 'critical',
          confidence: 95,
          errored_statement: 'return round(total_revenue / total_units, 2)',
          root_cause: 'Denominator can be zero.',
          before_code: 'return round(total_revenue / total_units, 2)',
          after_code: 'if total_units <= 0: return 0.0\nreturn round(total_revenue / total_units, 2)',
          test_cases: [],
        },
      ],
      summary: {
        health_score: 45,
        overview: 'Sandbox found division by zero.',
        prioritized_actions: ['[Critical] Unchecked division by zero on empty cart'],
      },
      trace_logs: ['Sandbox baseline executed.'],
    }),
    execution_source: 'local-sandbox' as const,
  };

  const merged = mergeAutoPatchReports(aiReport, sandboxReport);
  assert.equal(merged.bugs.length, 2);
  assert.ok(merged.bugs.some((b) => b.id === 'ai-sqli'));
  assert.ok(merged.bugs.some((b) => b.id === 'det-div0'));
  assert.equal(merged.summary.health_score, 45);
  assert.equal(merged.trace_logs.length, 2);
  assert.ok(
    merged.summary.prioritized_actions.includes(
      '[Critical] Unchecked division by zero on empty cart'
    )
  );
});


