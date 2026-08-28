// Trust boundary tests for the external-read-root implementation.
//
// Proves:
// 1. MCP model-facing tools cannot pass externalReadRoots
// 2. Workspace config root works for a normal supergpt_start
// 3. Persisted policy is exact
// 4. Changing config after workflow start cannot expand resume permissions
// 5. Nonexistent approved root fails closed
// 6. Approved sibling SpinLab-shared still snapshots normally
// 7. Nested escape remains blocked

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
import {
  loadWorkspaceConfig,
  resolveApprovedExternalRoots,
  validateAndCanonicalizeRoots,
  loadAndValidateExternalRoots,
  ExternalReadRootConfigError,
} from "../src/orchestrator/workspaceConfig.js";

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

// =============================================================================
// 1. MCP model-facing tools cannot pass externalReadRoots
// =============================================================================

test("Trust boundary 1: supergpt_run schema does not expose externalReadRoots", async () => {
  const { client } = await createTestMcpClient({
    runSuperGptFn: async () => ({ status: "WORKFLOW_DONE", deliveredFiles: [] }),
  });
  const { tools } = await client.listTools();

  const run = tools.find((t) => t.name === "supergpt_run");
  const props = Object.keys(run.inputSchema.properties);
  assert.ok(!props.includes("externalReadRoots"), "supergpt_run must not expose externalReadRoots in schema");

  await client.close();
});

test("Trust boundary 1: supergpt_start schema does not expose externalReadRoots", async () => {
  const { client } = await createTestMcpClient({
    startSuperGptFn: () => ({ status: "RUNNING", workflowId: "wf-test" }),
  });
  const { tools } = await client.listTools();

  const start = tools.find((t) => t.name === "supergpt_start");
  const props = Object.keys(start.inputSchema.properties);
  assert.ok(!props.includes("externalReadRoots"), "supergpt_start must not expose externalReadRoots in schema");

  await client.close();
});

test("Trust boundary 1: supergpt_resume schema does not expose externalReadRoots", async () => {
  const { client } = await createTestMcpClient({
    resumeSuperGptFn: async () => ({ status: "WORKFLOW_DONE", deliveredFiles: [] }),
  });
  const { tools } = await client.listTools();

  const resume = tools.find((t) => t.name === "supergpt_resume");
  const props = Object.keys(resume.inputSchema.properties);
  assert.ok(!props.includes("externalReadRoots"), "supergpt_resume must not expose externalReadRoots in schema");

  await client.close();
});

test("Trust boundary 1: supergpt_run handler ignores externalReadRoots even if injected", async () => {
  let receivedOpts = null;
  const { client } = await createTestMcpClient({
    runSuperGptFn: async (opts) => {
      receivedOpts = opts;
      return { status: "WORKFLOW_DONE", deliveredFiles: [] };
    },
  });

  // Even if a model somehow passes externalReadRoots, the handler strips it
  const res = await client.callTool({
    name: "supergpt_run",
    arguments: { goal: "test", externalReadRoots: ["/etc", "/var"] },
  });

  // The handler should NOT pass externalReadRoots to runSuperGptFn
  assert.equal(receivedOpts.externalReadRoots, undefined, "runSuperGptFn must not receive externalReadRoots from MCP");

  await client.close();
});

// =============================================================================
// 2. Workspace config root works for a normal supergpt_start
// =============================================================================

test("Trust boundary 2: workspace config root auto-loads for normal supergpt_start", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb2-"));
  try {
    const repoDir = path.join(root, "MyProject");
    const sharedDir = path.join(root, "shared-assets");
    fs.mkdirSync(path.join(repoDir, ".supergpt"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "data.json"), '{"key": "value"}');

    initGitRepo(repoDir);
    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../shared-assets"] })
    );
    fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export const ok = true;\n");
    commitAll(repoDir, "initial");

    let pipelineRoots = null;
    const testPipeline = async (opts) => {
      pipelineRoots = opts.externalReadRoots;
      return { status: "WORKFLOW_DONE", summary: "ok", deliveredFiles: [] };
    };

    const result = await runSuperGPT({
      goal: "test workspace config",
      cwd: repoDir,
      _pipeline: testPipeline,
    });

    assert.equal(result.status, "WORKFLOW_DONE");
    assert.ok(Array.isArray(pipelineRoots), "Pipeline must receive external read roots");
    assert.ok(pipelineRoots.length > 0, "Roots from workspace config must be loaded");
    assert.ok(
      pipelineRoots.includes(fs.realpathSync(sharedDir)),
      "Canonical shared-assets root must be in pipeline roots"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// =============================================================================
// 3. Persisted policy is exact
// =============================================================================

test("Trust boundary 3: persisted external_read_roots in metadata is exact canonical list", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb3-"));
  const metadataDir = path.join(os.homedir(), ".supergpt", "worktrees");
  let metaPath = null;

  try {
    const repoDir = path.join(root, "Project");
    const sharedA = path.join(root, "SharedA");
    const sharedB = path.join(root, "SharedB");
    fs.mkdirSync(path.join(repoDir, ".supergpt"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(sharedA, { recursive: true });
    fs.mkdirSync(sharedB, { recursive: true });

    initGitRepo(repoDir);
    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SharedA", "../SharedB"] })
    );
    fs.writeFileSync(path.join(repoDir, "src", "main.js"), "export const v = 1;\n");
    commitAll(repoDir, "init");

    // The pipeline intercepts and writes metadata like defaultPipeline would
    let pipelineReceivedRoots = null;
    const testPipeline = async (opts) => {
      pipelineReceivedRoots = opts.externalReadRoots;

      // Simulate what defaultPipeline does: persist workspace metadata with frozen roots
      fs.mkdirSync(metadataDir, { recursive: true });
      metaPath = path.join(metadataDir, `${opts.workflowId}.workspace.json`);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          workflow_id: opts.workflowId,
          source_workspace: repoDir,
          source_repo_root: repoDir,
          source_branch: "main",
          baseline_head: "HEAD",
          isolated_worktree_path: repoDir,
          goal: opts.goal,
          external_read_roots: opts.externalReadRoots,
        }, null, 2)
      );

      return { status: "WORKFLOW_DONE", summary: "ok", deliveredFiles: [] };
    };

    const result = await runSuperGPT({
      goal: "check persisted roots",
      cwd: repoDir,
      _pipeline: testPipeline,
    });

    assert.equal(result.status, "WORKFLOW_DONE");

    // Read the persisted metadata
    assert.ok(metaPath && fs.existsSync(metaPath), "Workflow metadata must be persisted");
    const persistedMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.ok(Array.isArray(persistedMeta.external_read_roots), "Metadata must contain external_read_roots");

    const canonicalA = fs.realpathSync(sharedA);
    const canonicalB = fs.realpathSync(sharedB);
    assert.ok(
      persistedMeta.external_read_roots.includes(canonicalA),
      `Persisted roots must include canonical SharedA (${canonicalA})`
    );
    assert.ok(
      persistedMeta.external_read_roots.includes(canonicalB),
      `Persisted roots must include canonical SharedB (${canonicalB})`
    );
    assert.equal(
      persistedMeta.external_read_roots.length,
      2,
      "Persisted roots must be exactly 2 (no duplicates, no extras)"
    );

    // Also verify pipeline received the exact same roots
    assert.ok(pipelineReceivedRoots.includes(canonicalA));
    assert.ok(pipelineReceivedRoots.includes(canonicalB));
    assert.equal(pipelineReceivedRoots.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (metaPath) fs.rmSync(metaPath, { force: true });
  }
});

// =============================================================================
// 4. Changing config after workflow start cannot expand resume permissions
// =============================================================================

test("Trust boundary 4: resume uses frozen policy, ignoring config changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb4-"));
  const metadataDir = path.join(os.homedir(), ".supergpt", "worktrees");
  const workflowId = "wf-frozen-policy-test-" + Date.now();
  const metaPath = path.join(metadataDir, `${workflowId}.workspace.json`);

  try {
    const repoDir = path.join(root, "SpinLab");
    const sharedA = path.join(root, "SharedA");
    const sharedB = path.join(root, "SharedB");
    fs.mkdirSync(path.join(repoDir, ".supergpt"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(sharedA, { recursive: true });
    fs.mkdirSync(sharedB, { recursive: true });

    initGitRepo(repoDir);

    // Initial config: only SharedA
    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SharedA"] })
    );
    fs.writeFileSync(path.join(repoDir, "src", "index.js"), "export const ok = true;\n");
    commitAll(repoDir, "init");

    const canonicalA = fs.realpathSync(sharedA);
    const canonicalB = fs.realpathSync(sharedB);

    // --- Phase 1: Start workflow (roots = [A]) ---
    let phase1Roots = null;
    const testPipeline = async (opts) => {
      phase1Roots = opts.externalReadRoots;

      // Simulate what defaultPipeline does: write workspace metadata with frozen roots
      fs.mkdirSync(metadataDir, { recursive: true });
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          workflow_id: workflowId,
          source_workspace: repoDir,
          source_repo_root: repoDir,
          source_branch: "main",
          baseline_head: "HEAD",
          isolated_worktree_path: repoDir,
          goal: opts.goal,
          external_read_roots: opts.externalReadRoots,
        }, null, 2)
      );

      return {
        status: "HUMAN_REQUIRED",
        reason: "need clarification",
        question: "Which approach?",
      };
    };

    const result1 = await runSuperGPT({
      goal: "do the thing",
      cwd: repoDir,
      workflowId,
      _pipeline: testPipeline,
    });

    assert.equal(result1.status, "HUMAN_REQUIRED");
    assert.ok(phase1Roots.includes(canonicalA), "Phase 1 must have root A");
    assert.ok(!phase1Roots.includes(canonicalB), "Phase 1 must NOT have root B");

    // --- Phase 2: Change config to [A, B] AFTER workflow creation ---
    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SharedA", "../SharedB"] })
    );

    // --- Phase 3: Resume — must still have only [A] ---
    let resumeRoots = null;
    const resumePipeline = async (opts) => {
      resumeRoots = opts.externalReadRoots;
      return {
        status: "WORKFLOW_DONE",
        summary: "resumed",
        deliveredFiles: [],
      };
    };

    const result2 = await supergptResume({
      workflowId,
      answer: "Use option 1",
      cwd: repoDir,
      _pipeline: resumePipeline,
    });

    assert.equal(result2.status, "WORKFLOW_DONE");
    assert.ok(resumeRoots.includes(canonicalA), "Resume must have frozen root A");
    assert.ok(!resumeRoots.includes(canonicalB), "Resume must NOT have newly added root B");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(metaPath, { force: true });
  }
});

// =============================================================================
// 5. Nonexistent approved root fails closed
// =============================================================================

test("Trust boundary 5: nonexistent root fails closed with ExternalReadRootConfigError", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb5-"));
  try {
    const repoDir = path.join(root, "MyRepo");
    fs.mkdirSync(path.join(repoDir, ".supergpt"), { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../DOES_NOT_EXIST"] })
    );

    assert.throws(
      () => loadAndValidateExternalRoots(repoDir),
      (err) => {
        assert.ok(err instanceof ExternalReadRootConfigError, "Must throw ExternalReadRootConfigError");
        assert.ok(err.message.includes("DOES_NOT_EXIST"), "Error message must name the invalid root");
        assert.ok(err.message.includes("realpath"), "Error must mention realpath resolution failure");
        assert.ok(err.details.reason === "realpath_failed", "Details must include reason");
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trust boundary 5: file (not directory) root fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb5b-"));
  try {
    const repoDir = path.join(root, "MyRepo");
    fs.mkdirSync(path.join(repoDir, ".supergpt"), { recursive: true });

    // Create a file, not a directory
    const notDir = path.join(root, "just-a-file.txt");
    fs.writeFileSync(notDir, "I am a file");

    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../just-a-file.txt"] })
    );

    assert.throws(
      () => loadAndValidateExternalRoots(repoDir),
      (err) => {
        assert.ok(err instanceof ExternalReadRootConfigError);
        assert.ok(err.details.reason === "not_directory");
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trust boundary 5: nonexistent root fails closed before model invocation (via runSuperGPT)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb5c-"));
  try {
    const repoDir = path.join(root, "MyRepo");
    fs.mkdirSync(path.join(repoDir, ".supergpt"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });

    initGitRepo(repoDir);
    fs.writeFileSync(
      path.join(repoDir, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../phantom-dir"] })
    );
    fs.writeFileSync(path.join(repoDir, "src", "main.js"), "export const ok = true;\n");
    commitAll(repoDir, "init");

    let pipelineCalled = false;
    const testPipeline = async () => {
      pipelineCalled = true;
      return { status: "WORKFLOW_DONE", deliveredFiles: [] };
    };

    const result = await runSuperGPT({
      goal: "should fail before model calls",
      cwd: repoDir,
      _pipeline: testPipeline,
    });

    // Must fail closed
    assert.equal(result.status, "FAILED");
    assert.ok(result.reason.includes("phantom-dir"), "Error reason must identify the invalid root");
    assert.equal(pipelineCalled, false, "Pipeline must NOT be called when config validation fails");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// =============================================================================
// 6. Approved sibling SpinLab-shared still snapshots normally
// =============================================================================

test("Trust boundary 6: approved sibling snapshots correctly (existing behavior preserved)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb6-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, ".supergpt"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, "src"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });

    initGitRepo(spinLabRepo);

    fs.writeFileSync(
      path.join(spinLabRepo, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SpinLab-shared"] })
    );

    const sharedTarget = path.join(spinLabShared, "TASK_BOARD.md");
    fs.writeFileSync(sharedTarget, "# SpinLab Backlog\n- Task 1: Add widget");

    // Create relative tracked symlink
    const symlinkPath = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(path.join("..", "..", "SpinLab-shared", "TASK_BOARD.md"), symlinkPath);

    fs.writeFileSync(path.join(spinLabRepo, "src", "index.js"), "export const ok = true;\n");
    commitAll(spinLabRepo, "initial commit with tracked symlink and config");

    let preflightSnapshots = [];
    const testPipeline = async (pipelineOpts) => {
      const taskCard = {
        task_id: "task-widget",
        goal: "Implement widget from task board",
        read_targets: ["docs/TASK_BOARD.md"],
        allowed_files: ["src/index.js"],
        verification_commands: [],
      };

      const preflight = await runPreflight({
        taskCard,
        cwd: pipelineOpts.cwd,
        sourceWorkspace: pipelineOpts.cwd,
        externalReadRoots: pipelineOpts.externalReadRoots,
      });

      preflightSnapshots = preflight.snapshots;
      return {
        status: "WORKFLOW_DONE",
        summary: "Widget implemented",
        deliveredFiles: ["src/index.js"],
      };
    };

    const result = await runSuperGPT({
      goal: "Implement widget",
      cwd: spinLabRepo,
      _pipeline: testPipeline,
    });

    assert.equal(result.status, "WORKFLOW_DONE");
    assert.equal(preflightSnapshots.length, 1);
    const snap = preflightSnapshots[0];
    assert.equal(snap.approved_root, fs.realpathSync(spinLabShared));
    assert.equal(snap.read_only, true);
    assert.ok(snap.sha256, "Snapshot must include SHA-256 hash");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// =============================================================================
// 7. Nested escape remains blocked
// =============================================================================

test("Trust boundary 7: nested symlink escape blocked even with approved sibling root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb7-"));
  try {
    const spinLabRepo = path.join(root, "SpinLab");
    const spinLabShared = path.join(root, "SpinLab-shared");
    const forbidden = path.join(root, "forbidden-private");

    fs.mkdirSync(path.join(spinLabRepo, "docs"), { recursive: true });
    fs.mkdirSync(path.join(spinLabRepo, ".supergpt"), { recursive: true });
    fs.mkdirSync(spinLabShared, { recursive: true });
    fs.mkdirSync(forbidden, { recursive: true });

    initGitRepo(spinLabRepo);

    fs.writeFileSync(
      path.join(spinLabRepo, ".supergpt", "config.json"),
      JSON.stringify({ externalReadRoots: ["../SpinLab-shared"] })
    );

    const privateFile = path.join(forbidden, "SSH_KEY.pem");
    fs.writeFileSync(privateFile, "MALICIOUS_KEY_CONTENT");

    // Intermediate symlink inside SpinLab-shared pointing to private file
    const intermediateSymlink = path.join(spinLabShared, "LINK_TO_KEY.md");
    fs.symlinkSync(privateFile, intermediateSymlink);

    // Repo symlink chaining through shared to forbidden
    const repoSymlink = path.join(spinLabRepo, "docs", "TASK_BOARD.md");
    fs.symlinkSync(intermediateSymlink, repoSymlink);
    commitAll(spinLabRepo, "commit malicious escape");

    const taskCard = {
      task_id: "task-malicious",
      goal: "Attempt nested escape",
      read_targets: ["docs/TASK_BOARD.md"],
      allowed_files: [],
      verification_commands: [],
    };

    const preflight = await runPreflight({
      taskCard,
      cwd: spinLabRepo,
      sourceWorkspace: spinLabRepo,
      externalReadRoots: loadAndValidateExternalRoots(spinLabRepo),
    });

    assert.equal(preflight.status, "BLOCKED");
    assert.equal(preflight.blockers.length, 1);
    assert.equal(preflight.blockers[0].type, PREFLIGHT_BLOCKER_TYPES.SYMLINK_OUTSIDE_WORKSPACE);
    assert.equal(preflight.blockers[0].target, fs.realpathSync(privateFile));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// =============================================================================
// Strict validation unit tests
// =============================================================================

test("validateAndCanonicalizeRoots rejects root that is a symlink to nonexistent target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb-symlink-"));
  try {
    const dangling = path.join(root, "dangling-link");
    fs.symlinkSync("/nonexistent/path/asdf1234", dangling);

    assert.throws(
      () => validateAndCanonicalizeRoots(["dangling-link"], root),
      (err) => err instanceof ExternalReadRootConfigError && err.details.reason === "realpath_failed"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateAndCanonicalizeRoots deduplicates equivalent paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb-dedup-"));
  try {
    const dir = path.join(root, "shared");
    fs.mkdirSync(dir);

    const result = validateAndCanonicalizeRoots(
      ["./shared", "../" + path.basename(root) + "/shared", "shared"],
      root
    );

    assert.equal(result.length, 1, "Equivalent paths must deduplicate to one entry");
    assert.equal(result[0], fs.realpathSync(dir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadAndValidateExternalRoots returns empty array when no config exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supergpt-tb-noconfig-"));
  try {
    const result = loadAndValidateExternalRoots(root);
    assert.deepEqual(result, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
