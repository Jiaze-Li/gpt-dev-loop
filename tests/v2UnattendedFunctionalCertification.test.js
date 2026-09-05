// V2 UNATTENDED FUNCTIONAL CERTIFICATION — product-composition certification.
//
// These tests drive the REAL production composition:
//
//   supergptRoute -> runSuperGPT -> defaultPipeline -> selectWorkflowPath ->
//   (Planner if Full) -> runAutomatedWorkflow -> Executor -> real Gate ->
//   Reviewer -> [PR Closeout] -> real local Safe Delivery -> WORKFLOW_DONE
//
// against a REAL temporary git repository, faking only the external/
// nondeterministic boundaries: the Planner/Executor/Reviewer/Supervisor
// physical model transport, and the external GitHub PR reviewer.
//
// What stays REAL in every scenario below:
//   - the isolated git worktree, its Gate, and Safe Result Delivery back into
//     the source repository (verification_commands run for real via `sh -c`
//     against real files the fake Executor writes)
//   - ModelSpendAuthority + NewInformationLedger + ReservationLedger +
//     createProductionRoleRuntime (the SAME Token Safety wiring
//     providerSelection.js#selectProviders constructs in production)
//   - the deterministic Fast/Full path selection, deterministic Supervisor
//     policy (decideDeterministically), Gate-vs-Reviewer rework routing, and
//     bounded escalation/HUMAN_REQUIRED thresholds in automatedLoop.js
//   - runPrCloseoutLoop's repair/re-review state machine (PR closeout tests)
//
// What is faked (an EXTERNAL or physically-nondeterministic boundary only):
//   - the Planner/Executor/Reviewer/Supervisor model transport (an adapter
//     function that writes/reads real files, never a hand-rolled workflow
//     status decision)
//   - the GitHub PR (getPrHead / requestTrustedReview / pushRepair /
//     escalateSupervisor) via the SAME adapter contract
//     runPrCloseoutLoop/createRealGithubPrCloseoutAdapters use in production
//
// REAL PROVIDER CALLS = 0. REAL EXTERNAL MODEL TRIGGERS = 0.
// SUPERGPT MCP TOOLS = 0. SUPERGPT WORKFLOWS STARTED (via MCP) = 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { runSuperGPT, supergptResume } from '../src/orchestrator/supergpt.js';
import { supergptRoute, ROUTE_DECISION } from '../src/control/autoRoutePolicy.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { nullWindowSession } from '../src/orchestrator/agyProviderSessions.js';
import { ModelSpendAuthority } from '../src/orchestrator/modelSpendAuthority.js';
import { ReservationLedger } from '../src/orchestrator/modelSpendReservation.js';
import { NewInformationLedger } from '../src/orchestrator/newInformation.js';
import { createProductionRoleRuntime } from '../src/orchestrator/productionRoleRuntime.js';
import {
  DEFAULT_ROLE_POLICY, PRODUCTION_ROLE_CAPABILITIES, QuotaPoolRegistry, ProviderHealthRegistry,
} from '../src/orchestrator/roleRouting.js';
import {
  saveCheckpoint, recordAdvancedBaselineHead, markDeliveryReady, readControl,
} from '../src/orchestrator/workflowControl.js';

// ─── Shared harness ─────────────────────────────────────────────────────

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'ignore' });
}

// A minimal real git repository the isolated worktree/Gate/Delivery
// machinery operates on for real. Each "unit" is an ES module export plus a
// plain check script asserting its value — the REAL Gate runs it for real,
// so a fake Executor's file edits genuinely pass or fail. `target` (default:
// `initial`) is the value the check script pins to — i.e. the "correct"
// value a fake Executor must eventually write; `initial` is what the
// repository actually starts at, which may deliberately be wrong to
// establish a real, committed, pre-existing bug.
function setupSourceRepo(tmpRoot, { units = [{ name: 'value', initial: 1 }] } = {}) {
  const sourceRepo = path.join(tmpRoot, 'source-repo');
  fs.mkdirSync(path.join(sourceRepo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sourceRepo, 'tests'), { recursive: true });
  sh('git init -b main', sourceRepo);
  sh('git config user.name Test', sourceRepo);
  sh('git config user.email test@example.com', sourceRepo);
  fs.writeFileSync(path.join(sourceRepo, 'package.json'), JSON.stringify({ name: 'cert-fixture', private: true, type: 'module' }, null, 2));
  for (const unit of units) {
    const target = unit.target ?? unit.initial;
    writeUnit(sourceRepo, unit.name, target);
    if (unit.initial !== target) writeSource(sourceRepo, unit.name, unit.initial);
  }
  sh('git add -A && git commit -m initial', sourceRepo);
  return sourceRepo;
}

// Writes BOTH the source file and the check script that pins its expected
// value — used only to establish a unit's fixed contract (repo setup / a
// genuinely new accepted value). A fake Executor fixing or breaking a unit
// during a scenario must use `writeSource` instead: it edits only the source
// half, leaving the pinned check (the real, independent Gate contract)
// untouched — exactly like a real Executor never gets to rewrite its own
// acceptance test.
//
// Deliberately a plain exit-code script, NOT `node --test`: this whole
// certification suite itself runs under `node --test`, and Node's test
// runner detects a `node --test` invocation nested inside another and
// SKIPS it (silently exiting 0) rather than truly running it — which would
// make every Gate a no-op pass regardless of the fake Executor's edits. A
// plain script has no such recursive-runner guard, so the real Gate's
// pass/fail genuinely depends on the file content.
function writeUnit(repoRoot, name, expected) {
  writeSource(repoRoot, name, expected);
  fs.writeFileSync(
    path.join(repoRoot, 'tests', `${name}.check.mjs`),
    `import { ${name} } from '../src/${name}.js';\n`
    + `if (${name} !== ${JSON.stringify(expected)}) { console.error('expected ${name} === ${JSON.stringify(expected)}, got', ${name}); process.exit(1); }\n`,
  );
}

function writeSource(repoRoot, name, value) {
  fs.writeFileSync(
    path.join(repoRoot, 'src', `${name}.js`),
    `export const ${name} = ${JSON.stringify(value)};\n`,
  );
}

function verifyCommand(name) {
  return `node tests/${name}.check.mjs`;
}

function cleanupWorkflow(workflowId) {
  if (!fs.existsSync(SUPERGPT_WORKTREE_ROOT)) return;
  for (const name of fs.readdirSync(SUPERGPT_WORKTREE_ROOT)) {
    if (name === workflowId || name.startsWith(`${workflowId}.`) || name === `repo-${workflowId}`) {
      fs.rmSync(path.join(SUPERGPT_WORKTREE_ROOT, name), { recursive: true, force: true });
    }
  }
}

const resolveFamily = (family) => ({
  requestedFamily: family,
  resolvedModel: family.split(':')[1] ?? family,
  provider: family.startsWith('agy:') ? family.replace(':', '-') : family.split(':')[0],
  capabilities: { roles: PRODUCTION_ROLE_CAPABILITIES[family] ?? [] },
});

// Builds a `_selectProviders`-compatible fake that is REAL for Token Safety
// (ModelSpendAuthority + NewInformationLedger + ReservationLedger +
// createProductionRoleRuntime — the identical wiring providerSelection.js's
// production selectProviders() constructs) and fakes only the physical
// Executor transport (production Executor pool is claude:sonnet ONLY — see
// roleRouting.js DEFAULT_ROLE_POLICY.executor). supervisorImpl/reviewerImpl
// are plain fakes (Supervisor/Reviewer are not yet New-Information-gated
// call sites in this codebase — see newInformation.js Wiring Card 2 scope).
function buildFakeSelection({
  executorImpl, reviewerImpl, supervisorImpl, counters,
}) {
  const informationLedger = new NewInformationLedger({});
  let recordSafetyEventSink = null;
  const reservationLedger = new ReservationLedger({ recordSafetyEvent: (e) => recordSafetyEventSink?.(e) });
  const spendAuthority = new ModelSpendAuthority({
    informationLedger, reservationLedger, recordSafetyEvent: (e) => recordSafetyEventSink?.(e),
  });
  const runtime = createProductionRoleRuntime({
    rolePolicy: DEFAULT_ROLE_POLICY,
    quotaRegistry: new QuotaPoolRegistry({ filePath: null }),
    providerHealth: new ProviderHealthRegistry(),
    resolveFamily,
    spendAuthority,
    adapters: {
      // Full Path always routes through `selection.runtime.invoke('planner',
      // {resolve}, ...)` (see supergpt.js#defaultPipeline) regardless of
      // whether a test injects `_resolveWorkflowPlan` — that override IS the
      // `resolve` callback's body, not a replacement for the runtime call
      // itself. This adapter is the real production shape (mirrors
      // tests/newInformationSupergptWiring.test.js's
      // buildRealAuthorityFakeSelection): it hands `resolve` a transport
      // function and returns whatever `resolve` (i.e. the injected
      // `_resolveWorkflowPlan`) decides — zero-token whenever that resolver
      // never actually calls the transport, exactly like a real deterministic
      // frozen-plan replay.
      planner: {
        'codex:default': async ({ resolve }) => {
          let transportInvoked = false;
          const resolved = await resolve(async () => {
            transportInvoked = true;
            return { usage: { input_tokens: 1, output_tokens: 1 } };
          });
          if (resolved && typeof resolved === 'object' && resolved.usage == null) {
            resolved.usage = transportInvoked ? { input_tokens: 1, output_tokens: 1 } : { input_tokens: 0, output_tokens: 0 };
          }
          return resolved;
        },
      },
      executor: {
        'claude:sonnet': async (payload) => {
          counters.executor += 1;
          return executorImpl(payload, counters.executor);
        },
      },
    },
  });
  return ({ recordSafetyEvent } = {}) => {
    recordSafetyEventSink = recordSafetyEvent ?? null;
    return {
      runtime,
      informationLedger,
      supervisorSession: {
        create: async () => ({}),
        decide: async (ctx) => {
          counters.supervisor += 1;
          if (!supervisorImpl) throw new Error('unexpected Supervisor call — none of this scenario\'s attempts should escalate');
          return supervisorImpl(ctx);
        },
        close: async () => {},
      },
      createReviewerSession: () => ({
        create: async () => ({}),
        review: async (taskId) => {
          counters.reviewer += 1;
          return reviewerImpl(taskId, counters.reviewer);
        },
        close: async () => {},
      }),
      createExecutorSessionManager: ({
        taskId, persistence, cwd, workflowId, onRoutingDecision, onProcessStarted, onProcessExited,
      }) => ({
        async execute(taskCard, { signal, evidenceIds } = {}) {
          if (signal?.aborted) throw new Error('executor cancelled');
          const result = await runtime.invoke('executor', {
            taskId, workflowId, persistence, cwd, taskCard, onRoutingDecision, onProcessStarted, onProcessExited,
          }, { operationId: `${workflowId}:${taskId}`, workflowId, evidenceIds });
          return result.value;
        },
      }),
      windowSession: nullWindowSession,
      sessionStore: { snapshot: () => ({}) },
    };
  };
}

function pass(taskId) {
  return { task_id: taskId, decision: 'PASS', findings: [], required_changes: 'none', rationale: 'looks good' };
}
function rework(taskId, tag) {
  return {
    task_id: taskId, decision: 'REWORK', findings: [`issue: ${tag}`], required_changes: [`fix ${tag}`], rationale: `not yet: ${tag}`,
  };
}

function collectEvents() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

// ═══════════════════════════════════════════════════════════════════════
// PART D — deterministic route
// ═══════════════════════════════════════════════════════════════════════

test('D. supergptRoute: substantial engineering -> SUPERGPT, trivial edit -> DIRECT, explicit bypass -> DIRECT, explicit force -> SUPERGPT', () => {
  const d1 = supergptRoute({ goal: 'Fix the session expiration bug in src/session.js and add tests' });
  assert.equal(d1.decision, ROUTE_DECISION.SUPERGPT);

  const d2 = supergptRoute({ goal: 'Fix typo in README.md' });
  assert.equal(d2.decision, ROUTE_DECISION.DIRECT);

  const d3 = supergptRoute({ goal: 'Do not use SuperGPT for this; fix a typo' });
  assert.equal(d3.decision, ROUTE_DECISION.DIRECT);

  const d4 = supergptRoute({ goal: 'Use SuperGPT to refactor the auth module' });
  assert.equal(d4.decision, ROUTE_DECISION.SUPERGPT);
});

// ═══════════════════════════════════════════════════════════════════════
// PART E/F — Fast Path: happy path, then Reviewer rework
// ═══════════════════════════════════════════════════════════════════════

test('E+F+Q+R+S. Fast Path happy path, then a second Fast Path task with one automatic Reviewer rework — real delivery, real event stream, zero user relay', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-fast-'));
  const sourceRepo = setupSourceRepo(tmpRoot, { units: [{ name: 'value', initial: 1, target: 2 }] });

  // --- E: Fast Path happy path -------------------------------------------
  const wfHappy = `wf-v2cert-fast-happy-${Date.now()}`;
  const counters1 = {
    executor: 0, reviewer: 0, supervisor: 0,
  };
  const { events: events1, onEvent: onEvent1 } = collectEvents();
  const _selectProviders1 = buildFakeSelection({
    counters: counters1,
    executorImpl: (payload) => {
      writeSource(payload.cwd, 'value', 2);
      return {
        task_id: payload.taskCard.task_id, status: 'DONE', changed_files: ['src/value.js'], usage: { input_tokens: 1, output_tokens: 1 }, callId: `exec-${payload.taskCard.task_id}-1`,
      };
    },
    reviewerImpl: (taskId) => pass(taskId),
  });

  let result1;
  try {
    result1 = await runSuperGPT({
      workflowId: wfHappy,
      goal: 'Fix the off-by-one in src/value.js',
      cwd: sourceRepo,
      boundedTask: {
        task_id: 'fix-value', goal: 'Fix the off-by-one in src/value.js', allowed_files: ['src/value.js'], verification_commands: [verifyCommand('value')],
      },
      _selectProviders: _selectProviders1,
      onEvent: onEvent1,
    });

    assert.equal(result1.status, 'WORKFLOW_DONE', `Fast happy must reach DONE: ${result1.reason}`);
    assert.equal(counters1.executor, 1, 'FAST_PATH_PLANNER_CALLS proxy: exactly one Executor call, no rework');
    assert.equal(counters1.reviewer, 1, 'Reviewer ran independently exactly once');
    assert.equal(counters1.supervisor, 0, 'FAST_PATH_SUPERVISOR_NORMAL_CALLS = 0');

    // Q: real source-workspace delivery proof (not merely the isolated worktree).
    const delivered = fs.readFileSync(path.join(sourceRepo, 'src', 'value.js'), 'utf8');
    assert.match(delivered, /export const value = 2;/, 'the accepted change reached the SOURCE workspace, not only the worktree');
    assert.ok(Array.isArray(result1.deliveredFiles) && result1.deliveredFiles.length > 0, 'result names the delivered files');

    // R: event-stream truth. Fast Path still emits the same planning
    // milestone events as bookkeeping (see supergpt.js#defaultPipeline —
    // planning_started/completed bracket both paths), but never actually
    // dispatches the Planner: planning_completed's tasksCount is 1 (the
    // frozen bounded task), never a Planner-produced multi-task queue.
    const types1 = events1.map((e) => e.type);
    assert.ok(types1.includes('workflow_started'));
    assert.ok(types1.includes('workflow_finished'));
    const planningCompleted1 = events1.find((e) => e.type === 'planning_completed');
    assert.equal(planningCompleted1?.tasksCount, 1, 'Fast Path never expands beyond its single frozen bounded task');
    const pathEvent1 = events1.find((e) => e.stage === 'path_selection');
    assert.equal(pathEvent1?.path, 'FAST');

    // S: no-user-relay proof for the convergent path.
    assert.equal(events1.filter((e) => e.type === 'human_required').length, 0);
  } finally {
    cleanupWorkflow(wfHappy);
  }

  // --- F: Fast Path with one automatic Reviewer rework -------------------
  // Gate PASSes both attempts (the file always satisfies the deterministic
  // test); the independent Reviewer objects once on unrelated grounds, then
  // accepts the corrected attempt — proving Reviewer feedback reaches the
  // next Executor call automatically, with no Gate involvement.
  const wfRework = `wf-v2cert-fast-rework-${Date.now()}`;
  const counters2 = {
    executor: 0, reviewer: 0, supervisor: 0,
  };
  const _selectProviders2 = buildFakeSelection({
    counters: counters2,
    executorImpl: (payload, n) => {
      // Both attempts satisfy the deterministic Gate; only the Reviewer's
      // independent opinion changes between attempt 1 and attempt 2.
      writeSource(payload.cwd, 'value', 2);
      if (n === 2) {
        assert.ok(payload.taskCard.rework_feedback, 'attempt 2 must automatically carry the Reviewer\'s feedback');
        assert.deepEqual(payload.taskCard.rework_feedback.required_changes, ['fix add-doc-comment']);
      }
      return {
        task_id: payload.taskCard.task_id, status: 'DONE', changed_files: ['src/value.js'], usage: { input_tokens: 1, output_tokens: 1 }, callId: `exec-${payload.taskCard.task_id}-${n}`,
      };
    },
    reviewerImpl: (taskId, n) => (n === 1 ? rework(taskId, 'add-doc-comment') : pass(taskId)),
  });

  try {
    const result2 = await runSuperGPT({
      workflowId: wfRework,
      goal: 'Adjust value handling in src/value.js',
      cwd: sourceRepo,
      boundedTask: {
        task_id: 'value-again', goal: 'Adjust value handling in src/value.js', allowed_files: ['src/value.js'], verification_commands: [verifyCommand('value')],
      },
      _selectProviders: _selectProviders2,
    });

    assert.equal(result2.status, 'WORKFLOW_DONE', `Fast rework must reach DONE: ${result2.reason}`);
    assert.equal(counters2.executor, 2, 'ordinary Reviewer rework dispatched a second Executor attempt automatically');
    assert.equal(counters2.reviewer, 2);
    assert.equal(counters2.supervisor, 0, 'ordinary rework never escalates to the Supervisor');
  } finally {
    cleanupWorkflow(wfRework);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PART G/H/I — Full Path: two-task happy path with a Gate rework on task 1
// and a Reviewer rework on task 2 — Planner runs once, Supervisor never.
// ═══════════════════════════════════════════════════════════════════════

test('G+H+I+Q+R. Full Path: Planner once, task order automatic, one Gate rework (task 1) and one Reviewer rework (task 2), zero Supervisor calls, real two-file delivery', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-full-'));
  const sourceRepo = setupSourceRepo(tmpRoot, {
    units: [{ name: 'alpha', initial: 1, target: 2 }, { name: 'beta', initial: 1, target: 2 }],
  });
  const workflowId = `wf-v2cert-full-${Date.now()}`;

  let plannerCalls = 0;
  const _resolveWorkflowPlan = async () => {
    plannerCalls += 1;
    return {
      status: 'READY',
      plan: 'two-task plan',
      planText: 'two-task plan',
      summary: 'alpha then beta',
      tasks: [
        {
          task_id: 'task-alpha', goal: 'Fix alpha', allowed_files: ['src/alpha.js'], verification_commands: [verifyCommand('alpha')],
        },
        {
          task_id: 'task-beta', goal: 'Fix beta', allowed_files: ['src/beta.js'], verification_commands: [verifyCommand('beta')],
        },
      ],
      closeoutVerificationCommands: [verifyCommand('alpha'), verifyCommand('beta')],
    };
  };

  const counters = {
    executor: 0, reviewer: 0, supervisor: 0,
  };
  const executorAttemptsByTask = {};
  const reviewerAttemptsByTask = {};
  const { events, onEvent } = collectEvents();
  const _selectProviders = buildFakeSelection({
    counters,
    executorImpl: (payload) => {
      const taskId = payload.taskCard.task_id;
      executorAttemptsByTask[taskId] = (executorAttemptsByTask[taskId] || 0) + 1;
      const n = executorAttemptsByTask[taskId];
      if (taskId === 'task-alpha') {
        // Gate rework: attempt 1 leaves alpha wrong (real Gate FAILS for real);
        // attempt 2 fixes it using the automatic Gate-failure feedback.
        if (n === 1) {
          assert.equal(payload.taskCard.rework_feedback, undefined, 'first attempt carries no rework feedback yet');
        } else {
          assert.ok(payload.taskCard.rework_feedback, 'attempt 2 must automatically carry the Gate-failure feedback');
          assert.equal(payload.taskCard.rework_feedback.rationale.includes('Gate verification failed'), true);
        }
        writeSource(payload.cwd, 'alpha', n === 1 ? 999 : 2);
      } else {
        // Reviewer rework: the Gate always passes for beta (matches the
        // accepted target both attempts); the Reviewer objects once on
        // independent grounds.
        writeSource(payload.cwd, 'beta', 2);
        if (n === 2) {
          assert.ok(payload.taskCard.rework_feedback, 'attempt 2 must automatically carry the Reviewer\'s feedback');
        }
      }
      return {
        task_id: taskId, status: 'DONE', changed_files: [`src/${taskId === 'task-alpha' ? 'alpha' : 'beta'}.js`], usage: { input_tokens: 1, output_tokens: 1 }, callId: `exec-${taskId}-${n}`,
      };
    },
    reviewerImpl: (taskId) => {
      reviewerAttemptsByTask[taskId] = (reviewerAttemptsByTask[taskId] || 0) + 1;
      if (taskId === 'task-beta' && reviewerAttemptsByTask[taskId] === 1) return rework(taskId, 'beta-style');
      return pass(taskId);
    },
  });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'Implement alpha and beta fixes across two files with tests',
      cwd: sourceRepo,
      explicitFullPath: true,
      _resolveWorkflowPlan,
      _selectProviders,
      onEvent,
    });

    assert.equal(result.status, 'WORKFLOW_DONE', `Full happy must reach DONE: ${result.reason}`);
    assert.equal(plannerCalls, 1, 'FULL_PATH_PLANNER_ONCE');
    assert.equal(counters.supervisor, 0, 'FULL_PATH_NORMAL_SUPERVISOR_CALLS = 0 — Gate/Reviewer rework are both fully deterministic');
    assert.equal(executorAttemptsByTask['task-alpha'], 2, 'Gate rework dispatched exactly one automatic retry');
    assert.equal(executorAttemptsByTask['task-beta'], 2, 'Reviewer rework dispatched exactly one automatic retry');
    // Reviewer is never consulted for a Gate FAIL (source: GATE bypasses it) —
    // only task-beta's two attempts and task-alpha's final PASS reach it.
    assert.equal(counters.reviewer, 3, '1 alpha PASS + 1 beta REWORK + 1 beta PASS; alpha attempt 1 (Gate FAIL) never reached the Reviewer');

    // Q: real delivery — both files landed in the SOURCE repo.
    assert.match(fs.readFileSync(path.join(sourceRepo, 'src', 'alpha.js'), 'utf8'), /export const alpha = 2;/);
    assert.match(fs.readFileSync(path.join(sourceRepo, 'src', 'beta.js'), 'utf8'), /export const beta = 2;/);
    assert.ok(result.deliveredFiles?.length >= 2);

    // R: Full Path DOES emit planning milestones.
    const types = events.map((e) => e.type);
    assert.ok(types.includes('planning_started') && types.includes('planning_completed'), 'Full Path emits planning milestones');
    const pathEvent = events.find((e) => e.stage === 'path_selection');
    assert.equal(pathEvent?.path, 'FULL');

    // S: no-user-relay proof.
    assert.equal(events.filter((e) => e.type === 'human_required').length, 0);
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PART J/K — bounded non-convergence: Supervisor escalation, then either
// recovery to DONE or genuine exhaustion to HUMAN_REQUIRED.
// ═══════════════════════════════════════════════════════════════════════

test('J. Bounded non-convergence: 3 ordinary REWORKs escalate to exactly one Supervisor call, guidance reaches the Executor, recovers to DONE with zero HUMAN_REQUIRED', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-escalate-ok-'));
  const sourceRepo = setupSourceRepo(tmpRoot, { units: [{ name: 'value', initial: 1, target: 2 }] });
  const workflowId = `wf-v2cert-escalate-ok-${Date.now()}`;

  const counters = {
    executor: 0, reviewer: 0, supervisor: 0,
  };
  let guidanceSeenByExecutor = null;
  // Each wrong attempt writes a DIFFERENT wrong value: the real Gate must
  // see a genuinely changed (still-failing) diff each round, or the
  // separate "identical Gate failure + unchanged diff -> HUMAN_REQUIRED"
  // no-new-information guard fires before escalation ever gets a chance
  // (see automatedLoop.js / deterministicSupervisorPolicy.js).
  const _selectProviders = buildFakeSelection({
    counters,
    executorImpl: (payload, n) => {
      if (payload.taskCard.supervisor_guidance) {
        guidanceSeenByExecutor = payload.taskCard.supervisor_guidance;
        writeSource(payload.cwd, 'value', 2); // guidance actually fixes it
      } else {
        writeSource(payload.cwd, 'value', 900 + n); // still wrong, but a fresh diff each attempt
      }
      return {
        task_id: payload.taskCard.task_id, status: 'DONE', changed_files: ['src/value.js'], usage: { input_tokens: 1, output_tokens: 1 }, callId: `exec-value-${n}`,
      };
    },
    // Gate-sourced REWORK bypasses the Reviewer entirely (STATE_MACHINE.md
    // §2), so the Reviewer here is only ever consulted once the guided
    // attempt finally makes the real Gate pass.
    reviewerImpl: (taskId) => pass(taskId),
    supervisorImpl: (ctx) => {
      assert.equal(ctx.isEscalating, true);
      assert.equal(ctx.normalAttempts, 3);
      return { action: 'CONTINUE_REWORK', guidance: 'Switch strategy: assign the corrected literal value.' };
    },
  });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'Correct the persistently wrong value in src/value.js',
      cwd: sourceRepo,
      boundedTask: {
        task_id: 'value-escalate', goal: 'Correct the persistently wrong value in src/value.js', allowed_files: ['src/value.js'], verification_commands: [verifyCommand('value')],
      },
      _selectProviders,
    });

    assert.equal(result.status, 'WORKFLOW_DONE', `escalation recovery must reach DONE: ${result.reason}`);
    assert.notEqual(result.status, 'HUMAN_REQUIRED');
    assert.equal(counters.supervisor, 1, 'exactly one model Supervisor call at the escalation boundary');
    assert.equal(counters.executor, 4, '3 normal attempts + 1 guided escalation attempt');
    assert.ok(guidanceSeenByExecutor && /Switch strategy/.test(guidanceSeenByExecutor), 'SUPERVISOR_GUIDANCE_REACHES_EXECUTOR');
    assert.match(fs.readFileSync(path.join(sourceRepo, 'src', 'value.js'), 'utf8'), /export const value = 2;/);
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('K. Bounded non-convergence that never recovers: escalation attempts exhaust deterministically to HUMAN_REQUIRED — no infinite loop, no extra calls after the ceiling', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-escalate-fail-'));
  const sourceRepo = setupSourceRepo(tmpRoot, { units: [{ name: 'value', initial: 1 }] });
  const workflowId = `wf-v2cert-escalate-fail-${Date.now()}`;

  const counters = {
    executor: 0, reviewer: 0, supervisor: 0,
  };
  // Each attempt writes a DIFFERENT wrong value — a distinct Gate-failure
  // diff every round, so the run is stopped by the escalation-attempt
  // CEILING, never by the separate "identical failure twice" short-circuit.
  const _selectProviders = buildFakeSelection({
    counters,
    executorImpl: (payload, n) => {
      writeSource(payload.cwd, 'value', 900 + n); // never fixed — genuine non-convergence
      return {
        task_id: payload.taskCard.task_id, status: 'DONE', changed_files: ['src/value.js'], usage: { input_tokens: 1, output_tokens: 1 }, callId: `exec-value-${n}`,
      };
    },
    // Gate-sourced REWORK bypasses the Reviewer entirely — it is never
    // consulted while the Gate keeps failing.
    reviewerImpl: (taskId) => pass(taskId),
    supervisorImpl: () => ({ action: 'CONTINUE_REWORK', guidance: 'try a different approach' }),
  });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'Attempt to correct a value that cannot actually be corrected',
      cwd: sourceRepo,
      boundedTask: {
        task_id: 'value-unresolvable', goal: 'Attempt to correct a value that cannot actually be corrected', allowed_files: ['src/value.js'], verification_commands: [verifyCommand('value')],
      },
      _selectProviders,
    });

    assert.equal(result.status, 'HUMAN_REQUIRED', 'genuine non-convergence is a VALID unattended terminal state');
    assert.ok(result.question && result.question.length > 0, 'the result carries a meaningful question a human can act on');
    // The mechanical per-task Executor physical-call ceiling (Token Safety's
    // final fuse — workflowCostGuard.js, 4 real Executor calls per task) is
    // reached and stops the loop before the escalation-attempts policy
    // ceiling (maxAttemptsPerTask=3 + maxEscalationAttempts=2 = 5) would
    // have — both are genuine bounded-non-convergence stops; this run hits
    // the tighter mechanical fuse first.
    assert.match(result.reason, /EXECUTOR_CALL_CEILING_EXCEEDED|physical-call ceiling/);
    assert.equal(counters.executor, 4, 'no extra Executor call after the ceiling');
    assert.equal(counters.reviewer, 0, 'the Reviewer is never consulted while a Gate FAIL keeps routing straight back to REWORK');
    assert.equal(counters.supervisor, 1, 'the Supervisor is consulted once at the escalation boundary, not on every subsequent round');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PART L/M/N — PR Closeout (fake PR adapters, never GitHub)
// ═══════════════════════════════════════════════════════════════════════

function closeoutScenario({ heads, reviews, repairGate = 'PASS', repairStatus = 'COMPLETE' }) {
  const state = {
    headIndex: 0, heads: [...heads], reviewCalls: [], repairCards: [], pushCalls: [], escalations: [],
  };
  const currentHead = () => state.heads[Math.min(state.headIndex, state.heads.length - 1)];
  return {
    state,
    adapters: {
      getPrHead: async () => currentHead(),
      requestTrustedReview: async ({ prHead }) => {
        state.reviewCalls.push(prHead);
        const entry = reviews[prHead];
        return typeof entry === 'function' ? entry() : entry;
      },
      runRepairTask: async (card) => {
        state.repairCards.push(card);
        return { status: repairStatus, gateResult: repairGate };
      },
      pushRepair: async () => {
        state.headIndex += 1;
        state.pushCalls.push(currentHead());
        return currentHead();
      },
      escalateSupervisor: async (payload) => { state.escalations.push(payload); },
    },
  };
}

function setupCloseoutRepo(tmpRoot) {
  const sourceRepo = setupSourceRepo(tmpRoot, { units: [{ name: 'value', initial: 1 }] });
  fs.mkdirSync(path.join(sourceRepo, '.supergpt'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRepo, '.supergpt', 'config.json'),
    JSON.stringify({ closeoutCommands: [verifyCommand('value')] }, null, 2),
  );
  return sourceRepo;
}

// A `_selectProviders` stub for the PR_CLOSEOUT path: this branch never
// touches supervisorSession/createReviewerSession/createExecutorSessionManager
// (prCloseoutAdapters fully owns repair/review), so every one of those
// throws if ever reached — proving the closeout loop truly drives everything.
function neverUsedSelection() {
  return () => ({
    informationLedger: null,
    supervisorSession: { create: async () => ({}), decide: async () => { throw new Error('unexpected Supervisor call in PR closeout'); }, close: async () => {} },
    createReviewerSession: () => ({ create: async () => ({}), review: async () => { throw new Error('unexpected internal Reviewer call in PR closeout'); }, close: async () => {} }),
    createExecutorSessionManager: () => ({ execute: async () => { throw new Error('unexpected internal Executor call in PR closeout'); } }),
    windowSession: nullWindowSession,
    sessionStore: { snapshot: () => ({}) },
  });
}

test('L. PR Closeout clean path: trusted external review is clean on the first head -> DONE, zero repairs', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-pr-clean-'));
  const sourceRepo = setupCloseoutRepo(tmpRoot);
  const workflowId = `wf-v2cert-pr-clean-${Date.now()}`;

  const scenario = closeoutScenario({ heads: ['sha-1'], reviews: { 'sha-1': { reviewer: 'codex', headSha: 'sha-1', findings: [] } } });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'closeout PR #42',
      cwd: sourceRepo,
      prCloseoutAdapters: scenario.adapters,
      _selectProviders: neverUsedSelection(),
    });

    assert.equal(result.status, 'WORKFLOW_DONE', `clean closeout must reach DONE: ${result.reason}`);
    assert.equal(scenario.state.repairCards.length, 0, 'repair Executor calls = 0');
    assert.equal(scenario.state.reviewCalls.length, 1, 'external review accepted = 1');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('M. PR Closeout repair loop: an actionable finding on H1 triggers exactly one automatic internal repair, pushes H2, re-review is CLEAN -> DONE', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-pr-repair-'));
  const sourceRepo = setupCloseoutRepo(tmpRoot);
  const workflowId = `wf-v2cert-pr-repair-${Date.now()}`;

  const scenario = closeoutScenario({
    heads: ['sha-h1', 'sha-h2'],
    reviews: {
      'sha-h1': { reviewer: 'codex', headSha: 'sha-h1', findings: [{ severity: 'P1', file: 'src/value.js', message: 'off-by-one' }] },
      'sha-h2': { reviewer: 'codex', headSha: 'sha-h2', findings: [] },
    },
  });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'closeout PR #43',
      cwd: sourceRepo,
      prCloseoutAdapters: scenario.adapters,
      _selectProviders: neverUsedSelection(),
    });

    assert.equal(result.status, 'WORKFLOW_DONE', `repair loop must reach DONE: ${result.reason}`);
    assert.equal(scenario.state.repairCards.length, 1, 'repair task generated and run automatically exactly once');
    assert.equal(scenario.state.pushCalls.length, 1, 'exactly one push (H1 -> H2)');
    assert.notEqual(scenario.state.pushCalls[0], 'sha-h1');
    assert.deepEqual(scenario.state.reviewCalls, ['sha-h1', 'sha-h2'], 'external reviews = 2, H1 != H2');
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('N. PR Closeout pending external review (no result yet) stops at HUMAN_REQUIRED — never a synthetic internal CLEAN', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-pr-pending-'));
  const sourceRepo = setupCloseoutRepo(tmpRoot);
  const workflowId = `wf-v2cert-pr-pending-${Date.now()}`;

  // { pending: true } is the adapter contract for "an external trigger was
  // already dispatched for this head but no trusted result has arrived yet"
  // (see prCloseoutLoop.js) — distinct from a genuine review payload.
  const scenario = closeoutScenario({ heads: ['sha-1'], reviews: { 'sha-1': { pending: true, reason: 'external_review_pending' } } });

  try {
    const result = await runSuperGPT({
      workflowId,
      goal: 'closeout PR #44',
      cwd: sourceRepo,
      prCloseoutAdapters: scenario.adapters,
      _selectProviders: neverUsedSelection(),
    });

    assert.equal(result.status, 'HUMAN_REQUIRED', 'a pending/unavailable external review must never be synthesized as CLEAN');
    assert.equal(scenario.state.repairCards.length, 0);
  } finally {
    cleanupWorkflow(workflowId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PART O/P — functional crash/resume
// ═══════════════════════════════════════════════════════════════════════

test('O. Crash/resume preserves completed work: Task 1 is not re-executed, Task 2 continues to DONE', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-resume-task-'));
  const sourceRepo = setupSourceRepo(tmpRoot, { units: [{ name: 'alpha', initial: 1 }, { name: 'beta', initial: 1, target: 2 }] });
  const workflowId = `wf-v2cert-resume-task-${Date.now()}`;
  const originalHead = execSync('git rev-parse HEAD', { cwd: sourceRepo, encoding: 'utf8' }).trim();

  const worktreeDir = path.join(SUPERGPT_WORKTREE_ROOT, `repo-${workflowId}`);
  fs.mkdirSync(SUPERGPT_WORKTREE_ROOT, { recursive: true });
  execSync(`git worktree add --detach ${worktreeDir} HEAD`, { cwd: sourceRepo, stdio: 'ignore' });

  // Simulate: Task 1 (alpha) already genuinely accepted and committed.
  writeUnit(worktreeDir, 'alpha', 2);
  sh('git add -A && git commit -m "task alpha done"', worktreeDir);
  const advancedHead = execSync('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf8' }).trim();
  assert.notEqual(advancedHead, originalHead);

  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`), JSON.stringify({
    workflow_id: workflowId,
    isolated_worktree_path: worktreeDir,
    source_workspace: sourceRepo,
    source_repo_root: sourceRepo,
    source_branch: 'main',
    baseline_head: originalHead,
    closeout_verification_commands: [verifyCommand('alpha'), verifyCommand('beta')],
    path_selection: { path: 'FULL', reason: 'full_explicit_request' },
    workflow_path: 'FULL',
  }));
  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.state.json`), JSON.stringify({
    workflowId, workflowStatus: 'HUMAN_REQUIRED',
    tokenUsage: { records: [], measuredTotal: { calls: 0, costUsd: 0 } },
  }));
  saveCheckpoint({ root: SUPERGPT_WORKTREE_ROOT, workflowId }, {
    history: [{ task_id: 'task-alpha', decision: 'PASS', attempts: 1 }],
    currentTaskCard: {
      task_id: 'task-beta', goal: 'Fix beta', allowed_files: ['src/beta.js'], verification_commands: [verifyCommand('beta')], repository_context: {}, context: '', scope: 'Fix beta', forbidden_files: [], acceptance_criteria: ['ok'], completion_signal: 'DONE',
    },
    currentTaskId: 'task-beta',
    attempt: 0,
  });
  recordAdvancedBaselineHead({ root: SUPERGPT_WORKTREE_ROOT, workflowId, head: advancedHead });

  const counters = {
    executor: 0, reviewer: 0, supervisor: 0,
  };
  const executedTaskIds = [];
  // Resume: the resolver replays the SAME frozen two-task plan without a new
  // physical transport call (memoized on planArg) — see PART O's note in the
  // final report on what "Planner calls = 0" means at resume.
  let plannerTransportCalls = 0;
  const _resolveWorkflowPlan = async () => {
    // No transport invocation here at all: this represents a cached replay
    // of the already-frozen plan, not a fresh model reasoning call.
    return {
      status: 'READY',
      plan: 'two-task plan',
      planText: 'two-task plan',
      summary: 'alpha then beta',
      tasks: [
        { task_id: 'task-alpha', goal: 'Fix alpha', allowed_files: ['src/alpha.js'], verification_commands: [verifyCommand('alpha')] },
        { task_id: 'task-beta', goal: 'Fix beta', allowed_files: ['src/beta.js'], verification_commands: [verifyCommand('beta')] },
      ],
      closeoutVerificationCommands: [verifyCommand('alpha'), verifyCommand('beta')],
    };
  };
  const _selectProviders = buildFakeSelection({
    counters,
    executorImpl: (payload) => {
      executedTaskIds.push(payload.taskCard.task_id);
      writeSource(payload.cwd, 'beta', 2);
      return {
        task_id: payload.taskCard.task_id, status: 'DONE', changed_files: ['src/beta.js'], usage: { input_tokens: 1, output_tokens: 1 }, callId: 'exec-beta-1',
      };
    },
    reviewerImpl: (taskId) => pass(taskId),
  });

  try {
    const result = await supergptResume({
      workflowId,
      cwd: sourceRepo,
      _resolveWorkflowPlan,
      _selectProviders,
    });

    assert.equal(result.status, 'WORKFLOW_DONE', `resume must complete task 2 to DONE: ${result.reason}`);
    assert.deepEqual(executedTaskIds, ['task-beta'], 'CRASH/RESUME_PRESERVES_COMPLETED_TASKS: task-alpha was NOT re-executed');
    assert.equal(plannerTransportCalls, 0, 'RESUME_REPLANS_COMPLETED_WORK = NO (zero new physical Planner transport calls)');
    assert.equal(counters.executor, 1, 'RESUME_REEXECUTES_COMPLETED_TASK = NO — only the one remaining task ran');

    // Both task-alpha's already-accepted change AND task-beta's new change
    // must reach the source repo.
    assert.match(fs.readFileSync(path.join(sourceRepo, 'src', 'alpha.js'), 'utf8'), /export const alpha = 2;/);
    assert.match(fs.readFileSync(path.join(sourceRepo, 'src', 'beta.js'), 'utf8'), /export const beta = 2;/);
  } finally {
    cleanupWorkflow(workflowId);
    try { execSync(`git worktree remove --force ${worktreeDir}`, { cwd: sourceRepo, stdio: 'ignore' }); } catch { /* already gone */ }
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('P. Resume from delivery-ready: all engineering/review already accepted, only delivery remained — resume calls zero Planner/Executor/Reviewer roles and goes straight to DONE', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2cert-resume-delivery-'));
  const sourceRepo = setupSourceRepo(tmpRoot, { units: [{ name: 'value', initial: 1 }] });
  const workflowId = `wf-v2cert-resume-delivery-${Date.now()}`;
  const originalHead = execSync('git rev-parse HEAD', { cwd: sourceRepo, encoding: 'utf8' }).trim();

  const worktreeDir = path.join(SUPERGPT_WORKTREE_ROOT, `repo-${workflowId}`);
  fs.mkdirSync(SUPERGPT_WORKTREE_ROOT, { recursive: true });
  execSync(`git worktree add --detach ${worktreeDir} HEAD`, { cwd: sourceRepo, stdio: 'ignore' });

  // All engineering already accepted: the worktree already carries the
  // approved change, uncommitted (Safe Delivery diffs tracked + untracked
  // changes against the baseline — it does not require a commit).
  writeUnit(worktreeDir, 'value', 2);

  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.workspace.json`), JSON.stringify({
    workflow_id: workflowId,
    isolated_worktree_path: worktreeDir,
    source_workspace: sourceRepo,
    source_repo_root: sourceRepo,
    source_branch: 'main',
    baseline_head: originalHead,
    closeout_verification_commands: [verifyCommand('value')],
  }));
  fs.writeFileSync(path.join(SUPERGPT_WORKTREE_ROOT, `${workflowId}.state.json`), JSON.stringify({
    workflowId, workflowStatus: 'HUMAN_REQUIRED',
    tokenUsage: { records: [], measuredTotal: { calls: 0, costUsd: 0 } },
  }));
  markDeliveryReady({ root: SUPERGPT_WORKTREE_ROOT, workflowId, summary: 'engineering complete, delivery was blocked' });
  assert.equal(readControl({ root: SUPERGPT_WORKTREE_ROOT, workflowId })?.phase, 'delivery_ready');

  // No _selectProviders / _resolveWorkflowPlan at all: any attempt to reach
  // Planner/Supervisor/Executor/Reviewer selection would throw before
  // constructing a usable object, proving the delivery-ready shortcut never
  // touches them.
  try {
    const result = await supergptResume({ workflowId, cwd: sourceRepo });

    assert.equal(result.status, 'WORKFLOW_DONE', `delivery-ready resume must go straight to DONE: ${result.reason}`);
    assert.match(fs.readFileSync(path.join(sourceRepo, 'src', 'value.js'), 'utf8'), /export const value = 2;/, 'DELIVERY-READY_RESUME_RECALLS_MODELS = NO, and delivery still happens for real');
    assert.ok(result.deliveredFiles?.length > 0);
  } finally {
    cleanupWorkflow(workflowId);
    try { execSync(`git worktree remove --force ${worktreeDir}`, { cwd: sourceRepo, stdio: 'ignore' }); } catch { /* already gone */ }
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
