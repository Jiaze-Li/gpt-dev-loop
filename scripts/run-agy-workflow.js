// Internal workflow-preparation helpers shared by the canonical SuperGPT Core.
//
// IMPORTANT: this file is no longer an executable workflow entrypoint.
// The old standalone AGY workflow runner has been removed so there is only
// one production execution path: src/orchestrator/supergpt.js -> runSuperGPT().
//
// These helpers remain here temporarily because the canonical Core and the
// deterministic tests reuse them. They do not start Planner/Supervisor/
// Executor/Reviewer work on their own.

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { createWorkflowBaseline } from '../src/orchestrator/workflowBaseline.js';
import {
  createWorkflowWorktree,
  WorkflowWorktreeError,
  WORKFLOW_WORKTREE_ERROR_CODES,
} from '../src/orchestrator/workflowWorktree.js';
import { validateWorkflowId } from '../src/orchestrator/workflowId.js';
import {
  collectRepositoryContext,
  generatePlan,
  PlannerError,
} from '../src/orchestrator/planner.js';

// --- compact status formatting helpers -----------------------------------

const PAD_ROLE = 11;
const PAD_TAG = 24;

export function formatStatusLine(role, tag, arrow) {
  const tagText = tag ? `[${tag}]` : '';
  return `${`${role} `.padEnd(PAD_ROLE)}${`${tagText} `.padEnd(PAD_TAG)}→ ${arrow}`;
}

export function formatRoleRoster({ supervisorModel, reviewerModel }) {
  return [
    formatStatusLine('Supervisor', supervisorModel, 'ready'),
    formatStatusLine('Executor', 'Claude', 'ready'),
    formatStatusLine('Reviewer', reviewerModel, 'ready'),
  ].join('\n');
}

export function createCompactStatusLogger({ supervisorModel, reviewerModel, write = (s) => console.log(s) }) {
  return function log(line) {
    let m;
    if ((m = line.match(/^supervisor decision: (\w+)$/))) {
      write(formatStatusLine('Supervisor', supervisorModel, m[1]));
    } else if ((m = line.match(/^claude attempt started: task=(\S+) attempt=(\d+)$/))) {
      write(formatStatusLine('Task', m[1], `attempt ${m[2]}`));
      write(formatStatusLine('Executor', 'Claude', 'RUNNING'));
    } else if (line.match(/^claude attempt completed:/)) {
      write(formatStatusLine('Executor', 'Claude', 'DONE'));
    } else if ((m = line.match(/^gate result: (\w+)$/))) {
      write(formatStatusLine('Gate', null, m[1]));
    } else if ((m = line.match(/^review completed: .*decision=(\w+)$/))) {
      write(formatStatusLine('Reviewer', reviewerModel, m[1]));
    }
  };
}

export function formatAdapterErrorDiagnostics(err) {
  const d = err && err.details;
  if (!d || typeof d !== 'object') return [];
  const lines = ['', 'reviewer/agy diagnostics (safe fields only):'];
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`  ${label.padEnd(12)} ${value}`);
  };
  add('provider', d.role);
  add('model', d.model);
  add('agy error', d.agyErrorName);
  add('agy code', d.agyCode);
  add('exit code', d.exitCode);
  add('duration ms', d.durationMs);
  if (d.agyEnvelope && typeof d.agyEnvelope === 'object' && Object.keys(d.agyEnvelope).length) {
    add('agy envelope', JSON.stringify(d.agyEnvelope));
  }
  if (typeof d.stderr === 'string' && d.stderr.trim() !== '') {
    lines.push('  stderr:');
    for (const line of d.stderr.replace(/\s+$/, '').split('\n')) lines.push(`    ${line}`);
  } else {
    lines.push('  stderr:       (none captured)');
  }
  return lines;
}

// --- metadata-only workflow preparation helpers --------------------------

export function formatWorktreeDiagnostics({ worktree }) {
  const shortHead = String(worktree?.baseline_head ?? '').slice(0, 10) || 'unknown';
  return [
    `Repository  ${worktree?.source_repo_root ?? 'unknown'}`,
    `Baseline    ${worktree?.source_branch ?? 'unknown'}@${shortHead}`,
    'Workspace   isolated',
    `Worktree    ${worktree?.worktree_path ?? 'unknown'}`,
  ];
}

export function buildWorkspaceMetadata({ worktree }) {
  return {
    workflow_id: worktree.workflow_id,
    source_workspace: worktree.source_workspace ?? worktree.source_repo_root,
    repository_identity: worktree.repository_identity ?? null,
    source_branch: worktree.source_branch,
    source_head: worktree.source_head ?? worktree.baseline_head,
    baseline_head: worktree.baseline_head,
    isolated_worktree_path: worktree.worktree_path,
  };
}

export function assertWorkspaceInvariants({ worktree, baseline, claudeCwd, gateCwd }) {
  const fail = (check, message) => {
    throw new WorkflowWorktreeError(
      WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION,
      message,
      { check },
    );
  };
  if (baseline.head !== worktree.baseline_head) {
    fail('baseline_head', `isolated worktree HEAD ${baseline.head} does not equal the captured workflow baseline ${worktree.baseline_head}`);
  }
  if (baseline.clean !== true) {
    fail('clean_tree', 'the isolated worktree is not clean at workflow start');
  }
  if (baseline.repo_root !== worktree.worktree_path) {
    fail('repo_membership', `baseline repo root ${baseline.repo_root} is not the isolated worktree ${worktree.worktree_path}`);
  }
  if (claudeCwd !== worktree.worktree_path) {
    fail('claude_cwd', `Claude cwd ${claudeCwd} is not the isolated worktree ${worktree.worktree_path}`);
  }
  if (gateCwd !== worktree.worktree_path) {
    fail('gate_cwd', `gate/evidence cwd ${gateCwd} is not the isolated worktree ${worktree.worktree_path}`);
  }
}

export async function establishIsolatedWorkspace({
  sourceCwd,
  workflowId,
  createWorktree = () => createWorkflowWorktree(),
  createBaseline = () => createWorkflowBaseline(),
  recordMetadata,
}) {
  validateWorkflowId(workflowId);
  const worktreeApi = createWorktree();
  const worktree = await worktreeApi.establish({ sourceCwd, workflowId });
  try {
    const baseline = await createBaseline().establish({
      cwd: worktree.worktree_path,
      isolatedWorktree: true,
    });
    assertWorkspaceInvariants({
      worktree,
      baseline,
      claudeCwd: worktree.worktree_path,
      gateCwd: worktree.worktree_path,
    });
    if (recordMetadata) await recordMetadata(buildWorkspaceMetadata({ worktree }));
    return { worktree, baseline };
  } catch (err) {
    if (typeof worktreeApi.remove === 'function') {
      try {
        await worktreeApi.remove(worktree.worktree_path, {
          force: true,
          sourceRepoRoot: sourceCwd,
        });
      } catch {
        /* best effort — preserve the setup error */
      }
    }
    throw err;
  }
}

export function formatWorkflowBaselineDiagnostics(baseline) {
  const b = baseline ?? {};
  return [
    'workflow baseline:',
    `  branch  ${b.branch ?? 'unknown'}`,
    `  head    ${b.head ?? 'unknown'}`,
    `  clean   ${b.clean === undefined ? 'unknown' : b.clean}`,
    `  isolated worktree  ${b.isolated_worktree ?? false}`,
  ];
}

export function formatReviewEvidenceDiagnostics(evidence, { promptChars, promptBytes } = {}) {
  const d = (evidence && evidence.diagnostics) || {};
  const untracked = Array.isArray(evidence?.untracked_files) ? evidence.untracked_files : [];
  const lines = [
    'review evidence:',
    `  tracked changed files   ${d.tracked_changed_files ?? 0}`,
    `  untracked task files    ${d.untracked_task_files ?? untracked.length} ` +
      `(${d.untracked_task_files_included ?? untracked.filter((f) => f.included).length} with contents)`,
    `  diff chars/bytes        ${d.diff_chars ?? 0} / ${d.diff_bytes ?? 0}`,
  ];
  if (Number.isFinite(promptChars) || Number.isFinite(promptBytes)) {
    lines.push(`  reviewer prompt chars/bytes  ${promptChars ?? '?'} / ${promptBytes ?? '?'}`);
  }
  return lines;
}

// Resolve either a legacy plan file or a natural-language instruction.
// This prepares input only; it never starts the workflow. runSuperGPT() is
// the sole owner of actual orchestration and execution.
export async function resolveWorkflowPlan({
  planArg,
  cwd,
  callAgy,
  collect = collectRepositoryContext,
  generate = generatePlan,
  statFile = stat,
  readPlanFile = (p) => readFile(p, 'utf8'),
  log = () => {},
} = {}) {
  if (typeof planArg !== 'string' || planArg.trim() === '') {
    throw new PlannerError('PLANNER_BAD_INPUT', 'a plan file path or a natural-language instruction is required');
  }

  const resolvedPath = path.resolve(cwd ?? process.cwd(), planArg);
  let isFile = false;
  try {
    isFile = (await statFile(resolvedPath)).isFile();
  } catch {
    isFile = false;
  }

  if (isFile) {
    return { plan: await readPlanFile(resolvedPath), source: 'file' };
  }

  log('planner: collecting repository context');
  const repoContext = await collect({ cwd });
  log('planner: generating plan from natural-language instruction');
  const result = await generate({ userIntent: planArg, repoContext, callAgy });

  if (result.status === 'AMBIGUOUS') {
    return { status: 'AMBIGUOUS', question: result.question, source: 'nl' };
  }
  return {
    plan: result.planText,
    summary: result.summary,
    tasks: result.tasks,
    closeoutVerificationCommands: result.closeoutVerificationCommands ?? [],
    closeoutPolicySources: result.closeoutPolicySources ?? [],
    source: 'nl',
  };
}
