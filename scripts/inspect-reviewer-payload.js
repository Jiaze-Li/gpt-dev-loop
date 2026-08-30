#!/usr/bin/env node
// inspect-reviewer-payload — METADATA-ONLY diagnosis of the Reviewer request
// the full agy workflow would build from the CURRENT repository state.
//
//   node scripts/inspect-reviewer-payload.js plan.txt
//
// It builds the EXACT same Evidence the workflow's Gate Runner +
// Git Evidence Collector produce (createGitEvidenceCollector().collect_evidence
// with no baseCommit — i.e. `git diff HEAD`), renders the Reviewer prompt with
// the real buildAgyReviewPrompt / renderReviewInputs code path, and prints
// SIZE METRICS ONLY.
//
// It NEVER prints the prompt, the diff, the evidence, the task card body, or
// any model reply. It makes NO agy request.
//
// Caveat: the real Task Card and Execution Report are produced live by the
// Supervisor and by Claude and cannot be reproduced offline. This script
// substitutes a minimal schema-valid Task Card built from the plan file and a
// minimal Execution Report. Those two sections are small and roughly
// constant; the Evidence (git diff) is what varies with repo state, and the
// Evidence is reproduced EXACTLY.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { createGitEvidenceCollector } from '../src/adapters/gate/git-evidence/index.js';
import {
  buildAgyReviewPrompt,
  renderReviewInputs,
} from '../src/orchestrator/adapters/agyReviewerProvider.js';

export function sizeOf(text) {
  const s = typeof text === 'string' ? text : '';
  return {
    chars: s.length,
    bytes: Buffer.byteLength(s, 'utf8'),
    lines: s === '' ? 0 : s.split('\n').length,
  };
}

// Slice a rendered block on a set of literal heading lines, returning the text
// belonging to each heading (from the heading line to the next heading).
export function sliceSections(text, headings) {
  const out = {};
  for (let i = 0; i < headings.length; i += 1) {
    const start = text.indexOf(headings[i]);
    if (start === -1) {
      out[headings[i]] = null;
      continue;
    }
    let end = text.length;
    for (let j = i + 1; j < headings.length; j += 1) {
      const nextAt = text.indexOf(headings[j], start + headings[i].length);
      if (nextAt !== -1) {
        end = nextAt;
        break;
      }
    }
    out[headings[i]] = text.slice(start, end);
  }
  return out;
}

// Classify `git status --porcelain=v1` lines. `git diff HEAD` (what the
// collector runs with no baseCommit) covers tracked changes — staged AND
// unstaged — but NOT untracked files.
export function classifyStatus(porcelain) {
  const lines = porcelain.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  let trackedChanged = 0;
  let untracked = 0;
  let staged = 0;
  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      untracked += 1;
      continue;
    }
    trackedChanged += 1;
    if (x !== ' ' && x !== '?') staged += 1;
  }
  return { total: lines.length, trackedChanged, untracked, staged };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function syntheticTaskCard(planText, repoRoot) {
  return {
    task_id: 'inspect-synthetic',
    repository_context: {
      repository_name: path.basename(repoRoot),
      repository_url: null,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).stdout.trim() || null,
      commit_sha: git(['rev-parse', 'HEAD'], repoRoot).stdout.trim() || 'unknown',
    },
    goal: planText.trim(),
    context: 'Synthetic Task Card for payload inspection (real card is Supervisor-produced and not reproducible offline).',
    scope: 'As described by the plan file.',
    allowed_files: ['(per plan)'],
    forbidden_files: [],
    acceptance_criteria: ['(per plan)'],
    verification_commands: [],
    completion_signal: 'DONE',
  };
}

function syntheticExecutionReport(taskCard) {
  return {
    task_id: taskCard.task_id,
    repository_context: taskCard.repository_context,
    status: 'DONE',
    changed_files: [],
    tests_run: [],
    test_results: [],
    issues: 'none',
    next_recommendation: 'review',
  };
}

export async function inspect(planPath, { cwd = process.cwd() } = {}) {
  const planText = readFileSync(path.resolve(planPath), 'utf8');

  const collector = createGitEvidenceCollector();
  // EXACT workflow evidence: gateRunner calls collect_evidence({ cwd,
  // testResults }) with NO baseCommit. testResults is a small pass/fail
  // summary; we stub a passing one so the shape matches. The diff is
  // unaffected by testResults.
  const evidence = await collector.collect_evidence({
    cwd,
    testResults: { pass: true, results: [] },
  });

  const taskCard = syntheticTaskCard(planText, cwd);
  const executionReport = syntheticExecutionReport(taskCard);

  const prompt = buildAgyReviewPrompt(taskCard, executionReport, evidence, { attempt: 1 });
  const inputs = renderReviewInputs(taskCard, executionReport, evidence);

  const blocks = sliceSections(inputs, [
    '# Task Card (TASK_PROTOCOL.md)',
    '# Execution Report (EXECUTION_REPORT.md)',
    '# Evidence',
  ]);
  const evidenceBlock = blocks['# Evidence'] ?? '';
  const evSections = sliceSections(evidenceBlock, [
    '### diff status',
    '### base/head',
    '### git diff',
    '### gate results',
  ]);

  const porcelain = git(['status', '--porcelain=v1'], cwd).stdout;
  const statusClass = classifyStatus(porcelain);

  return {
    model: 'gpt-oss-120b-medium (AGY_REVIEWER_DEFAULT_MODEL)',
    prompt: sizeOf(prompt),
    taskCardSection: sizeOf(blocks['# Task Card (TASK_PROTOCOL.md)']),
    executionReportSection: sizeOf(blocks['# Execution Report (EXECUTION_REPORT.md)']),
    evidenceSection: sizeOf(evidenceBlock),
    gitDiffRendered: sizeOf(evSections['### git diff']),
    gateResultsRendered: sizeOf(evSections['### gate results']),
    rawGitDiff: sizeOf(evidence.git_diff),
    changedFileCount: evidence.changed_files.length,
    diffStatus: evidence.status,
    baseCommit: evidence.base ?? null,
    headCommit: evidence.head ?? null,
    workingTree: statusClass,
    diffScope: evidence.base
      ? 'base..head (task-scoped range supplied)'
      : 'git diff HEAD — ENTIRE dirty working tree vs HEAD (no base anchor captured)',
    taskProducedChangedFiles:
      'NOT DISTINGUISHABLE — the workflow captures no pre-task base commit, so every tracked change in the working tree is in the diff regardless of whether this task produced it',
    preExistingDirtyFiles:
      'NOT DISTINGUISHABLE from task-produced for the same reason; all ' +
      statusClass.trackedChanged +
      ' tracked-changed files are included',
  };
}

function printReport(r) {
  const line = (label, val) => console.log(`  ${String(label).padEnd(26)} ${val}`);
  console.log('inspect-reviewer-payload — metadata only, no agy call\n');
  line('reviewer model', r.model);
  console.log('');
  console.log('  final Reviewer prompt');
  line('  chars', r.prompt.chars);
  line('  utf-8 bytes', r.prompt.bytes);
  line('  lines', r.prompt.lines);
  console.log('');
  console.log('  section chars (rendered)');
  line('  Task Card', r.taskCardSection.chars);
  line('  Execution Report', r.executionReportSection.chars);
  line('  Evidence (whole)', r.evidenceSection.chars);
  line('  git diff (fenced)', r.gitDiffRendered.chars);
  line('  gate results', r.gateResultsRendered.chars);
  console.log('');
  console.log('  git diff');
  line('  raw diff chars', r.rawGitDiff.chars);
  line('  raw diff utf-8 bytes', r.rawGitDiff.bytes);
  line('  raw diff lines', r.rawGitDiff.lines);
  line('  changed-file count', r.changedFileCount);
  line('  diff status', r.diffStatus);
  line('  base commit', r.baseCommit ?? '(none)');
  line('  head commit', r.headCommit ?? '(none)');
  console.log('');
  console.log('  working tree (git status --porcelain=v1)');
  line('  total entries', r.workingTree.total);
  line('  tracked & changed', r.workingTree.trackedChanged);
  line('  staged', r.workingTree.staged);
  line('  untracked (NOT in diff)', r.workingTree.untracked);
  console.log('');
  console.log('  scope');
  line('  diff scope', r.diffScope);
  console.log(`  task-produced files:      ${r.taskProducedChangedFiles}`);
  console.log(`  pre-existing dirty files: ${r.preExistingDirtyFiles}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error('usage: node scripts/inspect-reviewer-payload.js <plan.txt>');
    process.exitCode = 1;
  } else {
    inspect(planPath)
      .then(printReport)
      .catch((err) => {
        console.error(`inspect-reviewer-payload: ${err.message}`);
        process.exitCode = 1;
      });
  }
}
