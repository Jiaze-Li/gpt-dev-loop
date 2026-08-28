#!/usr/bin/env node
// MVP entry point: run the automated Supervisor -> Claude -> Reviewer loop
// with BOTH the Supervisor and the Reviewer served by the local Antigravity
// CLI (`agy` -> Gemini). No Chrome, no GUI, no persistent agy conversation.
//
//   SUPERVISOR_PROVIDER=agy REVIEWER_PROVIDER=agy \
//     node scripts/run-agy-workflow.js plan.txt
//
//   AGY_MODEL overrides the default model (gemini-3.7-flash-high).
//
// Reuses, unchanged: automatedLoop's state machine, ClaudeSessionManager
// (fresh Claude per attempt), the deterministic gate + git evidence
// collector, the Task Card schema, the REWORK path, and the
// maxAttemptsPerTask / HUMAN_REQUIRED behavior. This file only selects the
// agy providers and prints a compact status stream.
//
// Fails closed: malformed Gemini output, an agy timeout / nonzero exit, an
// invalid Task Card, or an invalid Reviewer decision all abort the run with
// a non-zero exit — none are guessed at or retried.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { runAutomatedWorkflow } from '../src/orchestrator/automatedLoop.js';
import { selectProviders } from '../src/orchestrator/providerSelection.js';
import { createClaudeSessionManager } from '../src/orchestrator/adapters/claudeSessionManager.js';
import { createGateRunner } from '../src/orchestrator/adapters/gateRunner.js';
import { createGitEvidenceCollector } from '../src/adapters/gate/git-evidence/index.js';
import { createWorkflowBaseline } from '../src/orchestrator/workflowBaseline.js';
import {
  createWorkflowWorktree,
  WorkflowWorktreeError,
  WORKFLOW_WORKTREE_ERROR_CODES,
  SUPERGPT_WORKTREE_ROOT,
} from '../src/orchestrator/workflowWorktree.js';
import { callAgy as defaultCallAgy } from '../src/agy/agyClient.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { deliverWorkflowResult } from '../src/orchestrator/resultDelivery.js';

// --- compact status stream -------------------------------------------------

const PAD_ROLE = 11;
const PAD_TAG = 24;

export function formatStatusLine(role, tag, arrow) {
  const tagText = tag ? `[${tag}]` : '';
  return `${`${role} `.padEnd(PAD_ROLE)}${`${tagText} `.padEnd(PAD_TAG)}→ ${arrow}`;
}

// The role -> model roster, printed once at startup so it is mechanically
// obvious which model each role runs. The tags are the exact `agy` model
// IDs (never display names), and the Executor is always plain Claude.
export function formatRoleRoster({ supervisorModel, reviewerModel }) {
  return [
    formatStatusLine('Supervisor', supervisorModel, 'ready'),
    formatStatusLine('Executor', 'Claude', 'ready'),
    formatStatusLine('Reviewer', reviewerModel, 'ready'),
  ].join('\n');
}

// Translates automatedLoop's internal log lines (identifiers only, never
// prompt/reply content) into the compact operator stream. Unknown lines are
// dropped. Pure except for `write`; exported for deterministic testing.
// Supervisor and Reviewer lines are tagged with their own model ID.
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

// Operator-facing diagnostics for a provider (Supervisor/Reviewer) failure.
// Prints ONLY the safe, non-content fields an AdapterError carries on
// `.details` (role, model, exit code, stderr, duration). It never has
// access to — and never prints — prompt text, model reply text, or any
// auth/credential data. Returns the lines it wrote (for deterministic
// testing); no-op when there are no structured details.
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
    // Whitelisted operational metadata only (status / error_code / model /
    // token usage). Never the model's generated text — see agyErrorEnvelope.js.
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

function printAdapterErrorDiagnostics(err, write = (s) => console.error(s)) {
  for (const line of formatAdapterErrorDiagnostics(err)) write(line);
}

// --- metadata-only diagnostics ------------------------------------------
//
// These print ONLY structural counts and identifiers — branch, commit,
// clean flag, file counts, character/byte sizes. They NEVER print file
// contents, diff text, or prompt/reply text. Pure; exported for tests.

// Compact CLI diagnostics for the isolated workspace (requirement 8).
// Identifiers and a path only — never file contents, never a diff.
export function formatWorktreeDiagnostics({ worktree }) {
  const shortHead = String(worktree?.baseline_head ?? '').slice(0, 10) || 'unknown';
  return [
    `Repository  ${worktree?.source_repo_root ?? 'unknown'}`,
    `Baseline    ${worktree?.source_branch ?? 'unknown'}@${shortHead}`,
    'Workspace   isolated',
    `Worktree    ${worktree?.worktree_path ?? 'unknown'}`,
  ];
}

// Safe workflow-state metadata (requirement 6). No file contents.
// Records the invocation workspace and the repository identity as separate
// concepts — source_workspace is the exact worktree SuperGPT was launched
// from and is never rewritten to the primary checkout.
export function buildWorkspaceMetadata({ worktree }) {
  return {
    workflow_id: worktree.workflow_id,
    source_workspace: worktree.source_workspace ?? worktree.source_repo_root,
    repository_identity: worktree.repository_identity ?? null,
    source_branch: worktree.source_branch,
    source_head: worktree.source_head ?? worktree.baseline_head,
    isolated_worktree_path: worktree.worktree_path,
  };
}

// Requirement 3: mechanically verify, before Claude starts, that every cwd
// the workflow will use points at the isolated worktree and that its state
// matches the captured baseline. Fail closed on any violation.
export function assertWorkspaceInvariants({ worktree, baseline, claudeCwd, gateCwd }) {
  const fail = (check, message) => {
    throw new WorkflowWorktreeError(WORKFLOW_WORKTREE_ERROR_CODES.WORKTREE_INVARIANT_VIOLATION, message, { check });
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

// End-to-end: create the SuperGPT-managed isolated worktree from the source
// repo HEAD, re-establish the baseline INSIDE that worktree (always
// isolated — there is no user opt-in), verify every invariant, and record
// safe workflow-state metadata. The user's source tree may be dirty; that
// never blocks this and never leaks past the worktree boundary.
export async function establishIsolatedWorkspace({
  sourceCwd,
  workflowId,
  createWorktree = () => createWorkflowWorktree(),
  createBaseline = () => createWorkflowBaseline(),
  recordMetadata,
}) {
  const worktreeApi = createWorktree();
  const worktree = await worktreeApi.establish({ sourceCwd, workflowId });
  // Everything below is still PRE-EXECUTION setup (no Supervisor / Claude /
  // task work yet). If any of it fails, the isolated worktree just created
  // holds no useful workflow result, so tear it down rather than leave
  // garbage behind. Runtime failures once runAutomatedWorkflow is underway
  // are handled by the caller and DO preserve the worktree for resume.
  try {
    const baseline = await createBaseline().establish({ cwd: worktree.worktree_path, isolatedWorktree: true });
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
        await worktreeApi.remove(worktree.worktree_path, { force: true, sourceRepoRoot: sourceCwd });
      } catch {
        /* best effort — the setup violation is the error that matters */
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

// --- run -----------------------------------------------------------------

async function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error('usage: SUPERVISOR_PROVIDER=agy REVIEWER_PROVIDER=agy node scripts/run-agy-workflow.js <plan.txt>');
    process.exitCode = 1;
    return;
  }

  const sourceCwd = process.cwd();
  const workflowId = `wf-agy-${randomUUID()}`;

  if (process.env.GPT_DEV_LOOP_ISOLATED_WORKTREE) {
    console.error(
      'run-agy-workflow: note — GPT_DEV_LOOP_ISOLATED_WORKTREE is obsolete and ignored. ' +
        'SuperGPT now always creates and runs inside its own isolated worktree automatically.'
    );
  }

  // SuperGPT owns repository isolation. Fail closed BEFORE any provider or
  // Claude work: create a dedicated, SuperGPT-managed worktree from the
  // source repo HEAD, re-establish the baseline inside it, and verify every
  // invariant. The user's source tree may be dirty — that never blocks this
  // and never leaks into the Reviewer Evidence.
  let worktree;
  let baseline;
  try {
    const metadataPath = path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`);
    ({ worktree, baseline } = await establishIsolatedWorkspace({
      sourceCwd,
      workflowId,
      recordMetadata: async (meta) => {
        await mkdir(SUPERGPT_WORKTREE_ROOT, { recursive: true });
        await writeFile(metadataPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      },
    }));
  } catch (err) {
    console.error(`\nrun-agy-workflow: FAILED (${err.code ?? err.name}) — ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // Every cwd below is the isolated worktree — never the user's source tree.
  const repoRoot = worktree.worktree_path;

  // Measure the Reviewer prompt size (metadata only — never its content).
  const reviewerPromptSize = { chars: null, bytes: null };
  const measuringCallAgy = (opts) => {
    if (typeof opts?.prompt === 'string' && /You are the Reviewer/.test(opts.prompt)) {
      reviewerPromptSize.chars = opts.prompt.length;
      reviewerPromptSize.bytes = Buffer.byteLength(opts.prompt, 'utf8');
      console.log(`  reviewer prompt chars/bytes  ${reviewerPromptSize.chars} / ${reviewerPromptSize.bytes}`);
    }
    return defaultCallAgy(opts);
  };

  const persistence = new Persistence(path.join(repoRoot, '.gpt-dev-loop', 'workflows'));

  let selection;
  try {
    selection = selectProviders({ env: process.env, callAgy: measuringCallAgy, persistence, workflowId });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const plan = await readFile(path.resolve(planPath), 'utf8');

  const { supervisorModel, reviewerModel, supervisorSession, createReviewerSession, windowSession } = selection;

  console.log('SUPERGPT');
  console.log(`plan       ${path.resolve(planPath)}`);
  console.log('');
  console.log(formatRoleRoster({ supervisorModel, reviewerModel }));
  console.log('');
  for (const line of formatWorktreeDiagnostics({ worktree })) console.log(line);
  console.log('');
  for (const line of formatWorkflowBaselineDiagnostics(baseline)) console.log(line);
  console.log('');

  const status = createCompactStatusLogger({ supervisorModel, reviewerModel });

  const baseGate = createGateRunner({
    gitEvidenceCollector: createGitEvidenceCollector(),
    cwd: repoRoot,
    baseline,
  });
  const gateRunner = {
    async run(commands) {
      const evidence = await baseGate.run(commands);
      status(`gate result: ${evidence.pass ? 'PASS' : 'FAIL'}`);
      for (const line of formatReviewEvidenceDiagnostics(evidence)) console.log(line);
      return evidence;
    },
  };

  let result;
  try {
    result = await runAutomatedWorkflow({
      workflowId,
      supervisorSession,
      createReviewerSession,
      createClaudeSessionManager: ({ taskId }) =>
        createClaudeSessionManager({ workflowId, taskId, persistence, cwd: repoRoot }),
      gateRunner,
      windowSession,
      persistence,
      workflowGoal: plan,
      repositoryContext: {
        repository_name: path.basename(worktree.source_repo_root),
        repository_url: null,
        branch: worktree.source_branch,
        commit_sha: worktree.baseline_head,
      },
      maxAttemptsPerTask: Number(process.env.AGY_MAX_ATTEMPTS) || 3,
      log: status,
    });
  } catch (err) {
    console.error(`\nrun-agy-workflow: FAILED (${err.code ?? err.name}) — ${err.message}`);
    printAdapterErrorDiagnostics(err);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`run-agy-workflow: ${result.status}`);
  if (result.status === 'WORKFLOW_DONE') {
    console.log(result.summary ?? '');
    const snap = selection.sessionStore?.snapshot?.();
    if (snap) {
      console.log('');
      console.log('Conversations:');
      console.log(`  Supervisor  ${snap.supervisor?.conversation_id ?? '(none)'}`);
      for (const [tId, cId] of Object.entries(snap.reviewer?.conversations ?? {})) {
        console.log(`  Reviewer    ${cId} (task: ${tId})`);
      }
    }

    // Automatic safe delivery: carry the approved changes back into the
    // invocation workspace. Fails closed — a conflict with the user's own
    // in-flight edits, or any git/fs error, leaves the isolated worktree
    // intact and exits HUMAN_REQUIRED. A safe delivery cleans the worktree
    // up automatically.
    console.log('');
    let delivery;
    try {
      delivery = await deliverWorkflowResult({ worktree });
    } catch (err) {
      console.error(`delivery: HUMAN_REQUIRED (${err.code ?? err.name}) — ${err.message}`);
      console.log(`Worktree    ${worktree.worktree_path} (preserved)`);
      process.exitCode = 1;
      return;
    }

    if (delivery.status === 'HUMAN_REQUIRED') {
      console.error('delivery: HUMAN_REQUIRED — the approved changes conflict with the invocation workspace');
      for (const c of delivery.conflicts) {
        console.error(`  conflict  ${c.reason}${c.path ? ` — ${c.path}` : ''}`);
      }
      console.log(`Worktree    ${worktree.worktree_path} (preserved)`);
      process.exitCode = 1;
      return;
    }

    console.log(`delivery: DELIVERED — ${delivery.changed_files.length} file(s) into ${buildWorkspaceMetadata({ worktree }).source_workspace}`);
    for (const f of delivery.changed_files) console.log(`  delivered  ${f}`);
    console.log(`Worktree    ${worktree.worktree_path} (delivered, cleaned up)`);
    return;
  }

  console.log(`reason:   ${result.reason ?? ''}`);
  console.log(`question: ${result.question ?? ''}`);
  process.exitCode = 1;
  // HUMAN_REQUIRED / failure need the isolated worktree for resume/debug —
  // never auto-deleted. Always report where it is.
  console.log(`Worktree    ${worktree.worktree_path} (preserved)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`run-agy-workflow: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
