// reviewerEvidence.js — deterministic, zero-model-call compact evidence
// projection for the Internal Reviewer.
//
// All truncation / compaction is mechanical string manipulation.
// No model calls, no LLM summarisation, no external dependencies.
// Full evidence is preserved by the caller; this module only produces
// the compact view that fits inside the Reviewer's token budget.

// ── Budget constants ────────────────────────────────────────────────
export const REVIEWER_PROMPT_HARD_LIMIT = 40_000;   // chars
export const REVIEWER_DIFF_MAX_CHARS    = 12_000;   // chars
export const REVIEWER_GATE_OUTPUT_MAX_CHARS = 2_000; // chars per gate result

// ── compactDiff ─────────────────────────────────────────────────────
//
// Deterministic compact projection of a raw unified diff string.
//
// Returns { compact, fileList, stats, truncated, fullLength }.

export function compactDiff(diff, {
  maxChars       = REVIEWER_DIFF_MAX_CHARS,
  maxHunksPerFile = 5,
} = {}) {
  if (typeof diff !== 'string' || diff.length === 0) {
    return {
      compact:    diff ?? '',
      fileList:   [],
      stats:      { files: 0, insertions: 0, deletions: 0, totalLines: 0 },
      truncated:  false,
      fullLength: typeof diff === 'string' ? diff.length : 0,
    };
  }

  const fullLength = diff.length;

  // Split into per-file sections.  The split keeps the delimiter at the
  // start of each element (except the first, which is usually empty).
  const raw = diff.split(/^(?=diff --git )/m).filter(Boolean);

  const fileList   = [];
  let insertions   = 0;
  let deletions    = 0;
  let totalLines   = 0;
  const kept       = [];

  for (const section of raw) {
    // Extract file path from `diff --git a/PATH b/PATH`
    const headerMatch = section.match(/^diff --git a\/(.+?) b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : null;
    if (filePath && !fileList.includes(filePath)) fileList.push(filePath);

    // Count +/- lines
    const lines = section.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) insertions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      totalLines++;
    }

    // Limit hunks per file
    const hunks = section.split(/^(?=@@ )/m);
    const header = hunks[0]; // file header (diff --git, ---, +++)
    const hunkBodies = hunks.slice(1);

    if (hunkBodies.length <= maxHunksPerFile) {
      kept.push(section);
    } else {
      const trimmedHunks = hunkBodies.slice(0, maxHunksPerFile);
      const omitted = hunkBodies.length - maxHunksPerFile;
      kept.push(
        header +
        trimmedHunks.join('') +
        `\n... [${omitted} more hunk(s) in ${filePath ?? 'this file'} omitted]\n`
      );
    }
  }

  let compact = kept.join('');

  const stats = { files: fileList.length, insertions, deletions, totalLines };

  if (compact.length <= maxChars) {
    return { compact, fileList, stats, truncated: false, fullLength };
  }

  // Hard-truncate to budget and append a marker.
  compact = compact.slice(0, maxChars);
  const marker = `\n... [TRUNCATED — showing ${maxChars} of ${fullLength} chars, ${fileList.length} files changed] ...`;
  compact += marker;

  return { compact, fileList, stats, truncated: true, fullLength };
}

// ── compactGateOutput ───────────────────────────────────────────────
//
// Deterministic compact projection of gate result entries.
//
// PASS → output stripped.  FAIL → keep tail of output up to budget.
//
// Returns { results: [...compacted], truncated: boolean }.

export function compactGateOutput(results, {
  maxOutputChars = REVIEWER_GATE_OUTPUT_MAX_CHARS,
} = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return { results: results ?? [], truncated: false };
  }

  let anyTruncated = false;
  const compacted = results.map((r) => {
    const out = {
      command:  r.command,
      pass:     r.pass,
      exitCode: r.exitCode,
    };

    if (r.pass) {
      // PASS: strip verbose test logs entirely
      out.output = '(pass — output omitted)';
      return out;
    }

    // FAIL: keep the tail (usually contains the actual error)
    const rawOutput = r.output ?? '';
    if (rawOutput.length <= maxOutputChars) {
      out.output = rawOutput;
    } else {
      anyTruncated = true;
      const tail = rawOutput.slice(-maxOutputChars);
      out.output = `[TRUNCATED — last ${maxOutputChars} of ${rawOutput.length} chars]\n${tail}`;
    }
    return out;
  });

  return { results: compacted, truncated: anyTruncated };
}

// ── compactEvidence ─────────────────────────────────────────────────
//
// Main entry point.  Produces a compact evidence object suitable for
// renderEvidence() and a fullEvidenceRef that records original sizes
// for debug / audit.
//
// Returns { evidence, fullEvidenceRef, truncated }.

export function compactEvidence(evidence, taskCard, executionReport, {
  diffMaxChars       = REVIEWER_DIFF_MAX_CHARS,
  gateMaxOutputChars = REVIEWER_GATE_OUTPUT_MAX_CHARS,
  maxHunksPerFile    = 5,
} = {}) {
  if (!evidence || typeof evidence !== 'object') {
    return {
      evidence: evidence ?? {},
      fullEvidenceRef: { diffChars: 0, gateOutputChars: 0, truncatedFields: [] },
      truncated: false,
    };
  }

  const truncatedFields = [];

  // ── Compact diff ──────────────────────────────────────────────
  const {
    compact:    compactDiffText,
    fileList,
    stats:      diffStats,
    truncated:  diffTruncated,
    fullLength: diffFullLength,
  } = compactDiff(evidence.diff, { maxChars: diffMaxChars, maxHunksPerFile });

  if (diffTruncated) truncatedFields.push('diff');

  // ── Compact gate results ──────────────────────────────────────
  const rawResults = evidence.results ?? [];
  const {
    results:   compactResults,
    truncated: gateTruncated,
  } = compactGateOutput(rawResults, { maxOutputChars: gateMaxOutputChars });

  if (gateTruncated) truncatedFields.push('gateOutput');

  // Total original gate output chars (for the ref)
  const gateOutputChars = rawResults.reduce(
    (sum, r) => sum + (typeof r.output === 'string' ? r.output.length : 0), 0,
  );

  // ── De-duplicate changed_files ────────────────────────────────
  // executionReport.changed_files already lists changed files.
  // If the diff fileList is a subset, annotate rather than repeat.
  const reportFiles = new Set(
    (executionReport?.changed_files ?? []).map((f) => f.replace(/^\s*-\s*/, '')),
  );
  const diffOnlyFiles = fileList.filter((f) => !reportFiles.has(f));
  // diffOnlyFiles will be empty when the report already covers them

  // ── Assemble compact evidence ─────────────────────────────────
  const compactEv = {
    ...evidence,
    diff:    compactDiffText,
    results: compactResults,
  };

  // Attach diff-stat header to help the Reviewer without full diff
  if (diffTruncated || fileList.length > 0) {
    compactEv._diffSummary = {
      files:      diffStats.files,
      insertions: diffStats.insertions,
      deletions:  diffStats.deletions,
      totalLines: diffStats.totalLines,
      truncated:  diffTruncated,
      fullDiffChars: diffFullLength,
      ...(diffOnlyFiles.length > 0 ? { additionalFiles: diffOnlyFiles } : {}),
    };
  }

  const fullEvidenceRef = {
    diffChars:       diffFullLength,
    gateOutputChars,
    truncatedFields,
  };

  return {
    evidence:        compactEv,
    fullEvidenceRef,
    truncated:       diffTruncated || gateTruncated,
  };
}

// ── enforcePromptBudget ─────────────────────────────────────────────
//
// Hard guard: if the fully-assembled prompt still exceeds the budget
// after compact projection, mechanically truncate.  The caller must
// NOT send the prompt to the model and must throw
// REVIEWER_CONTEXT_BUDGET_EXCEEDED instead.
//
// Returns { prompt, budgetExceeded, originalLength, limit }.

export function enforcePromptBudget(prompt, limit = REVIEWER_PROMPT_HARD_LIMIT) {
  const originalLength = typeof prompt === 'string' ? prompt.length : 0;
  if (originalLength <= limit) {
    return { prompt, budgetExceeded: false, originalLength, limit };
  }

  const truncated = prompt.slice(0, limit);
  const marker = `\n\n[REVIEWER_CONTEXT_BUDGET_EXCEEDED — prompt truncated from ${originalLength} to ${limit} chars]`;

  return {
    prompt:         truncated + marker,
    budgetExceeded: true,
    originalLength,
    limit,
  };
}
