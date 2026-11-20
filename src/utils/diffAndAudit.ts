import type {
  AnalysisResponse,
  AuditDecision,
  AuditEntry,
  Eli10Explanation,
  TrustVerdict,
  VoiceNote,
} from '../types/autopatch';

export interface TrustGateState {
  canAcceptDirectly: boolean;
  requiresOverride: boolean;
  canAcceptNow: boolean;
  reason: string;
}

/**
 * Pure trust-gate evaluation for the "Build for Trust" decision bar.
 * Never allows direct acceptance when sandbox validation is blocked.
 */
export function evaluateTrustGate(params: {
  verdict: TrustVerdict;
  overrideEnabled: boolean;
  overrideReason: string;
}): TrustGateState {
  const { verdict, overrideEnabled, overrideReason } = params;

  if (verdict === 'verified') {
    return {
      canAcceptDirectly: true,
      requiresOverride: false,
      canAcceptNow: true,
      reason: 'All sandbox unit tests passed with zero regressions.',
    };
  }

  if (verdict === 'already_passing') {
    return {
      canAcceptDirectly: false,
      requiresOverride: false,
      canAcceptNow: false,
      reason: 'Baseline suite already passes; no patch required.',
    };
  }

  const trimmedReason = overrideReason.trim();
  const canOverride = overrideEnabled && trimmedReason.length >= 8;

  return {
    canAcceptDirectly: false,
    requiresOverride: true,
    canAcceptNow: canOverride,
    reason: canOverride
      ? 'Human override armed with logged justification.'
      : 'Blocked by sandbox validation. Enable Human Override and provide a justification (min 8 chars) or edit the patch and re-verify.',
  };
}

/**
 * Generates a vivid, zero-jargon "Explain Like I'm 10" story for live hackathon stage demos.
 */
export function buildEli10Explanation(params: {
  bugType: string;
  targetLine?: number | null;
  filename: string;
  rootCause?: string;
  strategy?: string;
}): Eli10Explanation {
  const kind = (params.bugType || 'Defect').toLowerCase();
  const lineLabel = params.targetLine ? `line ${params.targetLine}` : 'this file';

  if (kind.includes('zerodivision')) {
    return {
      title: 'Sharing Cookies Among Zero Friends',
      analogy:
        'Imagine trying to split a plate of 10 cookies equally among 0 people sitting at a table. Your calculator freezes because there is nobody there to receive a cookie!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, the code divided a number by zero when an empty list or zero count arrived.`,
      howWeFixedIt:
        'We placed a friendly bouncer right before the math: if the count is 0, it immediately answers 0 without dividing.',
    };
  }

  if (kind.includes('null') || kind.includes('typeerror') || kind.includes('attributeerror')) {
    return {
      title: 'The Empty School Locker Trap',
      analogy:
        'Imagine asking the school office for locker #99. Because nobody owns locker #99, they hand you an empty sticky note ("None"). Then you try to unlock the sticky note with a metal key!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, the code looked up a record that didn't exist (getting back empty "None/null") and tried to read data inside it anyway.`,
      howWeFixedIt:
        'We taught the code to check if the locker actually exists first ("is not None") before trying to open it.',
    };
  }

  if (kind.includes('keyerror')) {
    return {
      title: 'Opening a Folder That Is Not in the Cabinet',
      analogy:
        'Imagine reaching into a filing cabinet to replace a page inside "Bob\'s Folder" without checking if Bob even has a folder yet — papers fly everywhere!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, the code tried to update or read a dictionary key before checking if that key was inside the database.`,
      howWeFixedIt:
        'We added a quick check at the cabinet door: if the name is not in the database, safely stop and return False.',
    };
  }

  if (kind.includes('index') || kind.includes('bound')) {
    return {
      title: 'Stepping One Plank Past the End of the Pier',
      analogy:
        'Imagine a wooden pier with 5 planks numbered 0, 1, 2, 3, and 4. The code told a robot to walk 6 steps onto plank #5 — splash right into the water!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, the loop counted one step too far (using "<=" or "+ 1" past the end of the list).`,
      howWeFixedIt:
        'We shortened the walk by 1 step so the loop always stops safely on the very last real item.',
    };
  }

  if (kind.includes('sql') || kind.includes('taint') || kind.includes('command')) {
    return {
      title: 'The Fake Hall-Pass Trick',
      analogy:
        'Imagine a school guard who reads a visitor\'s nametag out loud as an order. A sneaky visitor writes "Bob — AND UNLOCK THE VAULT" on their nametag, and the guard obeys it!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, untrusted user text was glued directly into a database or system command.`,
      howWeFixedIt:
        'We locked the user input inside a sealed ID badge (a parameterized "?" placeholder / safe parser) so it is treated strictly as data, never as a command.',
    };
  }

  if (kind.includes('unboundedquery') || kind.includes('database') || kind.includes('nplusone')) {
    return {
      title: 'The 10-Million-Pizza Dump Truck',
      analogy:
        'Imagine ordering dinner from a mega-warehouse, and instead of sending 1 box, they dump all 10 million frozen pizzas onto your porch at once — crushing the house!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, the database query asked for every single row in a massive table with no row limit or batching.`,
      howWeFixedIt:
        'We attached a safety valve (LIMIT / batched query guard) so the database sends a safe, fast page of records instead of crashing memory.',
    };
  }

  if (kind.includes('mutabledefault')) {
    return {
      title: 'The Shared Cereal Bowl',
      analogy:
        'Imagine a diner that gives every new customer the exact same cereal bowl without washing it — customer #2 finds customer #1\'s leftover Cheerios floating in their milk!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, a Python function used a shared list or dictionary "[]" as a default argument across every call.`,
      howWeFixedIt:
        'We changed the default to "None" and hand out a brand-new, clean list inside the function every time someone calls it.',
    };
  }

  if (kind.includes('loop') || kind.includes('timeout')) {
    return {
      title: 'The Hamster Wheel With No Exit Door',
      analogy:
        'Imagine a mail sorter who puts any package with a smudged label right back onto the front of the conveyor belt forever — the belt never stops spinning!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, a loop kept repeating without a counter or exit rule, hitting our 2-second safety timer.`,
      howWeFixedIt:
        'Our Trust Gate caught the runaway wheel in 2 seconds and paused auto-overwrite so you can choose whether bad items should be skipped or capped.',
    };
  }

  if (kind.includes('logic') || kind.includes('assertion') || kind.includes('mutation')) {
    return {
      title: 'The Rollercoaster Height Sign (> vs >=)',
      analogy:
        'Imagine a rollercoaster sign that says "Must be OVER 100cm to ride", accidentally turning away kids who are EXACTLY 100cm tall!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, a comparison sign missed the exact boundary number.`,
      howWeFixedIt:
        'We tested small comparison flips in our sandbox and swapped the sign so the exact boundary value is included.',
    };
  }

  if (kind.includes('syntax') || kind.includes('compile')) {
    return {
      title: 'The Missing Period at the End of a Sentence',
      analogy:
        'Imagine handing a recipe to a chef where a sentence stops mid-air without a colon or closing bracket — the chef pauses before even turning on the stove!',
      whatWentWrong: `On ${lineLabel} of ${params.filename}, a required punctuation mark (colon, parenthesis, or semicolon) was missing or mistyped.`,
      howWeFixedIt:
        'We put the missing punctuation mark right back where the language grammar expects it.',
    };
  }

  if (kind === 'none') {
    return {
      title: 'All Green Lights on the Track',
      analogy:
        'Like a race car passing every pit-stop inspection on the first try — nothing is loose or broken.',
      whatWentWrong: 'Nothing went wrong! All static inspections and sandbox tests passed.',
      howWeFixedIt: 'No code changes were needed.',
    };
  }

  return {
    title: 'The Loose Lego Brick on the Bridge',
    analogy:
      'Imagine building a Lego bridge where one brick on the support pillar is snapped in sideways — the bridge wobbles as soon as a toy train crosses it!',
    whatWentWrong:
      params.rootCause || `On ${lineLabel} of ${params.filename}, an unguarded edge-case input caused the function to fail.`,
    howWeFixedIt:
      params.strategy || 'We snapped a defensive guard around the broken line and verified that every test train crosses safely.',
  };
}

/**
 * Builds a structured audit ledger entry from an analysis run and developer decision.
 */
export function buildAuditEntry(params: {
  analysis: AnalysisResponse;
  decision: AuditDecision;
  overrideReason?: string;
  voiceNotes?: VoiceNote[];
  now?: Date;
}): AuditEntry {
  const { analysis, decision, overrideReason, voiceNotes = [], now = new Date() } = params;
  const trimmedTranscripts = voiceNotes
    .map((n) => n.transcript.trim())
    .filter(Boolean);
  const voiceNotesSummary =
    trimmedTranscripts.length > 0
      ? trimmedTranscripts.join(' | ').slice(0, 200)
      : undefined;

  return {
    id: `aud-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.toISOString(),
    filename: analysis.filename,
    line: analysis.patchInfo.targetLine ?? analysis.baseline.errorLine ?? null,
    bugType: analysis.patchInfo.bugType,
    ruleId: analysis.patchInfo.ruleId,
    confidence: analysis.confidence.score,
    baselinePassed: analysis.baseline.passed,
    baselineTotal: analysis.baseline.total,
    sandboxPassed: analysis.sandbox.passed,
    sandboxTotal: analysis.sandbox.total,
    sandboxVerdict: analysis.trustVerdict,
    decision,
    summary: analysis.patchInfo.strategy,
    overrideReason: overrideReason?.trim() || undefined,
    linesAdded: analysis.diff.linesAdded,
    linesRemoved: analysis.diff.linesRemoved,
    voiceNoteCount: voiceNotes.length > 0 ? voiceNotes.length : undefined,
    voiceNotesSummary,
  };
}

export type AuditFilter = 'all' | AuditDecision;

/**
 * Filters audit ledger records by status and free-text query across file, bug type, rule, and summary.
 */
export function filterAuditEntries(
  entries: AuditEntry[],
  filter: AuditFilter,
  query: string
): AuditEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter !== 'all' && entry.decision !== filter) {
      return false;
    }
    if (!q) return true;
    const haystack = [
      entry.filename,
      entry.bugType,
      entry.ruleId,
      entry.summary,
      entry.overrideReason ?? '',
      entry.voiceNotesSummary ?? '',
      entry.line != null ? `line ${entry.line}` : '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serializes audit entries into RFC-4180 compliant CSV for compliance export.
 */
export function serializeAuditToCsv(entries: AuditEntry[]): string {
  const headers = [
    'ID',
    'Timestamp',
    'File',
    'Line',
    'Bug Type',
    'Rule',
    'Confidence (%)',
    'Baseline Tests',
    'Sandbox Tests',
    'Sandbox Verdict',
    'Decision',
    'Lines Added',
    'Lines Removed',
    'Summary',
    'Override Justification',
    'Voice Notes',
  ];

  const rows = entries.map((e) =>
    [
      e.id,
      e.timestamp,
      e.filename,
      e.line ?? '',
      e.bugType,
      e.ruleId,
      e.confidence,
      `${e.baselinePassed}/${e.baselineTotal}`,
      `${e.sandboxPassed}/${e.sandboxTotal}`,
      e.sandboxVerdict,
      e.decision,
      e.linesAdded,
      e.linesRemoved,
      e.summary,
      e.overrideReason ?? '',
      e.voiceNotesSummary ?? (e.voiceNoteCount ? `${e.voiceNoteCount} audio note(s)` : ''),
    ]
      .map(escapeCsvCell)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Formats an ISO timestamp into a concise tabular-friendly display string.
 */
export function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Generates the 5-section structured AutoPatch Engine Markdown Report:
 * ### 1. BUG SUMMARY & TRIAGE
 * ### 2. ROOT-CAUSE ANALYSIS
 * ### 3. MINIMAL SURGICAL PATCH (UNIFIED DIFF)
 * ### 4. REGRESSION & EDGE-CASE TEST SUITE
 * ### 5. AUDIT LOG ENTRY
 */
export function formatStructuredMarkdownReport(
  analysis: AnalysisResponse,
  testCode: string,
  decision: AuditDecision | null = null,
  voiceNotes: VoiceNote[] = []
): string {
  const lineTarget =
    analysis.patchInfo.targetLine ??
    analysis.baseline.errorLine ??
    analysis.astReport.findings[0]?.line ??
    1;

  const hasErrorFinding = analysis.astReport.findings.some((f) => f.severity === 'error');
  const severity =
    analysis.trustVerdict === 'already_passing'
      ? 'Low'
      : analysis.patchInfo.bugType.includes('Injection') ||
        analysis.patchInfo.bugType.includes('Timeout') ||
        analysis.patchInfo.bugType.includes('TypeError') ||
        analysis.patchInfo.bugType.includes('ZeroDivision')
      ? 'High'
      : hasErrorFinding
      ? 'High'
      : 'Medium';

  const unifiedDiff =
    analysis.diff.unified.trim() ||
    `--- a/${analysis.filename}\n+++ b/${analysis.filename}\n@@ -1,1 +1,1 @@\n (no textual diff required)`;

  const verdictLabel =
    decision === 'accepted'
      ? 'ACCEPTED (SANDBOX VERIFIED)'
      : decision === 'override'
      ? 'ACCEPTED (HUMAN OVERRIDE)'
      : decision === 'rejected'
      ? 'REJECTED'
      : analysis.trustVerdict === 'verified'
      ? 'SANDBOX VERIFIED (READY FOR APPROVAL)'
      : analysis.trustVerdict === 'already_passing'
      ? 'BASELINE ALREADY PASSING'
      : 'BLOCKED (HUMAN REVIEW REQUIRED)';

  const story =
    analysis.eli10 ??
    buildEli10Explanation({
      bugType: analysis.patchInfo.bugType,
      targetLine: lineTarget,
      filename: analysis.filename,
      rootCause: analysis.patchInfo.rootCause,
      strategy: analysis.patchInfo.strategy,
    });

  const voiceNotesLines =
    voiceNotes.length > 0
      ? [
          '',
          '#### Developer Voice Notes',
          ...voiceNotes.map(
            (n) =>
              `- **Line ${n.line} (${n.bugTitle})**: ${
                n.transcript.trim() || '(audio note attached)'
              }`
          ),
        ]
      : [];

  return [
    '### 1. BUG SUMMARY & TRIAGE',
    `- **Target Component**: \`${analysis.filename}\` (Line ${lineTarget})`,
    `- **Bug Category**: \`${analysis.patchInfo.bugType}\` (\`${analysis.patchInfo.ruleId}\`)`,
    `- **Severity**: **${severity}**`,
    `- **Confidence Score**: **${analysis.confidence.score}%** (${analysis.patchInfo.aprStrategy || 'Template-Based APR'})`,
    `- **Sandbox Validation**: **${analysis.sandbox.passed}/${analysis.sandbox.total} tests passed** (Baseline: ${analysis.baseline.passed}/${analysis.baseline.total} passed)`,
    '',
    '### 2. ROOT-CAUSE ANALYSIS',
    `- **Technical Diagnosis**: ${analysis.patchInfo.rootCause}`,
    `- **Repair Strategy**: ${analysis.patchInfo.strategy}`,
    `- **Explain Like I'm 10 ("${story.title}")**: ${story.analogy} **What went wrong:** ${story.whatWentWrong} **How we fixed it:** ${story.howWeFixedIt}`,
    ...(analysis.baseline.errorMessage
      ? [`- **Failing Runtime Exception**: \`${analysis.baseline.errorType || 'Error'}: ${analysis.baseline.errorMessage}\``]
      : []),
    '',
    '### 3. MINIMAL SURGICAL PATCH (UNIFIED DIFF)',
    '```diff',
    unifiedDiff,
    '```',
    '',
    '### 4. REGRESSION & EDGE-CASE TEST SUITE',
    `\`\`\`${analysis.language || 'python'}`,
    (testCode.trim() || analysis.generatedTestCode?.trim() || '# Auto-verified via static & sandbox checks'),
    '```',
    '',
    '### 5. AUDIT LOG ENTRY',
    '| Field | Value |',
    '| :--- | :--- |',
    `| **File** | \`${analysis.filename}\` |`,
    `| **Line(s)** | \`L${lineTarget}\` (\`+${analysis.diff.linesAdded} / -${analysis.diff.linesRemoved}\`) |`,
    `| **Defect / Rule** | \`${analysis.patchInfo.bugType}\` / \`${analysis.patchInfo.ruleId}\` |`,
    `| **Confidence** | \`${analysis.confidence.score}%\` |`,
    `| **Verification** | \`${analysis.sandbox.passed}/${analysis.sandbox.total} passed\` (\`${analysis.sandbox.durationMs.toFixed(1)} ms\`) |`,
    `| **Trust Gate Status** | \`${verdictLabel}\` |`,
    ...voiceNotesLines,
  ].join('\n');
}

