import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  runPreflight,
  checkExecutable,
  scanAndSnapshotExternalSymlinks,
  buildHumanRequiredEvidence,
  FAILURE_CATEGORIES,
  PREFLIGHT_BLOCKER_TYPES,
} from "../src/orchestrator/preflight.js";

test("checkExecutable passes for existing system binary and fails for nonexistent", async () => {
  const nodeCheck = await checkExecutable("node");
  assert.equal(nodeCheck.available, true);
  assert.ok(nodeCheck.path);

  const missingCheck = await checkExecutable("nonexistent-binary-xyz-12345");
  assert.equal(missingCheck.available, false);
  assert.ok(missingCheck.error);
});

test("runPreflight passes when verification commands are available", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-preflight-pass-"));
  try {
    const result = await runPreflight({
      taskCard: {
        task_id: "task-1",
        verification_commands: ["node -v", "echo hello"],
      },
      cwd: tmpDir,
    });
    assert.equal(result.status, "PASS");
    assert.equal(result.blockers.length, 0);
    assert.equal(result.snapshots.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runPreflight blocks with COMMAND_UNAVAILABLE when verification command binary is missing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-preflight-fail-"));
  try {
    const result = await runPreflight({
      taskCard: {
        task_id: "task-1",
        verification_commands: ["missingtoolxyz --run"],
      },
      cwd: tmpDir,
    });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.COMMAND_UNAVAILABLE);
    assert.match(result.blockers[0].detail, /missingtoolxyz/);
    assert.ok(result.blockers[0].fingerprint.includes("missingtoolxyz"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scanAndSnapshotExternalSymlinks snapshots safe external symlink into auxiliary storage with provenance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-symlink-root-"));
  const sourceWorkspace = path.join(root, "source-repo");
  const worktreePath = path.join(root, "isolated-worktree");
  const sharedDocs = path.join(sourceWorkspace, "docs");

  fs.mkdirSync(sharedDocs, { recursive: true });
  fs.mkdirSync(path.join(worktreePath, "docs"), { recursive: true });

  const targetFile = path.join(sharedDocs, "TASK_BOARD.md");
  fs.writeFileSync(targetFile, "# Task Board\nActive tasks here.");

  const symlinkPath = path.join(worktreePath, "docs", "TASK_BOARD.md");
  fs.symlinkSync(targetFile, symlinkPath);

  try {
    const result = await scanAndSnapshotExternalSymlinks({
      worktreePath,
      sourceWorkspace,
      candidatePaths: [path.join("docs", "TASK_BOARD.md")],
      isTrackedFn: () => true,
    });

    assert.equal(result.blockers.length, 0);
    assert.equal(result.snapshots.length, 1);
    const snap = result.snapshots[0];
    assert.equal(snap.original_symlink_path, path.join("docs", "TASK_BOARD.md"));
    assert.equal(snap.resolved_source_path, fs.realpathSync(targetFile));
    assert.equal(snap.read_only, true);
    assert.ok(snap.content_hash);
    assert.ok(fs.existsSync(snap.absolute_snapshot_path));
    assert.equal(fs.readFileSync(snap.absolute_snapshot_path, "utf8"), "# Task Board\nActive tasks here.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanAndSnapshotExternalSymlinks blocks when external symlink points to missing or forbidden target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-symlink-broken-"));
  const sourceWorkspace = path.join(root, "source-repo");
  const worktreePath = path.join(root, "isolated-worktree");

  fs.mkdirSync(sourceWorkspace, { recursive: true });
  fs.mkdirSync(path.join(worktreePath, "docs"), { recursive: true });

  const symlinkPath = path.join(worktreePath, "docs", "TASK_BOARD.md");
  fs.symlinkSync("/tmp/nonexistent-outside-file-xyz.md", symlinkPath);

  try {
    const result = await scanAndSnapshotExternalSymlinks({
      worktreePath,
      sourceWorkspace,
      candidatePaths: [path.join("docs", "TASK_BOARD.md")],
      isTrackedFn: () => true,
    });

    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
    assert.match(result.blockers[0].detail, /non-existent target/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildHumanRequiredEvidence constructs actionable evidence package", () => {
  const evidence = buildHumanRequiredEvidence({
    workflowId: "wf-123",
    taskCard: { task_id: "task-auth", goal: "Implement login" },
    attempt: 2,
    stage: "GATE",
    blockerCategory: FAILURE_CATEGORIES.ENVIRONMENT,
    rootCause: "Swift toolchain not found",
    failingGateCommand: "swift test",
    exitCode: 127,
    stderrTail: "bash: swift: command not found",
    blockerFingerprint: "CMD_UNAVAILABLE:swift",
    recommendedAction: "Install swift toolchain on the host machine.",
    history: [{ task_id: "task-init", decision: "PASS" }],
  });

  assert.equal(evidence.workflowId, "wf-123");
  assert.equal(evidence.taskId, "task-auth");
  assert.equal(evidence.stage, "GATE");
  assert.equal(evidence.blockerCategory, FAILURE_CATEGORIES.ENVIRONMENT);
  assert.equal(evidence.failingGateCommand, "swift test");
  assert.equal(evidence.exitCode, 127);
  assert.equal(evidence.rootCause, "Swift toolchain not found");
  assert.ok(evidence.availableChoices.length >= 2);
  assert.equal(evidence.attemptHistorySummary.length, 1);
});
