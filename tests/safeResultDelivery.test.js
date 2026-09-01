// Safe Result Delivery gated on controlled Host Acceptance (matrix I and J).
//
// A normal DONE workflow delivers automatically into the invocation workspace
// when Gate, Reviewer, the active acceptance version and the worktree evidence
// all agree — and never delivers when any of them drifts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  deliverWorkflowResult,
  createResultDelivery,
  evaluateDeliveryReadiness,
  computeDeliveryId,
  DELIVERY_BLOCK_REASONS,
} from '../src/orchestrator/resultDelivery.js';
import {
  CONTROLLED_ACCEPTANCE_INVALID_REASONS,
  buildControlledHostAcceptance,
  hashControlledHostAcceptance,
} from '../src/orchestrator/hostVerification.js';

const WORKFLOW_ID = 'wf-safe-delivery-0001';
const WT = '/managed/repo-wf-safe-delivery-0001';
const SRC = '/src/repo';
const BASE = 'base1111111111111111111111111111111111111';
const HEAD = 'head222222222222222222222222222222222222';
const FINGERPRINT = '9'.repeat(64);
const COMMANDS = ['npm test'];
const PATCH = 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n';

const WORKTREE = Object.freeze({
  worktree_path: WT,
  baseline_head: BASE,
  source_workspace: SRC,
  source_repo_root: SRC,
});

function acceptance(overrides = {}) {
  return buildControlledHostAcceptance({
    workflowId: WORKFLOW_ID,
    worktree: WT,
    head: HEAD,
    worktreeFingerprint: FINGERPRINT,
    verificationCommands: COMMANDS,
    gate: 'PASS',
    reviewer: 'PASS',
    acceptanceVersion: 1,
    approvedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function context(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    head: HEAD,
    worktreeFingerprint: FINGERPRINT,
    acceptanceVersion: 1,
    verificationCommands: COMMANDS,
    ...overrides,
  };
}

// A `git` stub describing a clean, deliverable workflow: one tracked edit, one
// new file, an invocation workspace that has not moved since the snapshot.
function cleanGit() {
  const calls = [];
  const spawn = (command, args, opts) => {
    calls.push({ argstr: args.join(' '), cwd: opts?.cwd });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const argstr = args.join(' ');
    queueMicrotask(() => {
      let stdout = '';
      if (argstr.startsWith('diff --name-status')) stdout = 'M\tsrc/a.js\n';
      else if (argstr.startsWith('diff --full-index')) stdout = PATCH;
      else if (argstr.startsWith('ls-files --others')) stdout = 'src/new.js\n';
      // Only the tracked file exists in the invocation snapshot; the new file
      // is absent there and absent on disk, so it is a clean creation.
      else if (argstr.startsWith('ls-tree')) {
        stdout = args[args.length - 1] === 'src/a.js' ? '100644 blob snapshotsha\tsrc/a.js\n' : '';
      }
      else if (argstr.startsWith('hash-object')) stdout = 'snapshotsha\n';
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, calls };
}

// The invocation workspace still holds the snapshot bytes of the edited file
// and does not yet hold the new file; the worktree holds both.
function fsStub({ existing = [] } = {}) {
  const existingSet = new Set([
    ...existing,
    `${WT}/src`,
    `${WT}/src/new.js`,
    `${SRC}/src`,
    `${SRC}/src/a.js`,
  ]);
  const copies = [];
  return {
    copies,
    fs: {
      existsSync: (p) => existingSet.has(p),
      lstatSync(p) {
        if (!existingSet.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        return { isSymbolicLink: () => false, isDirectory: () => false };
      },
      writeFileSync() {},
      copyFileSync: (src, dst) => copies.push({ src, dst }),
      mkdirSync() {},
      rmSync() {},
    },
  };
}

function subject(overrides = {}) {
  const { spawn, calls } = cleanGit();
  const { fs, copies } = fsStub(overrides.fsOptions ?? {});
  const delivery = createResultDelivery({ spawn, fs, now: () => 1 });
  return { delivery, calls, copies };
}

// --- J: a normal DONE workflow delivers automatically ----------------------

test('J: valid acceptance evidence delivers to the invocation workspace without asking the user', async () => {
  const { delivery, copies } = subject();
  const delivered = [];
  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: acceptance(),
    expectedAcceptanceContext: context(),
    requireControlledAcceptance: true,
    onDelivered: (record) => delivered.push(record),
  });

  assert.equal(result.status, 'DELIVERED');
  assert.deepEqual(result.changed_files, ['src/a.js', 'src/new.js']);
  assert.equal(result.worktree_preserved, false);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].dst, `${SRC}/src/new.js`);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].delivery_id, result.delivery_id);
  assert.match(result.delivery_id, /^dlv-[0-9a-f]{16}$/);
});

test('J: the delivery id is deterministic for the same workflow, evidence and baseline', () => {
  const a = acceptance();
  const first = computeDeliveryId({ workflowId: WORKFLOW_ID, acceptanceHash: a.hash, baselineHead: BASE });
  const second = computeDeliveryId({ workflowId: WORKFLOW_ID, acceptanceHash: a.hash, baselineHead: BASE });
  const other = computeDeliveryId({ workflowId: WORKFLOW_ID, acceptanceHash: a.hash, baselineHead: 'other' });
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('J: a repeated terminal handling of an already-delivered workflow does not re-apply', async () => {
  const { delivery, copies, calls } = subject();
  const a = acceptance();
  const priorDelivery = {
    status: 'DELIVERED',
    delivery_id: computeDeliveryId({ workflowId: WORKFLOW_ID, acceptanceHash: a.hash, baselineHead: BASE }),
    changed_files: ['src/a.js', 'src/new.js'],
    cleanup: { status: 'OK' },
  };
  const delivered = [];

  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: a,
    expectedAcceptanceContext: context(),
    requireControlledAcceptance: true,
    priorDelivery,
    onDelivered: (record) => delivered.push(record),
  });

  assert.equal(result.status, 'ALREADY_DELIVERED');
  assert.equal(result.idempotent, true);
  assert.deepEqual(result.changed_files, ['src/a.js', 'src/new.js']);
  assert.equal(result.worktree_preserved, false);
  assert.equal(copies.length, 0, 'no bytes may be re-applied');
  assert.equal(delivered.length, 0, 'no second delivery record');
  assert.equal(calls.length, 0, 'no git work for an already-delivered workflow');
});

// --- I: fail-closed on missing / drifted evidence --------------------------

test('I: delivery is refused when the acceptance evidence is missing', async () => {
  const { delivery, copies, calls } = subject();
  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: null,
    expectedAcceptanceContext: context(),
    requireControlledAcceptance: true,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blocked_reason, DELIVERY_BLOCK_REASONS.ACCEPTANCE_EVIDENCE_MISSING);
  assert.equal(result.worktree_preserved, true);
  assert.deepEqual(result.changed_files, []);
  assert.equal(copies.length, 0);
  assert.equal(calls.length, 0, 'the workspace must not be touched at all');
});

test('I: worktree fingerprint drift blocks delivery', async () => {
  const { delivery, copies } = subject();
  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: acceptance(),
    expectedAcceptanceContext: context({ worktreeFingerprint: '0'.repeat(64) }),
    requireControlledAcceptance: true,
  });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blocked_reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_DRIFT);
  assert.equal(result.worktree_preserved, true);
  assert.equal(copies.length, 0);
});

test('I: HEAD drift blocks delivery', async () => {
  const { delivery } = subject();
  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: acceptance(),
    expectedAcceptanceContext: context({ head: 'moved' }),
    requireControlledAcceptance: true,
  });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blocked_reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.HEAD_DRIFT);
});

test('I: an acceptance amendment after the evidence was cut blocks delivery', async () => {
  const { delivery } = subject();
  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: acceptance(),
    expectedAcceptanceContext: context({ acceptanceVersion: 2 }),
    requireControlledAcceptance: true,
  });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blocked_reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.ACCEPTANCE_VERSION_DRIFT);
});

test('I: forged evidence claiming a passing Reviewer is rejected', async () => {
  const forged = { ...acceptance(), reviewer: { pass: false, decision: 'REWORK' } };
  forged.hash = hashControlledHostAcceptance(forged);
  const { delivery } = subject();
  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: forged,
    expectedAcceptanceContext: context(),
    requireControlledAcceptance: true,
  });
  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blocked_reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.REVIEWER_NOT_PASSED);
});

test('I: a conflicting invocation workspace still fails closed even with valid evidence', async () => {
  const { spawn } = (() => {
    const base = cleanGit();
    const spawnWithConflict = (command, args, opts) => {
      const argstr = args.join(' ');
      if (argstr.startsWith('hash-object')) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('userEditedSha\n'));
          child.emit('close', 0);
        });
        return child;
      }
      return base.spawn(command, args, opts);
    };
    return { spawn: spawnWithConflict };
  })();
  const { fs, copies } = fsStub({ existing: [`${SRC}/src/a.js`] });
  const delivery = createResultDelivery({ spawn, fs, now: () => 1 });

  const result = await deliverWorkflowResult({
    worktree: WORKTREE,
    delivery,
    controlledAcceptance: acceptance(),
    expectedAcceptanceContext: context(),
    requireControlledAcceptance: true,
  });

  assert.equal(result.status, 'HUMAN_REQUIRED');
  assert.equal(result.blocked_reason, undefined, 'a workspace conflict is not an evidence failure');
  assert.ok(result.conflicts.some((c) => c.reason === 'overlapping-edit'));
  assert.equal(result.worktree_preserved, true);
  assert.equal(copies.length, 0);
});

// --- readiness policy ------------------------------------------------------

test('readiness: evidence is optional only when the caller explicitly opts out', () => {
  assert.equal(evaluateDeliveryReadiness({ requireControlledAcceptance: false }).deliverable, true);
  const required = evaluateDeliveryReadiness({ expected: context() });
  assert.equal(required.deliverable, false);
  assert.equal(required.reason, DELIVERY_BLOCK_REASONS.ACCEPTANCE_EVIDENCE_MISSING);
});

test('readiness: a matching bundle is admitted and returned as the delivery authority', () => {
  const a = acceptance();
  const readiness = evaluateDeliveryReadiness({ controlledAcceptance: a, expected: context() });
  assert.equal(readiness.deliverable, true);
  assert.equal(readiness.reason, null);
  assert.equal(readiness.acceptance.acceptanceId, a.acceptanceId);
});

test('readiness: an unobserved HEAD does not silently satisfy the HEAD binding', () => {
  const expected = context();
  delete expected.head;
  const readiness = evaluateDeliveryReadiness({ controlledAcceptance: acceptance(), expected });
  // The caller observed no HEAD at all, so the remaining bindings still decide.
  assert.equal(readiness.deliverable, true);

  const observedNull = evaluateDeliveryReadiness({
    controlledAcceptance: acceptance(),
    expected: context({ head: null }),
  });
  assert.equal(observedNull.deliverable, false);
  assert.equal(observedNull.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.HEAD_DRIFT);
});
