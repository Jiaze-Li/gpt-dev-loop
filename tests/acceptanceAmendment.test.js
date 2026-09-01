import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createAcceptanceChain,
  amendAcceptance,
  supersedeAcceptance,
  resolveActiveAcceptance,
  assertAcceptanceMutationAllowed,
  acceptanceAuditLog,
  getAcceptanceVersion,
  serializeAcceptanceChain,
  deserializeAcceptanceChain,
  stampActiveAcceptance,
  ACCEPTANCE_APPROVERS,
  ACCEPTANCE_MUTATION_COMMANDS,
  AcceptanceAuthorizationError,
  AcceptanceVersionError,
} from '../src/orchestrator/taskCard.js';
import { Persistence } from '../src/orchestrator/persistence.js';
import { deriveWorkflowTimeline } from '../src/dashboard/timeline.js';
import { SuperGptControlService } from '../src/control/controlService.js';

const BASE = ['Task goal is satisfied', 'All listed verification commands pass'];

// --- A. Acceptance immutability -------------------------------------------

test('createAcceptanceChain: initial criteria become an immutable version 1', () => {
  const chain = createAcceptanceChain(BASE, { approvedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(chain.activeVersion, 1);
  assert.equal(chain.versions.length, 1);
  assert.equal(chain.versions[0].version, 1);
  assert.equal(chain.versions[0].command, 'INITIAL');
  assert.equal(chain.versions[0].supersedesVersion, null);
  assert.deepEqual([...chain.versions[0].acceptance], BASE);
  assert.throws(() => chain.versions[0].acceptance.push('x'), TypeError);
});

test('amend appends version 2 and never rewrites version 1 in place', () => {
  const v1 = createAcceptanceChain(BASE);
  const v1FirstItem = v1.versions[0].acceptance[0];
  const next = ['Task goal is satisfied', 'Extra host verification evidence attached'];
  const v2 = amendAcceptance(v1, {
    newAcceptance: next,
    reason: 'HUMAN_REQUIRED decision added host verification evidence requirement',
    approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
    approvedAt: '2026-09-01T01:00:00.000Z',
  });

  // original chain object untouched
  assert.equal(v1.versions.length, 1);
  assert.equal(v1.activeVersion, 1);
  assert.equal(v1.versions[0].acceptance[0], v1FirstItem);

  assert.equal(v2.activeVersion, 2);
  assert.equal(v2.versions.length, 2);
  assert.equal(v2.versions[0], v1.versions[0], 'version 1 entry reused by reference');
  const rec = v2.versions[1];
  assert.equal(rec.version, 2);
  assert.equal(rec.command, ACCEPTANCE_MUTATION_COMMANDS.AMEND);
  assert.deepEqual([...rec.oldAcceptance], BASE);
  assert.deepEqual([...rec.newAcceptance], next);
  assert.equal(rec.approvedBy, ACCEPTANCE_APPROVERS.HUMAN_REQUIRED);
  assert.equal(rec.approvedAt, '2026-09-01T01:00:00.000Z');
  assert.match(rec.reason, /host verification/);
});

test('supersede records supersedesVersion and history stays fully auditable', () => {
  let chain = createAcceptanceChain(BASE);
  chain = amendAcceptance(chain, {
    newAcceptance: ['a1', 'a2'],
    reason: 'first amend',
    approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
  });
  chain = supersedeAcceptance(chain, {
    newAcceptance: ['b1'],
    reason: 'controlled orchestrator superseded acceptance via host verification',
    approvedBy: ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR,
  });

  assert.equal(chain.activeVersion, 3);
  assert.equal(chain.versions[2].command, ACCEPTANCE_MUTATION_COMMANDS.SUPERSEDE);
  assert.equal(chain.versions[2].supersedesVersion, 2);

  const log = acceptanceAuditLog(chain);
  assert.deepEqual(log.map((e) => e.version), [1, 2, 3]);
  assert.deepEqual(log.map((e) => e.approvedBy), ['PLANNER', 'HUMAN_REQUIRED', 'CONTROLLED_ORCHESTRATOR']);

  // every historical version is still recoverable
  assert.deepEqual(getAcceptanceVersion(chain, 1).acceptance, BASE);
  assert.deepEqual(getAcceptanceVersion(chain, 2).acceptance, ['a1', 'a2']);
  assert.deepEqual(getAcceptanceVersion(chain, 3).acceptance, ['b1']);
});

// --- B. Authorization + consumption consistency --------------------------

test('Executor-originated acceptance mutation is rejected before any authority check', () => {
  assert.throws(
    () => assertAcceptanceMutationAllowed({ originatedBy: 'EXECUTOR' }),
    (e) => e instanceof AcceptanceAuthorizationError && e.code === 'ACCEPTANCE_MUTATION_UNAUTHORIZED',
  );
  assert.throws(
    () => assertAcceptanceMutationAllowed({ originatedBy: 'execution_report' }),
    AcceptanceAuthorizationError,
  );
  assert.doesNotThrow(() => assertAcceptanceMutationAllowed({ originatedBy: 'HUMAN_REQUIRED' }));
});

test('amend rejects an unauthorized approver (including Executor) and a missing reason', () => {
  const chain = createAcceptanceChain(BASE);
  assert.throws(
    () => amendAcceptance(chain, { newAcceptance: ['x'], reason: 'r', approvedBy: 'EXECUTOR' }),
    (e) => e instanceof AcceptanceAuthorizationError,
  );
  assert.throws(
    () => amendAcceptance(chain, { newAcceptance: ['x'], reason: 'r', approvedBy: 'PLANNER' }),
    AcceptanceAuthorizationError,
  );
  assert.throws(
    () => amendAcceptance(chain, { newAcceptance: ['x'], reason: '  ', approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED }),
    AcceptanceVersionError,
  );
  assert.throws(
    () => amendAcceptance(chain, {
      newAcceptance: ['x'],
      reason: 'r',
      approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
      originatedBy: 'EXECUTOR',
    }),
    AcceptanceAuthorizationError,
  );
  // chain unchanged after all rejected attempts
  assert.equal(chain.versions.length, 1);
});

test('resolveActiveAcceptance always returns the current active version', () => {
  let chain = createAcceptanceChain(BASE);
  assert.deepEqual(resolveActiveAcceptance(chain), { version: 1, acceptance: BASE });
  chain = amendAcceptance(chain, {
    newAcceptance: ['only this now'],
    reason: 'narrowed scope',
    approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
  });
  assert.deepEqual(resolveActiveAcceptance(chain), { version: 2, acceptance: ['only this now'] });
});

// --- serialization / persistence recovery -------------------------------

test('serialize -> deserialize round-trips the chain and keeps entries frozen', () => {
  let chain = createAcceptanceChain(BASE);
  chain = amendAcceptance(chain, {
    newAcceptance: ['a'],
    reason: 'r',
    approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
  });
  const restored = deserializeAcceptanceChain(serializeAcceptanceChain(chain));
  assert.deepEqual(resolveActiveAcceptance(restored), resolveActiveAcceptance(chain));
  assert.equal(restored.versions.length, 2);
  assert.throws(() => restored.versions[1].acceptance.push('x'), TypeError);
});

test('persistence stores the acceptance chain in workflow state and recovers the active version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-persist-'));
  try {
    const p = new Persistence(dir);
    await p.writeWorkflowState('wf-1', { supervisor: { conversation_id: 'sup-1' } });

    let chain = createAcceptanceChain(BASE);
    await p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(chain));

    chain = supersedeAcceptance(chain, {
      newAcceptance: ['host verified acceptance'],
      reason: 'ACCEPTANCE_SUPERSEDED_BY_HOST_VERIFICATION',
      approvedBy: ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR,
    });
    await p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(chain));

    // sibling workflow state preserved
    assert.equal((await p.readWorkflowState('wf-1')).supervisor.conversation_id, 'sup-1');

    const recovered = deserializeAcceptanceChain(await p.readAcceptanceChain('wf-1'));
    assert.equal(recovered.versions.length, 2);
    assert.deepEqual(resolveActiveAcceptance(recovered), { version: 2, acceptance: ['host verified acceptance'] });
    assert.equal(getAcceptanceVersion(recovered, 1).acceptance[0], BASE[0]);

    // history must not shrink
    await assert.rejects(
      () => p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(createAcceptanceChain(BASE))),
      /must not shrink/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stampActiveAcceptance rewrites a task card to carry the active version and criteria', () => {
  let chain = createAcceptanceChain(BASE);
  const card = { task_id: 't1', acceptance_criteria: ['stale'], goal: 'g' };
  const v1 = stampActiveAcceptance(card, chain);
  assert.equal(v1.acceptance_version, 1);
  assert.deepEqual(v1.acceptance_criteria, BASE);
  assert.deepEqual(card.acceptance_criteria, ['stale'], 'input card not mutated');

  chain = amendAcceptance(chain, {
    newAcceptance: ['host verification evidence attached'],
    reason: 'human added host verification requirement',
    approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
  });
  const v2 = stampActiveAcceptance(card, chain);
  assert.equal(v2.acceptance_version, 2);
  assert.deepEqual(v2.acceptance_criteria, ['host verification evidence attached']);
});

test('persistence namespaces an independent append-only chain per task id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-ns-'));
  try {
    const p = new Persistence(dir);
    await p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(createAcceptanceChain(BASE)), 'task-a');
    await p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(createAcceptanceChain(['b only'])), 'task-b');

    let a = deserializeAcceptanceChain(await p.readAcceptanceChain('wf-1', 'task-a'));
    a = amendAcceptance(a, {
      newAcceptance: ['a amended'],
      reason: 'r',
      approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
    });
    await p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(a), 'task-a');

    assert.equal((await p.readAcceptanceChain('wf-1', 'task-a')).versions.length, 2);
    assert.equal((await p.readAcceptanceChain('wf-1', 'task-b')).versions.length, 1);
    assert.deepEqual(
      resolveActiveAcceptance(deserializeAcceptanceChain(await p.readAcceptanceChain('wf-1', 'task-b'))),
      { version: 1, acceptance: ['b only'] },
    );

    await assert.rejects(
      () => p.writeAcceptanceChain('wf-1', serializeAcceptanceChain(createAcceptanceChain(BASE)), 'task-a'),
      /must not shrink/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- timeline audit surface --------------------------------------------

test('timeline surfaces every acceptance amendment beyond version 1', () => {
  let chain = createAcceptanceChain(BASE);
  chain = amendAcceptance(chain, {
    newAcceptance: ['a'],
    reason: 'human added a criterion',
    approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
    approvedAt: '2026-09-01T02:00:00.000Z',
  });
  const events = deriveWorkflowTimeline({
    startedAt: '2026-09-01T00:00:00.000Z',
    lastProgressAt: '2026-09-01T03:00:00.000Z',
    acceptanceChain: serializeAcceptanceChain(chain),
  });
  const amend = events.filter((e) => e.type === 'ACCEPTANCE_AMENDED');
  assert.equal(amend.length, 1);
  assert.match(amend[0].label, /AMEND_ACCEPTANCE → v2 \(active v2\)/);
  assert.match(amend[0].detail, /human added a criterion \[approved by HUMAN_REQUIRED\]/);
});

// --- controlled orchestrator entry point (controlService) ---------------

test('SuperGptControlService.amendAcceptance is the sanctioned path and persists a new version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-control-'));
  try {
    const p = new Persistence(dir);
    await p.writeAcceptanceChain('wf-9', serializeAcceptanceChain(createAcceptanceChain(BASE)), 'task-a');
    const svc = new SuperGptControlService();

    const res = await svc.amendAcceptance({
      workflowId: 'wf-9',
      taskId: 'task-a',
      newAcceptance: ['host verification evidence attached'],
      reason: 'HUMAN_REQUIRED added host verification requirement',
      approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
      approvedAt: '2026-09-01T05:00:00.000Z',
      persistence: p,
    });
    assert.deepEqual(res.active, { version: 2, acceptance: ['host verification evidence attached'] });

    const recovered = deserializeAcceptanceChain(await p.readAcceptanceChain('wf-9', 'task-a'));
    assert.equal(recovered.versions.length, 2);
    assert.deepEqual(getAcceptanceVersion(recovered, 1).acceptance, BASE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SuperGptControlService.amendAcceptance rejects an Executor-originated request before touching the chain', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-control-rej-'));
  try {
    const p = new Persistence(dir);
    await p.writeAcceptanceChain('wf-10', serializeAcceptanceChain(createAcceptanceChain(BASE)), 'task-a');
    const svc = new SuperGptControlService();

    await assert.rejects(
      () => svc.amendAcceptance({
        workflowId: 'wf-10',
        taskId: 'task-a',
        newAcceptance: ['executor tried to widen acceptance'],
        reason: 'executor report claimed done',
        approvedBy: ACCEPTANCE_APPROVERS.HUMAN_REQUIRED,
        originatedBy: 'EXECUTOR',
        persistence: p,
      }),
      (e) => e instanceof AcceptanceAuthorizationError,
    );
    assert.equal((await p.readAcceptanceChain('wf-10', 'task-a')).versions.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SuperGptControlService.amendAcceptance can SUPERSEDE and records supersedesVersion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acceptance-control-sup-'));
  try {
    const p = new Persistence(dir);
    await p.writeAcceptanceChain('wf-11', serializeAcceptanceChain(createAcceptanceChain(BASE)), 'task-a');
    const svc = new SuperGptControlService();

    const res = await svc.amendAcceptance({
      workflowId: 'wf-11',
      taskId: 'task-a',
      command: ACCEPTANCE_MUTATION_COMMANDS.SUPERSEDE,
      newAcceptance: ['host verified acceptance'],
      reason: 'ACCEPTANCE_SUPERSEDED_BY_HOST_VERIFICATION',
      approvedBy: ACCEPTANCE_APPROVERS.CONTROLLED_ORCHESTRATOR,
      persistence: p,
    });
    assert.equal(res.active.version, 2);
    const recovered = deserializeAcceptanceChain(await p.readAcceptanceChain('wf-11', 'task-a'));
    assert.equal(recovered.versions[1].command, ACCEPTANCE_MUTATION_COMMANDS.SUPERSEDE);
    assert.equal(recovered.versions[1].supersedesVersion, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('timeline emits no acceptance event for an unmodified version-1 chain', () => {
  const events = deriveWorkflowTimeline({
    startedAt: '2026-09-01T00:00:00.000Z',
    acceptanceChain: serializeAcceptanceChain(createAcceptanceChain(BASE)),
  });
  assert.equal(events.filter((e) => e.type === 'ACCEPTANCE_AMENDED').length, 0);
});
