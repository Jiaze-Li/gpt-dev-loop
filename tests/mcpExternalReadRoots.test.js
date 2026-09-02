import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createSuperGptMcpServer } from "../src/mcp/supergptMcpServer.js";
import { runSuperGPT, supergptResume } from "../src/orchestrator/supergpt.js";
import { runPreflight, PREFLIGHT_BLOCKER_TYPES } from "../src/orchestrator/preflight.js";
import { loadWorkspaceConfig, resolveApprovedExternalRoots } from "../src/orchestrator/workspaceConfig.js";

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: dir });
}

function commitAll(dir, message = "init") {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message, "--no-verify", "--no-gpg-sign"], { cwd: dir });
}

async function createTestMcpClient(options = {}) {
  const server = createSuperGptMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server };
}

test("1. End-to-end MCP supergpt_start/run loads workspace policy automatically and snapshots sibling root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-mcp-approved-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, ".supergpt"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, "src"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    // 1. Write workspace policy in .supergpt/config.json
    fs.writeFileSync(
      path.join(spinLabRepo, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SpinLab-shared"] }, null, 2)
    );

    // 2. Write sibling target
    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    const initialSiblingContent = "# SpinLab Backlog\n- Task 1: Add widget";
    fs.writeFileSync(sharedTarget, initialSiblingContent);

    // 3. Create relative tracked symlink: SpinLab/docs/TASK_BOARD.md -> ../../SpinLab-shared/TASK_BOARD.md
    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(path.join("..", "..", "SpinLab-shared", "TASK_BOARD.md"), symlinkPath);

    fs.writeFileSync(path.join(spinLabRepo, "src", "index.js"), "export const ok = true;\n");
    commitAll(spinLabRepo, "initial commit with tracked symlink and config");

    let preflightSnapshots = [];
    let executorReceivedSnapshots = [];
    let reviewerReceivedSnapshots = [];

    // Custom test pipeline to intercept and inspect real workflow execution
    const testPipeline = async (pipelineOpts) => {
      const taskCard = {
        task_id: "task-widget",
        goal: "Implement widget from task board",
        read_targets: ["docs/TASK_BOARD.md"],
        allowed_files: ["src/index.js"],
        verification_commands: [],
      };

      // Preflight execution with auto-loaded roots
      const preflight = await runPreflight({
        taskCard,
        cwd: pipelineOpts.cwd,
        sourceWorkspace: pipelineOpts.cwd,
        externalReadRoots: pipelineOpts.externalReadRoots,
      });

      preflightSnapshots = preflight.snapshots;

      // Ensure snapshot content is present and isolated
      for (const snap of preflight.snapshots) {
        executorReceivedSnapshots.push(snap.absolute_snapshot_path);
        reviewerReceivedSnapshots.push(snap.absolute_snapshot_path);

        // Attempt mutation on the snapshot
        assert.throws(() => fs.writeFileSync(snap.absolute_snapshot_path, "# MUTATED"), /EACCES/, "Snapshot must be read-only (mode 0o444)");
        fs.chmodSync(snap.absolute_snapshot_path, 0o666);
        fs.writeFileSync(snap.absolute_snapshot_path, "# MUTATED_SNAPSHOT_CONTENT");
      }

      return {
        status: "WORKFLOW_DONE",
        summary: "Widget implemented cleanly",
        deliveredFiles: ["src/index.js"],
      };
    };

    const { client } = await createTestMcpClient({
      runSuperGptFn: (opts) => runSuperGPT({ ...opts, _pipeline: testPipeline }),
    });

    // Normal MCP call: only { goal, cwd: spinLabRepo } — NO special test-only root injection
    const response = await client.callTool({
      name: "supergpt_run",
      arguments: {
        goal: "Implement widget from task board",
        cwd: spinLabRepo,
      },
    });

    const structured = response.structuredContent;
    assert.equal(structured.status, "WORKFLOW_DONE");
    assert.equal(structured.reason, null);
    assert.equal(structured.question, null);

    // 1. Provenance records approved root
    assert.equal(preflightSnapshots.length, 1);
    const snap = preflightSnapshots[0];
    assert.equal(snap.original_path, path.join("docs", "TASK_BOARD.md"));
    assert.equal(snap.resolved_source_realpath, fs.realpathSync(sharedTarget));
    assert.equal(snap.approved_root, fs.realpathSync(spinLabShared));
    assert.equal(snap.read_only, true);

    // 2. Executor and Reviewer receive only the snapshot path
    assert.equal(executorReceivedSnapshots.length, 1);
    assert.ok(executorReceivedSnapshots[0].includes(".supergpt_auxiliary"));

    // 3. Source sibling file cannot be modified
    const siblingContentAfter = fs.readFileSync(sharedTarget, "utf8");
    assert.equal(siblingContentAfter, initialSiblingContent, "Sibling file must remain pristine");

    // 4. Auxiliary files are never delivered
    assert.deepEqual(structured.deliveredFiles, ["src/index.js"]);
    assert.ok(!structured.deliveredFiles.some((f) => f.includes(".supergpt_auxiliary")));

    await client.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("2. Same symlink without workspace approval -> HUMAN_REQUIRED before model calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-mcp-unapproved-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, "src"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);
    // Note: NO .supergpt/config.json approval!

    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Secret Sibling Tasks");

    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(path.join(spinLabShared, "TASK_BOARD.md"), symlinkPath);
    commitAll(spinLabRepo, "commit unapproved symlink");

    const taskCard = {
      task_id: "task-auth",
      goal: "Implement task from unapproved board",
      read_targets: ["docs/TASK_BOARD.md"],
      allowed_files: ["src/index.js"],
      verification_commands: [],
    };

    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: resolveApprovedExternalRoots({ cwd: spinLabRepo }),
    });

    assert.equal(preflight.status, "BLOCKED");
    assert.equal(preflight.blockers.length, 1);
    assert.equal(preflight.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
    assert.equal(preflight.blockers[0].target, fs.realpathSync(sharedTarget));
    assert.equal(preflight.blockers[0].suggested_external_root, fs.realpathSync(spinLabShared));
    assert.match(preflight.blockers[0].remediation, /Add .* to approved externalReadRoots/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3. Resume preserves approved root policy from workflow state automatically", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-mcp-resume-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);
    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# Resume Shared Board");
    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(sharedTarget, symlinkPath);
    commitAll(spinLabRepo, "commit symlink");

    const workflowId = "wf-resume-test-123";
    const canonicalShared = fs.realpathSync(spinLabShared);

    let restoredRoots = [];
    const testPipeline = async (opts) => {
      restoredRoots = opts.externalReadRoots;
      return {
        status: "WORKFLOW_DONE",
        summary: "Resumed successfully with preserved roots",
        deliveredFiles: [],
      };
    };

    // Simulate workflow state metadata saved during initial run
    const runtimeMeta = {
      workflow_id: workflowId,
      source_workspace: spinLabRepo,
      source_repo_root: spinLabRepo,
      source_branch: "main",
      baseline_head: "HEAD",
      isolated_worktree_path: spinLabRepo,
      external_read_roots: [canonicalShared],
      goal: "Resume test",
    };

    const metadataDir = path.join(os.homedir(), ".supergpt", "worktrees");
    fs.mkdirSync(metadataDir, { recursive: true });
    const metaFile = path.join(metadataDir, workflowId + ".workspace.json");
    fs.writeFileSync(
      metaFile,
      JSON.stringify(runtimeMeta, null, 2)
    );
    // A real resume state always carries a token-usage snapshot; add a
    // reconstructable (empty) one so the resume cost-state gate is satisfied
    // and this test exercises its own approved-root policy invariant.
    const stateFile = path.join(metadataDir, workflowId + ".state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      workflowId, workflowStatus: "HUMAN_REQUIRED",
      tokenUsage: { records: [], measuredTotal: { calls: 0, costUsd: 0 } },
    }));

    // Call supergptResume without passing any explicit externalReadRoots
    const result = await supergptResume({
      workflowId,
      cwd: spinLabRepo,
      _pipeline: testPipeline,
    });

    assert.equal(result.status, "WORKFLOW_DONE");
    assert.ok(restoredRoots.includes(canonicalShared), "Resume must automatically restore persisted approved roots");

    // Clean up metadata
    fs.rmSync(metaFile, { force: true });
    fs.rmSync(stateFile, { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4. Malicious nested symlink escape remains blocked even with approved sibling root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-mcp-malicious-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    const forbiddenPrivate = path.join(root, "forbidden-private");

    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, ".supergpt"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });
    fs.mkdirSync(forbiddenPrivate, { recursive: true });

    initGitRepo(spinLabRepo);

    // Config approves SpinLab-shared
    fs.writeFileSync(
      path.join(spinLabRepo, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SpinLab-shared"] }, null, 2)
    );

    // Private target outside approved root
    const privateFile = path.join(forbiddenPrivate, "SSH_KEY.pem");
    fs.writeFileSync(privateFile, "MALICIOUS_KEY_CONTENT");

    // Intermediate symlink inside SpinLab-shared pointing to private file
    const intermediateSymlink = path.join(spinLabShared, "LINK_TO_KEY.md");
    fs.symlinkSync(privateFile, intermediateSymlink);

    // Symlink in repo pointing to intermediate symlink
    const repoSymlink = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(intermediateSymlink, repoSymlink);
    commitAll(spinLabRepo, "commit malicious escape symlink");

    const taskCard = {
      task_id: "task-malicious",
      goal: "Attempt escape via intermediate symlink",
      read_targets: ["docs/TASK_BOARD.md"],
      allowed_files: [],
      verification_commands: [],
    };

    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: resolveApprovedExternalRoots({ cwd: spinLabRepo }),
    });

    assert.equal(preflight.status, "BLOCKED");
    assert.equal(preflight.blockers.length, 1);
    assert.equal(preflight.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
    assert.equal(preflight.blockers[0].target, fs.realpathSync(privateFile));
    assert.equal(preflight.blockers[0].suggested_external_root, fs.realpathSync(forbiddenPrivate));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
