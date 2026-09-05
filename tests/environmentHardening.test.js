import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runAutomatedWorkflow } from "../src/orchestrator/automatedLoop.js";
import { supergptWatch } from "../src/orchestrator/supergpt.js";
import { FAILURE_CATEGORIES } from "../src/orchestrator/preflight.js";
import { WorkflowStateManager, WORKFLOW_STATUSES, WORKFLOW_STAGES, WORKFLOW_KINDS } from "../src/orchestrator/workflowState.js";

function makeFakeWindowSession() {
  let windowCount = 0;
  let tabCount = 0;
  return {
    async create() {
      const windowId = ++windowCount;
      const initialTabId = ++tabCount;
      return { windowId, initialTabId };
    },
    async activateTab() {
      return { active: true, windowFocused: false };
    },
    async close() {},
    async listTabs() {
      return [];
    },
  };
}

test("Gate verification ownership: Gate executes verification in isolated worktree even without Claude bash permission", async () => {
  const windowSession = makeFakeWindowSession();
  const stateManager = new WorkflowStateManager({ workflowId: "wf-test-gate-test", kind: WORKFLOW_KINDS.INTERNAL_TEST });

  let gateExecuted = false;
  let executorExecuted = false;

  const fakeClaudeManager = {
    async execute(taskCard) {
      executorExecuted = true;
      // Claude cannot run bash commands (e.g. non-interactive acceptEdits mode)
      return {
        summary: "Files edited without bash execution",
        model: "claude-3-7-sonnet",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };

  const fakeGateRunner = {
    async run(commands) {
      gateExecuted = true;
      assert.deepEqual(commands, ["swift test"]);
      return {
        pass: true,
        results: [{ command: "swift test", pass: true, exitCode: 0, output: "Test Suite passed" }],
      };
    },
  };

  let supervisorStep = 0;
  const fakeSupervisorSession = {
    async create() { return { tabId: 10 }; },
    async decide() {
      supervisorStep += 1;
      if (supervisorStep === 1) {
        return {
          action: "NEXT_TASK",
          task_card: {
            task_id: "task-swift-1",
            goal: "Fix Swift tests",
            verification_commands: ["swift test"],
          },
        };
      }
      return {
        action: "WORKFLOW_DONE",
        summary: "Swift tests verified and passed by Gate",
      };
    },
    async close() {},
  };

  const fakeReviewerSession = {
    async create() { return { tabId: 20 }; },
    async review() {
      return {
        decision: "PASS",
        rationale: "Gate verification passed cleanly",
        findings: [],
        required_changes: [],
      };
    },
    async close() {},
  };

  const result = await runAutomatedWorkflow({
    workflowId: "wf-gate-test",
    supervisorSession: fakeSupervisorSession,
    createReviewerSession: () => fakeReviewerSession,
    createClaudeSessionManager: () => fakeClaudeManager,
    gateRunner: fakeGateRunner,
    windowSession,
    workflowGoal: "Fix swift test suite",
    repositoryContext: { repo_root: "/tmp" },
    workflowStateManager: stateManager,
    runPreflightFn: async () => ({ status: "PASS", blockers: [], snapshots: [] }),
  });

  assert.equal(result.status, "WORKFLOW_DONE");
  assert.equal(executorExecuted, true);
  assert.equal(gateExecuted, true);
  assert.equal(result.summary, "Swift tests verified and passed by Gate");
});

test("Preflight environment blocker halts immediately to HUMAN_REQUIRED without burning rework attempts", async () => {
  const windowSession = makeFakeWindowSession();
  const stateManager = new WorkflowStateManager({ workflowId: "wf-test-blocker-dedup", kind: WORKFLOW_KINDS.INTERNAL_TEST });

  let executorAttemptCalls = 0;
  let reviewerCalls = 0;

  const fakeClaudeManager = {
    async execute() {
      executorAttemptCalls += 1;
      return { summary: "done" };
    },
  };

  const fakeGateRunner = {
    async run() {
      return { pass: false, results: [] };
    },
  };

  const fakeSupervisorSession = {
    async create() { return { tabId: 10 }; },
    async decide() {
      return {
        action: "NEXT_TASK",
        task_card: {
          task_id: "task-missing-tool",
          goal: "Build with missing tool",
          verification_commands: ["nonexistent_tool_binary --check"],
        },
      };
    },
    async close() {},
  };

  const fakeReviewerSession = {
    async create() { return { tabId: 20 }; },
    async review() {
      reviewerCalls += 1;
      return { decision: "REWORK" };
    },
    async close() {},
  };

  const result = await runAutomatedWorkflow({
    workflowId: "wf-test-blocker-dedup",
    supervisorSession: fakeSupervisorSession,
    createReviewerSession: () => fakeReviewerSession,
    createClaudeSessionManager: () => fakeClaudeManager,
    gateRunner: fakeGateRunner,
    windowSession,
    workflowGoal: "Run task with missing tool",
    maxAttemptsPerTask: 3,
    workflowStateManager: stateManager,
    runPreflightFn: async () => ({
      status: "BLOCKED",
      blockers: [{
        type: "COMMAND_UNAVAILABLE",
        resource: "nonexistent_tool_binary",
        detail: "Command 'nonexistent_tool_binary' not found",
        remediation: "Install nonexistent_tool_binary",
        fingerprint: "CMD_UNAVAILABLE:nonexistent_tool_binary",
      }],
      snapshots: [],
    }),
  });

  // Must immediately halt to HUMAN_REQUIRED
  assert.equal(result.status, "HUMAN_REQUIRED");
  // Zero rework attempts burned — Executor and Reviewer were never called
  assert.equal(executorAttemptCalls, 0);
  assert.equal(reviewerCalls, 0);

  // Evidence package is rich and structured
  assert.ok(result.evidence);
  assert.equal(result.evidence.blockerCategory, FAILURE_CATEGORIES.ENVIRONMENT);
  assert.equal(result.evidence.taskId, "task-missing-tool");
  assert.equal(result.evidence.blockerFingerprint, "CMD_UNAVAILABLE:nonexistent_tool_binary");
  assert.ok(result.evidence.availableChoices.length >= 2);
});

test("Gate environment failure classifies as ENVIRONMENT and enters HUMAN_REQUIRED with evidence", async () => {
  const windowSession = makeFakeWindowSession();
  const stateManager = new WorkflowStateManager({ workflowId: "wf-test-gate-env", kind: WORKFLOW_KINDS.INTERNAL_TEST });

  let reviewerCalls = 0;

  const fakeClaudeManager = {
    async execute() {
      return { summary: "Code modified" };
    },
  };

  const fakeGateRunner = {
    async run() {
      return {
        pass: false,
        results: [{
          command: "swift test",
          pass: false,
          exitCode: 127,
          output: "bash: swift: command not found (exit code 127)",
        }],
      };
    },
  };

  const fakeSupervisorSession = {
    async create() { return { tabId: 10 }; },
    async decide() {
      return {
        action: "NEXT_TASK",
        task_card: {
          task_id: "task-swift-env",
          goal: "Run swift test",
          verification_commands: ["swift test"],
        },
      };
    },
    async close() {},
  };

  const fakeReviewerSession = {
    async create() { return { tabId: 20 }; },
    async review() {
      reviewerCalls += 1;
      return { decision: "PASS" };
    },
    async close() {},
  };

  const result = await runAutomatedWorkflow({
    workflowId: "wf-gate-env",
    supervisorSession: fakeSupervisorSession,
    createReviewerSession: () => fakeReviewerSession,
    createClaudeSessionManager: () => fakeClaudeManager,
    gateRunner: fakeGateRunner,
    windowSession,
    workflowGoal: "Swift gate environment check",
    workflowStateManager: stateManager,
    runPreflightFn: async () => ({ status: "PASS", blockers: [], snapshots: [] }),
  });

  assert.equal(result.status, "HUMAN_REQUIRED");
  // Reviewer should not have been called on Gate environment blocker
  assert.equal(reviewerCalls, 0);
  assert.ok(result.evidence);
  assert.equal(result.evidence.blockerCategory, FAILURE_CATEGORIES.ENVIRONMENT);
  assert.equal(result.evidence.failingGateCommand, "swift test");
  assert.equal(result.evidence.exitCode, 127);
});

test("supergptWatch delivers terminal evidence within default timeout", async () => {
  const notifications = [];
  let pollCount = 0;

  const mockState = {
    workflowId: "wf-watch-test",
    workflowStatus: WORKFLOW_STATUSES.RUNNING,
    stage: WORKFLOW_STAGES.EXECUTOR,
    heartbeatAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
    evidence: null,
  };

  const result = await supergptWatch({
    workflowId: "wf-watch-test",
    intervalMs: 1,
    // timeoutMs is omitted (defaults to SUPERGPT_WATCH_TIMEOUT_MS)
    onProgress: (p) => notifications.push(p),
    _sleep: async () => {},
    _now: () => Date.now(),
    _readState: () => {
      pollCount += 1;
      if (pollCount >= 3) {
        mockState.workflowStatus = WORKFLOW_STATUSES.HUMAN_REQUIRED;
        mockState.evidence = {
          rootCause: "Tool missing",
          blockerCategory: "ENVIRONMENT",
        };
      }
      return mockState;
    },
  });

  assert.equal(result.status, WORKFLOW_STATUSES.HUMAN_REQUIRED);
  assert.ok(result.evidence);
  assert.equal(result.evidence.rootCause, "Tool missing");
  assert.ok(notifications.length >= 2);
});
