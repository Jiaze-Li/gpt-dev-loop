// Controlled Host Acceptance (matrix H) and its consumption by the terminal
// acceptance judgement, the timeline and the control service (matrix I).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONTROLLED_ACCEPTANCE_STATUS,
  CONTROLLED_ACCEPTANCE_INVALID_REASONS,
  CONTROLLED_ACCEPTANCE_APPROVERS,
  ControlledAcceptanceError,
  buildControlledHostAcceptance,
  validateControlledHostAcceptance,
  persistControlledHostAcceptance,
  readControlledHostAcceptance,
  getValidControlledHostAcceptance,
  getControlledAcceptancePath,
  hashControlledHostAcceptance,
  hashCommandSet,
} from '../src/orchestrator/hostVerification.js';
import { generateTerminalAcceptanceReport } from '../src/orchestrator/workflowState.js';
import { deriveWorkflowTimeline } from '../src/dashboard/timeline.js';

const WORKFLOW_ID = 'wf-controlled-acceptance-0001';
const HEAD = 'a'.repeat(40);
const FINGERPRINT = 'f'.repeat(64);
const COMMANDS = ['npm test', 'npm run doctor'];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'supergpt-controlled-'));
  return root;
}

function bundle(overrides = {}) {
  return buildControlledHostAcceptance({
    workflowId: WORKFLOW_ID,
    worktree: '/managed/repo-wf-controlled-acceptance-0001',
    head: HEAD,
    worktreeFingerprint: FINGERPRINT,
    verificationCommands: COMMANDS,
    gate: { pass: true, decision: 'PASS' },
    reviewer: { pass: true, decision: 'PASS' },
    acceptanceVersion: 2,
    approvedBy: CONTROLLED_ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR,
    approvedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function liveContext(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    head: HEAD,
    worktreeFingerprint: FINGERPRINT,
    acceptanceVersion: 2,
    verificationCommands: COMMANDS,
    ...overrides,
  };
}

// --- H: the evidence bundle binds every required fact ----------------------

test('H: a controlled acceptance bundle binds workflow, worktree, commands, Gate, Reviewer and acceptance version', () => {
  const b = bundle();
  assert.equal(b.status, CONTROLLED_ACCEPTANCE_STATUS);
  assert.equal(b.workflowId, WORKFLOW_ID);
  assert.equal(b.head, HEAD);
  assert.equal(b.worktreeFingerprint, FINGERPRINT);
  assert.deepEqual(b.verificationCommands, COMMANDS);
  assert.equal(b.commandsHash, hashCommandSet(COMMANDS));
  assert.equal(b.gate.pass, true);
  assert.equal(b.reviewer.pass, true);
  assert.equal(b.acceptanceVersion, 2);
  assert.equal(b.approvedBy, CONTROLLED_ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR);
  assert.match(b.acceptanceId, /^cha-[0-9a-f]{16}$/);
  assert.equal(b.hash, hashControlledHostAcceptance(b));
});

test('H: a bundle cannot be minted without a passing Gate', () => {
  assert.throws(
    () => bundle({ gate: { pass: false, decision: 'FAIL' } }),
    (err) => err instanceof ControlledAcceptanceError
      && err.code === CONTROLLED_ACCEPTANCE_INVALID_REASONS.GATE_NOT_PASSED,
  );
});

test('H: a bundle cannot be minted without a passing Reviewer', () => {
  assert.throws(
    () => bundle({ reviewer: { decision: 'REWORK' } }),
    (err) => err.code === CONTROLLED_ACCEPTANCE_INVALID_REASONS.REVIEWER_NOT_PASSED,
  );
});

test('H: a bundle cannot be minted without an approved acceptance version', () => {
  assert.throws(
    () => bundle({ acceptanceVersion: undefined }),
    (err) => err.code === CONTROLLED_ACCEPTANCE_INVALID_REASONS.ACCEPTANCE_VERSION_DRIFT,
  );
});

test('H: a bundle cannot be minted without a real worktree fingerprint', () => {
  assert.throws(
    () => bundle({ worktreeFingerprint: null }),
    (err) => err.code === CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_UNAVAILABLE,
  );
});

test('H: an Executor-level approver cannot mint controlled acceptance', () => {
  assert.throws(
    () => bundle({ approvedBy: 'EXECUTOR' }),
    (err) => err.code === CONTROLLED_ACCEPTANCE_INVALID_REASONS.MALFORMED,
  );
});

test('H: HUMAN_REQUIRED is an authorized approver', () => {
  const b = bundle({ approvedBy: CONTROLLED_ACCEPTANCE_APPROVERS.HUMAN_REQUIRED });
  assert.equal(validateControlledHostAcceptance({ bundle: b, ...liveContext() }).valid, true);
});

// --- I: drift and tampering invalidate the evidence ------------------------

test('I: matching live context validates', () => {
  const result = validateControlledHostAcceptance({ bundle: bundle(), ...liveContext() });
  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(result.status, CONTROLLED_ACCEPTANCE_STATUS);
});

test('I: worktree fingerprint drift invalidates the evidence', () => {
  const result = validateControlledHostAcceptance({
    bundle: bundle(),
    ...liveContext({ worktreeFingerprint: 'e'.repeat(64) }),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_DRIFT);
});

test('I: HEAD drift invalidates the evidence', () => {
  const result = validateControlledHostAcceptance({ bundle: bundle(), ...liveContext({ head: 'b'.repeat(40) }) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.HEAD_DRIFT);
});

test('I: an unreadable worktree HEAD is drift, not an implicit pass', () => {
  const result = validateControlledHostAcceptance({ bundle: bundle(), ...liveContext({ head: null }) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.HEAD_DRIFT);
});

test('I: acceptance version drift invalidates the evidence', () => {
  const result = validateControlledHostAcceptance({ bundle: bundle(), ...liveContext({ acceptanceVersion: 3 }) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.ACCEPTANCE_VERSION_DRIFT);
});

test('I: a different command set invalidates the evidence', () => {
  const result = validateControlledHostAcceptance({
    bundle: bundle(),
    ...liveContext({ verificationCommands: ['npm test'] }),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.COMMANDS_MISMATCH);
});

test('I: another workflow cannot consume the evidence', () => {
  const result = validateControlledHostAcceptance({
    bundle: bundle(),
    ...liveContext({ workflowId: 'wf-other-0002' }),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.WORKFLOW_MISMATCH);
});

test('I: tampering with a persisted bundle is rejected by the integrity hash', () => {
  const tampered = { ...bundle(), acceptanceVersion: 99 };
  const result = validateControlledHostAcceptance({ bundle: tampered, ...liveContext({ acceptanceVersion: 99 }) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.HASH_MISMATCH);
});

test('I: a Gate result downgraded after minting is rejected', () => {
  const forged = { ...bundle(), gate: { pass: false, decision: 'FAIL' } };
  forged.hash = hashControlledHostAcceptance(forged);
  const result = validateControlledHostAcceptance({ bundle: forged, ...liveContext() });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.GATE_NOT_PASSED);
});

test('I: missing evidence is reported, never assumed valid', () => {
  const result = validateControlledHostAcceptance({ bundle: null, ...liveContext() });
  assert.equal(result.valid, false);
  assert.equal(result.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.MISSING);
});

// --- persistence + recovery ------------------------------------------------

test('persistence: the bundle round-trips and re-validates after a restart', () => {
  const root = makeRoot();
  try {
    const b = bundle();
    persistControlledHostAcceptance({ workflowId: WORKFLOW_ID, bundle: b, root });
    assert.ok(existsSync(getControlledAcceptancePath(WORKFLOW_ID, root)));

    const restored = readControlledHostAcceptance({ workflowId: WORKFLOW_ID, root });
    assert.deepEqual(restored, JSON.parse(JSON.stringify(b)));
    assert.equal(validateControlledHostAcceptance({ bundle: restored, ...liveContext() }).valid, true);

    // The per-id copy is written too, so the decision stays auditable.
    const byId = JSON.parse(readFileSync(path.join(root, WORKFLOW_ID, 'host_evidence', `${b.acceptanceId}.json`), 'utf8'));
    assert.equal(byId.hash, b.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistence: a corrupted bundle file reads as absent rather than throwing', () => {
  const root = makeRoot();
  try {
    mkdirSync(path.join(root, WORKFLOW_ID, 'host_evidence'), { recursive: true });
    writeFileSync(getControlledAcceptancePath(WORKFLOW_ID, root), '{not json', 'utf8');
    assert.equal(readControlledHostAcceptance({ workflowId: WORKFLOW_ID, root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery: getValidControlledHostAcceptance re-reads the live worktree and detects drift', () => {
  const root = makeRoot();
  try {
    const worktree = path.join(root, `${WORKFLOW_ID}-tree`);
    mkdirSync(worktree, { recursive: true });

    let currentHead = HEAD;
    const execSync = (cmd) => {
      if (cmd.includes('rev-parse')) return `${currentHead}\n`;
      if (cmd.includes('ls-files')) return '';
      if (cmd.includes('status')) return Buffer.from('');
      return '';
    };

    // Fingerprint is computed from the real helper against an empty tree, so
    // mint the bundle from that same observation.
    const observed = getValidControlledHostAcceptance({ workflowId: WORKFLOW_ID, root, execSync });
    assert.equal(observed.valid, false);
    assert.equal(observed.reason, CONTROLLED_ACCEPTANCE_INVALID_REASONS.MISSING);

    persistControlledHostAcceptance({
      workflowId: WORKFLOW_ID,
      root,
      bundle: buildControlledHostAcceptance({
        workflowId: WORKFLOW_ID,
        worktree,
        head: HEAD,
        worktreeFingerprint: FINGERPRINT,
        verificationCommands: COMMANDS,
        gate: 'PASS',
        reviewer: 'PASS',
        acceptanceVersion: 1,
      }),
    });

    // The live fingerprint (computed from the empty stub tree) cannot match the
    // recorded one, so evidence fails closed rather than authorising delivery.
    const drifted = getValidControlledHostAcceptance({ workflowId: WORKFLOW_ID, root, execSync, acceptanceVersion: 1 });
    assert.equal(drifted.valid, false);
    assert.ok([
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_DRIFT,
      CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_UNAVAILABLE,
    ].includes(drifted.reason));

    // An acceptance amendment after the fact is drift as well.
    currentHead = 'c'.repeat(40);
    const amended = getValidControlledHostAcceptance({ workflowId: WORKFLOW_ID, root, execSync, acceptanceVersion: 2 });
    assert.equal(amended.valid, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- terminal judgement consumes the evidence ------------------------------

function terminalState(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    workflowStatus: 'DONE',
    stage: 'DONE',
    activeProcesses: [],
    taskAttempts: [],
    taskHistory: [],
    summary: 'done',
    ...overrides,
  };
}

test('terminal: valid controlled acceptance reports ACCEPTANCE_SUPERSEDED_BY_HOST_VERIFICATION', () => {
  const report = generateTerminalAcceptanceReport({
    workflowId: WORKFLOW_ID,
    state: terminalState(),
    controlledAcceptance: { valid: true, bundle: bundle() },
  });
  assert.equal(report.acceptance, 'ACCEPTANCE_SUPERSEDED_BY_HOST_VERIFICATION');
  assert.equal(report.valid, true);
  assert.equal(report.controlledAcceptance.acceptanceVersion, 2);
});

test('terminal: drifted controlled acceptance fails the terminal judgement closed', () => {
  const report = generateTerminalAcceptanceReport({
    workflowId: WORKFLOW_ID,
    state: terminalState(),
    controlledAcceptance: {
      valid: false,
      reason: CONTROLLED_ACCEPTANCE_INVALID_REASONS.FINGERPRINT_DRIFT,
    },
  });
  assert.equal(report.acceptance, 'ACCEPTANCE_EVIDENCE_INCONSISTENT');
  assert.equal(report.valid, false);
  assert.equal(report.report, null);
  assert.match(report.violations[0], /WORKTREE_FINGERPRINT_DRIFT/);
});

test('terminal: a workflow without controlled acceptance keeps the plain PASS judgement', () => {
  const report = generateTerminalAcceptanceReport({ workflowId: WORKFLOW_ID, state: terminalState() });
  assert.equal(report.acceptance, 'PASS');
  assert.equal(report.valid, true);
  assert.equal(report.controlledAcceptance, undefined);
});

test('terminal: a non-terminal workflow is never accepted even with valid evidence', () => {
  const report = generateTerminalAcceptanceReport({
    workflowId: WORKFLOW_ID,
    state: terminalState({ workflowStatus: 'RUNNING', stage: 'EXECUTOR' }),
    controlledAcceptance: { valid: true, bundle: bundle() },
  });
  assert.equal(report.acceptance, 'ACCEPTANCE_NOT_TERMINAL');
  assert.equal(report.valid, false);
});

// --- auditability ----------------------------------------------------------

test('timeline: the controlled acceptance decision surfaces as an auditable milestone', () => {
  const b = bundle();
  const events = deriveWorkflowTimeline({
    workflowId: WORKFLOW_ID,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastProgressAt: '2026-01-01T00:10:00.000Z',
    workflowStatus: 'DONE',
    stageHistory: [],
    taskAttempts: [],
    controlledAcceptance: {
      status: b.status,
      acceptanceId: b.acceptanceId,
      acceptanceVersion: b.acceptanceVersion,
      worktreeFingerprint: b.worktreeFingerprint,
      gate: b.gate,
      reviewer: b.reviewer,
      approvedBy: b.approvedBy,
      approvedAt: b.approvedAt,
    },
  });
  const milestone = events.find((e) => e.type === 'CONTROLLED_ACCEPTANCE');
  assert.ok(milestone, 'expected a CONTROLLED_ACCEPTANCE milestone');
  assert.match(milestone.label, /ACCEPTANCE_SUPERSEDED_BY_HOST_VERIFICATION \(acceptance v2\)/);
  assert.match(milestone.detail, /Gate PASS/);
  assert.match(milestone.detail, /Reviewer PASS/);
  assert.match(milestone.detail, /approved by CONTROLLED_ORCHESTRATOR/);
});

test('timeline: a workflow without controlled acceptance emits no such milestone', () => {
  const events = deriveWorkflowTimeline({
    workflowId: WORKFLOW_ID,
    startedAt: '2026-01-01T00:00:00.000Z',
    workflowStatus: 'DONE',
    stageHistory: [],
    taskAttempts: [],
  });
  assert.equal(events.some((e) => e.type === 'CONTROLLED_ACCEPTANCE'), false);
});
