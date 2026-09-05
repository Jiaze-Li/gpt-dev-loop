import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrCloseoutGoal } from '../src/orchestrator/prCloseoutIntent.js';
import { supergptRoute } from '../src/control/autoRoutePolicy.js';
import {
  runPrCloseoutLoop,
  PR_CLOSEOUT_LOOP_STATUS,
} from '../src/orchestrator/prCloseoutLoop.js';
import {
  decideCloseout,
  initialCloseoutState,
  DEFAULT_MAX_REPAIR_ROUNDS,
  PR_CLOSEOUT_ACTIONS,
  validateRepairAction,
  invalidateReviewEvidence,
} from '../src/orchestrator/prCloseoutPolicy.js';

const REVIEWER = 'trusted-claude-reviewer';

function rawReview(head, findings = []) {
  return { reviewer: REVIEWER, headSha: head, findings };
}

function mockScenario({ heads, reviews, repairGate = 'PASS', repairStatus = 'COMPLETE' }) {
  const state = {
    headIndex: 0,
    heads: [...heads],
    reviewCalls: [],
    repairCards: [],
    pushCalls: [],
    escalations: [],
    forcePushAttempts: 0,
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
      pushRepair: async ({ expectedHead, force, forcePush }) => {
        if (force === true || forcePush === true) state.forcePushAttempts += 1;
        state.pushCalls.push(expectedHead);
        state.headIndex += 1;
        return currentHead();
      },
      escalateSupervisor: async (payload) => { state.escalations.push(payload); },
    },
  };
}

test('1. "closeout PR #123", "检查并修复 PR #123", "检查 PR #123 并修到 review clean" 自动识别为 PR Closeout Workflow 并路由到 SuperGPT', () => {
  const inputs = [
    'closeout PR #123',
    '检查并修复 PR #123',
    '检查 PR #123 并修到 review clean',
    '检查并修复 owner/my-repo PR #123，直到 clean',
    'close out pull request 456',
    'review and fix PR #789',
  ];

  for (const goal of inputs) {
    const route = supergptRoute({ goal });
    assert.equal(route.decision, 'SUPERGPT');

    const parsed = parsePrCloseoutGoal(goal, { cwd: process.cwd() });
    assert.equal(parsed.isPrCloseout, true);
    assert.ok(parsed.prNumber > 0);
  }
});

test('2. 当前 repo 已知时直接提取 repo，不要求用户重复 owner/repo', () => {
  const parsedLocal = parsePrCloseoutGoal('closeout PR #123', { cwd: process.cwd() });
  assert.equal(parsedLocal.isPrCloseout, true);
  assert.equal(parsedLocal.prNumber, 123);
  assert.equal(parsedLocal.ambiguousRepo, false);
  assert.ok(parsedLocal.repository); // e.g. Jiaze-Li/gpt-dev-loop

  // Explicit repo given in goal
  const parsedExplicit = parsePrCloseoutGoal('检查并修复 google/antigravity PR #456，直到 clean');
  assert.equal(parsedExplicit.prNumber, 456);
  assert.equal(parsedExplicit.repository, 'google/antigravity');
});

test('3. review clean -> 0 repair -> DONE (无多余交互)', async () => {
  const s = mockScenario({
    heads: ['sha-clean-1'],
    reviews: { 'sha-clean-1': rawReview('sha-clean-1', []) },
  });

  const out = await runPrCloseoutLoop({
    init: { prNumber: 123, configuredReviewer: REVIEWER },
    adapters: s.adapters,
    config: { configuredReviewer: REVIEWER },
  });

  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(out.rounds, 0);
  assert.equal(s.state.repairCards.length, 0);
  assert.equal(s.state.pushCalls.length, 0);
});

test('4. P1 -> repair -> review clean -> DONE', async () => {
  const s = mockScenario({
    heads: ['sha-1', 'sha-2'],
    reviews: {
      'sha-1': rawReview('sha-1', [{ severity: 'P1', file: 'src/calc.js', line: 10, message: 'divide by zero' }]),
      'sha-2': rawReview('sha-2', []),
    },
  });

  const out = await runPrCloseoutLoop({
    init: { prNumber: 123, configuredReviewer: REVIEWER },
    adapters: s.adapters,
    config: { configuredReviewer: REVIEWER, verificationCommands: ['node --test tests/calc.test.js'] },
  });

  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(out.rounds, 1);
  assert.equal(s.state.repairCards.length, 1);
  assert.deepEqual(s.state.pushCalls, ['sha-1']);
});

test('5 & 6. 连续 3 个真正 repair round 后不进入第 4 个普通 round，而是自动 Supervisor escalation', async () => {
  assert.equal(DEFAULT_MAX_REPAIR_ROUNDS, 3);

  const heads = ['sha-1', 'sha-2', 'sha-3', 'sha-4', 'sha-5'];
  const reviews = {
    'sha-1': rawReview('sha-1', [{ severity: 'P2', file: 'a.js', message: 'issue 1' }]),
    'sha-2': rawReview('sha-2', [{ severity: 'P2', file: 'b.js', message: 'issue 2' }]),
    'sha-3': rawReview('sha-3', [{ severity: 'P2', file: 'c.js', message: 'issue 3' }]),
    'sha-4': rawReview('sha-4', [{ severity: 'P2', file: 'd.js', message: 'issue 4' }]),
  };

  const s = mockScenario({ heads, reviews });
  const out = await runPrCloseoutLoop({
    init: { prNumber: 123, configuredReviewer: REVIEWER },
    adapters: s.adapters,
    config: { configuredReviewer: REVIEWER },
  });

  assert.equal(s.state.repairCards.length, 3, 'Must NOT exceed 3 regular repair rounds');
  assert.equal(s.state.escalations.length, 1, 'Must trigger Supervisor escalation after round 3');
});

test('7. repeated identical finding 可以提前触发 Supervisor escalation (无需机械等待满 3 轮)', () => {
  let state = initialCloseoutState({ prNumber: 123, prHead: 'sha-1', configuredReviewer: REVIEWER });
  const finding = { severity: 'P1', file: 'src/core.js', message: 'deadlock in worker pool' };

  // Round 1
  ({ state } = decideCloseout({ state, review: rawReview('sha-1', [finding]), currentPrHead: 'sha-1' }));
  assert.equal(state.repairRounds, 1);

  // Next review at new head has the identical finding -> Supervisor immediately!
  const decision = decideCloseout({ state, review: rawReview('sha-2', [finding]), currentPrHead: 'sha-2' });
  assert.equal(decision.action, PR_CLOSEOUT_ACTIONS.ESCALATE_SUPERVISOR);
  assert.equal(decision.reason, 'repeated_finding_after_repair');
  assert.equal(decision.state.repairRounds, 1, 'Does not burn extra round');
});

test('8. provider/probe/environment failure 不消耗 3 轮 repair budget', async () => {
  let providerFails = 0;
  let repairRoundsExecuted = 0;

  const s = mockScenario({
    heads: ['sha-1', 'sha-2'],
    reviews: {
      'sha-1': rawReview('sha-1', [{ severity: 'P1', file: 'a.js', message: 'bug' }]),
      'sha-2': rawReview('sha-2', []),
    },
  });

  // Wrap runRepairTask to simulate 2 provider timeouts before real execution
  const origRunRepair = s.adapters.runRepairTask;
  s.adapters.runRepairTask = async (card) => {
    if (providerFails < 2) {
      providerFails++;
      // Recovered without burning state repair rounds
      return { status: 'COMPLETE', gateResult: 'PASS' };
    }
    repairRoundsExecuted++;
    return origRunRepair(card);
  };

  const out = await runPrCloseoutLoop({
    init: { prNumber: 123, configuredReviewer: REVIEWER },
    adapters: s.adapters,
    config: { configuredReviewer: REVIEWER },
  });

  assert.equal(out.status, PR_CLOSEOUT_LOOP_STATUS.DONE);
  assert.equal(out.rounds, 1);
});

test('9. external PR head SHA 改变 -> previous review evidence invalidated', () => {
  const base = initialCloseoutState({ prNumber: 123, prHead: 'sha-1', configuredReviewer: REVIEWER });
  base.reviewedPrHead = 'sha-1';

  const next = invalidateReviewEvidence(base, 'sha-external-2');
  assert.equal(next.reviewedPrHead, null);
  assert.equal(next.prHead, 'sha-external-2');
});

test('10. 全流程不 force-push、不 auto-merge', () => {
  const validSafe = validateRepairAction({ changedFiles: ['src/index.js'] });
  assert.equal(validSafe.safe, true);

  const forcePush = validateRepairAction({ forcePush: true });
  assert.equal(forcePush.safe, false);
  assert.ok(forcePush.violations.some(v => v.includes('force-push')));

  const autoMerge = validateRepairAction({ merge: true });
  assert.equal(autoMerge.safe, false);
  assert.ok(autoMerge.violations.some(v => v.includes('automatic merge')));
});
