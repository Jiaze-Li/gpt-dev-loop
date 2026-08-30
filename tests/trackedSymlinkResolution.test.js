import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  runPreflight,
  scanAndSnapshotExternalSymlinks,
  getTaskCandidatePaths,
  isGitTracked,
  PREFLIGHT_BLOCKER_TYPES,
} from "../src/orchestrator/preflight.js";
import { runAutomatedWorkflow } from "../src/orchestrator/automatedLoop.js";
import { createResultDelivery } from "../src/orchestrator/resultDelivery.js";
import { createWorkspaceSnapshot } from "../src/orchestrator/workspaceSnapshot.js";
import { createGitEvidenceCollector } from "../src/adapters/gate/git-evidence/index.js";
import { nullWindowSession } from "../src/orchestrator/agyProviderSessions.js";

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: dir });
}

function commitAll(dir, message = "init") {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message, "--no-verify", "--no-gpg-sign"], { cwd: dir });
}

test("1. approved sibling root snapshots successfully (SpinLab/docs/TASK_BOARD.md -> SpinLab-shared/TASK_BOARD.md)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-spinlab-approved-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Shared Task Board\nActive backlog: Feature A, B, C.");

    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);
    commitAll(spinLabRepo, "add tracked symlink");

    const taskCard = {
      task_id: "task-1",
      goal: "Work on active backlog",
      read_targets: ["docs/TASK_BOARD.md"],
      allowed_files: ["src/app.js"],
      verification_commands: [],
    };

    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [spinLabShared],
    });

    assert.equal(preflight.status, "PASS");
    assert.equal(preflight.blockers.length, 0);
    assert.equal(preflight.snapshots.length, 1);

    const snap = preflight.snapshots[0];
    assert.equal(snap.original_path, path.join("docs", "TASK_BOARD.md"));
    assert.equal(snap.resolved_source_realpath, fs.realpathSync(sharedTarget));
    assert.equal(snap.approved_root, fs.realpathSync(spinLabShared));
    assert.equal(snap.read_only, true);
    assert.ok(snap.sha256);
    assert.ok(snap.timestamp);
    assert.equal(snap.size, Buffer.byteLength("# Shared Task Board\nActive backlog: Feature A, B, C."));
    assert.ok(fs.existsSync(snap.absolute_snapshot_path));
    assert.equal(fs.readFileSync(snap.absolute_snapshot_path, "utf8"), "# Shared Task Board\nActive backlog: Feature A, B, C.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("2. unapproved sibling root blocks before model calls (immediately HUMAN_REQUIRED without consuming attempts)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-spinlab-unapproved-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Secret Shared Backlog");

    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);
    commitAll(spinLabRepo, "add symlink");

    const taskCard = {
      task_id: "task-auth",
      goal: "Implement feature using task board",
      read_targets: ["docs/TASK_BOARD.md"],
      allowed_files: ["src/app.js"],
      verification_commands: [],
    };

    // 1. Direct preflight check
    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [],
    });

    assert.equal(preflight.status, "BLOCKED");
    assert.equal(preflight.blockers.length, 1);
    assert.equal(preflight.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
    assert.equal(preflight.blockers[0].resource, path.join("docs", "TASK_BOARD.md"));
    assert.equal(preflight.blockers[0].target, fs.realpathSync(sharedTarget));
    assert.equal(preflight.blockers[0].suggested_external_root, fs.realpathSync(spinLabShared));
    assert.match(preflight.blockers[0].detail, /unapproved external target/);

    // 2. End-to-end loop invocation check: zero model calls, 0 attempts consumed
    let executorCalls = 0;
    let reviewerCalls = 0;
    let supervisorDecideCalls = 0;

    const supervisorSession = {
      async create() { return { tabId: 101 }; },
      async decide() {
        supervisorDecideCalls += 1;
        return { action: "SELECT_TASK", task_card: taskCard };
      },
      async close() {},
    };

    const createClaudeSessionManager = () => ({
      async execute() {
        executorCalls += 1;
        return { status: "DONE" };
      },
    });

    const createReviewerSession = () => ({
      async create() { return { tabId: 201 }; },
      async review() {
        reviewerCalls += 1;
        return { decision: "PASS" };
      },
      async close() {},
    });

    const result = await runAutomatedWorkflow({
      supervisorSession,
      createClaudeSessionManager,
      createReviewerSession,
      gateRunner: { run: async () => ({ pass: true }) },
      workflowGoal: "Test unapproved root",
      windowSession: nullWindowSession,
      repoRoot: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [],
    });

    assert.equal(result.status, "HUMAN_REQUIRED");
    assert.equal(executorCalls, 0, "Executor must not be called when preflight is blocked");
    assert.equal(reviewerCalls, 0, "Reviewer must not be called when preflight is blocked");
    assert.equal(result.evidence.attempt, 1);
    assert.equal(result.evidence.stage, "PREFLIGHT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3. unrelated tracked external symlink does not block an unrelated task", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-unrelated-symlink-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, "src"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    // Unapproved external symlink in docs/
    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Shared Task Board");
    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);

    // Regular tracked file in src/
    const appFile = path.join(spinLabRepo, "src", "app.js");
    fs.writeFileSync(appFile, "console.log(\"hello\");");
    commitAll(spinLabRepo, "add files");

    // Unrelated task only requiring src/app.js
    const taskCard = {
      task_id: "task-clean",
      goal: "Update app code",
      read_targets: ["src/app.js"],
      allowed_files: ["src/app.js"],
      verification_commands: [],
    };

    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [],
    });

    assert.equal(preflight.status, "PASS", "Unrelated external symlink must not block task");
    assert.equal(preflight.blockers.length, 0);
    assert.equal(preflight.snapshots.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4. untracked symlink is not treated as trusted task context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-untracked-symlink-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);
    fs.writeFileSync(path.join(spinLabRepo, "README.md"), "# SpinLab");
    commitAll(spinLabRepo, "initial commit");

    // Untracked symlink in worktree
    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Shared Task Board");
    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);

    const taskCard = {
      task_id: "task-untracked",
      goal: "Read untracked link",
      read_targets: ["docs/TASK_BOARD.md"],
      allowed_files: ["src/app.js"],
      verification_commands: [],
    };

    const symlinkResult = await scanAndSnapshotExternalSymlinks({
      worktreePath: spinLabRepo,
      taskCard,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [spinLabShared],
    });

    assert.equal(symlinkResult.snapshots.length, 0, "Untracked symlinks must never produce auxiliary snapshots");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("5. snapshot modification can never modify source sibling file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-isolation-guard-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    const originalContent = "# Immutable Shared Task Board\nInitial version.";
    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, originalContent);

    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);
    commitAll(spinLabRepo, "commit symlink");

    const preflight = await scanAndSnapshotExternalSymlinks({
      worktreePath: spinLabRepo,
      candidatePaths: ["docs/TASK_BOARD.md"],
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [spinLabShared],
    });

    assert.equal(preflight.snapshots.length, 1);
    const snap = preflight.snapshots[0];

    fs.chmodSync(snap.absolute_snapshot_path, 0o666);
    fs.writeFileSync(snap.absolute_snapshot_path, "# Malicious / Inadvertent Mutation");

    const sourceContent = fs.readFileSync(sharedTarget, "utf8");
    assert.equal(sourceContent, originalContent, "Sibling source file must remain unmodified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("6. auxiliary context never appears in delivered files or baseline commits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-delivery-aux-guard-"));
  try {
    const sourceWorkspace = path.join(root, "source-repo");
    const worktreePath = path.join(root, "worktree-repo");
    const sharedExternal = path.join(root, "shared-external");

    fs.mkdirSync(path.join(sourceWorkspace, "docs"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspace, "src"), { recursive: true });
    fs.mkdirSync(sharedExternal, { recursive: true });

    initGitRepo(sourceWorkspace);
    fs.writeFileSync(path.join(sharedExternal, "TASK_BOARD.md"), "# Shared Tasks");
    fs.writeFileSync(path.join(sourceWorkspace, "src", "index.js"), "export const a = 1;");
    fs.symlinkSync(path.join(sharedExternal, "TASK_BOARD.md"), path.join(sourceWorkspace, "docs", "TASK_BOARD.md"));
    commitAll(sourceWorkspace, "initial commit");

    execFileSync("git", ["clone", "-q", sourceWorkspace, worktreePath]);
    initGitRepo(worktreePath);

    // Snapshot external symlink into worktree
    const preflight = await scanAndSnapshotExternalSymlinks({
      worktreePath,
      candidatePaths: ["docs/TASK_BOARD.md"],
      sourceWorkspace,
      externalReadRoots: [sharedExternal],
    });
    assert.equal(preflight.snapshots.length, 1);
    assert.ok(fs.existsSync(path.join(worktreePath, ".supergpt_auxiliary")));

    // Modify source workspace to test snapshot capture into a fresh clean worktree
    fs.writeFileSync(path.join(sourceWorkspace, "src", "index.js"), "export const a = 2;");
    fs.writeFileSync(path.join(sourceWorkspace, "src", "untracked.js"), "export const u = true;");

    const freshWorktree = path.join(root, "fresh-worktree");
    execFileSync("git", ["clone", "-q", sourceWorkspace, freshWorktree]);
    // reset freshWorktree to original HEAD
    const origHead = execFileSync("git", ["rev-parse", "HEAD~0"], { cwd: sourceWorkspace }).toString().trim();

    const snapshotManager = createWorkspaceSnapshot();
    const snapCommit = await snapshotManager.captureAndApply({
      sourceCwd: sourceWorkspace,
      worktreePath: freshWorktree,
      baselineHead: origHead,
    });

    // Verify delta and delivery exclude auxiliary context
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath }).toString().trim();
    const delivery = createResultDelivery();
    const delta = await delivery.calculateApprovedDelta({
      worktreePath,
      baselineHead: headSha,
    });

    for (const changed of delta.changedPaths) {
      assert.ok(!changed.startsWith(".supergpt_auxiliary"), "Auxiliary file leaked into delta");
      assert.ok(!changed.startsWith(".supergpt"), "Internal file leaked into delta");
    }

    const collector = createGitEvidenceCollector();
    const evidence = await collector.collect_evidence({
      cwd: worktreePath,
      baseline: { head: headSha },
    });

    for (const f of evidence.untracked_files) {
      assert.ok(!f.path.startsWith(".supergpt_auxiliary"), "Auxiliary file leaked into git evidence");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("7. nested-symlink escape prevention: deep chain pointing outside approved roots fails closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-nested-escape-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    const forbiddenOutside = path.join(root, "forbidden-private");

    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });
    fs.mkdirSync(forbiddenOutside, { recursive: true });

    initGitRepo(spinLabRepo);

    const privateFile = path.join(forbiddenOutside, "SECRET_KEY.pem");
    fs.writeFileSync(privateFile, "SUPER_SECRET_KEY");

    const intermediateSymlink = path.join(spinLabShared, "INTERMEDIATE.md");
    fs.symlinkSync(privateFile, intermediateSymlink);

    const repoSymlink = path.join(spinLabRepo, "docs", "ESCAPE.md");
    fs.symlinkSync(intermediateSymlink, repoSymlink);
    commitAll(spinLabRepo, "commit escape link");

    const result = await scanAndSnapshotExternalSymlinks({
      worktreePath: spinLabRepo,
      candidatePaths: ["docs/ESCAPE.md"],
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [spinLabShared],
    });

    assert.equal(result.snapshots.length, 0);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
    assert.equal(result.blockers[0].target, fs.realpathSync(privateFile));
    assert.equal(result.blockers[0].suggested_external_root, fs.realpathSync(forbiddenOutside));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("8. allowed_files alone does not trigger required-read symlink inspection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-allowed-scope-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    // Unapproved external target
    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Shared Task Board");
    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);
    commitAll(spinLabRepo, "commit symlink");

    // Task card only specifies allowed_files (write scope), not read_targets or required_files
    const taskCard = {
      task_id: "task-write-only",
      goal: "Write to docs",
      allowed_files: ["docs/TASK_BOARD.md"],
      read_targets: [],
      required_files: [],
      verification_commands: [],
    };

    const candidatePaths = getTaskCandidatePaths(taskCard);
    assert.equal(candidatePaths.includes("docs/TASK_BOARD.md"), false, "allowed_files must not be in candidate read paths");

    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: [],
    });

    assert.equal(preflight.status, "PASS", "allowed_files alone must not block task as a required symlink read");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
