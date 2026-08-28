// WorkflowLifecycleManager — automatic lifecycle management for SuperGPT-owned
// Git worktrees, temporary branches, and sandboxes.
//
// Rules (PHASE B6 & B7):
//   - SuperGPT owns all internal Git resources it creates.
//   - The user must never manually clean them.
//   - Track every worktree, temporary branch, and task sandbox per workflow.
//   - Invariant: NEVER delete invocation workspace, invocation branch, user branches,
//     or non-SuperGPT worktrees.
//   - Init failure -> immediate cleanup of worktree, branch, and metadata prune.
//   - WORKFLOW_DONE + delivered -> complete cleanup of worktree, branch, prune.
//   - FAILED / HUMAN_REQUIRED -> preserve resources for debug/resume.
//   - Conservative Garbage Collection (GC) for abandoned SuperGPT-owned resources.

import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { readdir, stat, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SUPERGPT_WORKTREE_ROOT } from './workflowWorktree.js';

export function isSuperGptOwnedWorktree(targetPath, root = SUPERGPT_WORKTREE_ROOT) {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(root);

  // Must be strictly inside the SuperGPT worktrees root
  if (!resolvedTarget.startsWith(resolvedRoot) || resolvedTarget === resolvedRoot) {
    return false;
  }

  // Must follow SuperGPT naming convention containing -wf-agy- or -wf-
  const basename = path.basename(resolvedTarget);
  return /-wf-(agy-)?[0-9a-fA-F-]+/.test(basename);
}

export function isSuperGptOwnedBranch(branchName) {
  if (typeof branchName !== 'string' || !branchName) return false;
  return branchName.startsWith('supergpt/wf-');
}

function runGit(args, cwd, spawn = nodeSpawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
    child.on('close', (code) => {
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // Process exists but owned by another user
  }
}

export class WorkflowLifecycleManager {
  constructor({
    workflowId,
    root = SUPERGPT_WORKTREE_ROOT,
    sourceCwd = process.cwd(),
    spawn = nodeSpawn,
  } = {}) {
    if (!workflowId) throw new Error('WorkflowLifecycleManager requires a workflowId');
    this.workflowId = workflowId;
    this.root = root;
    this.sourceCwd = sourceCwd;
    this.spawn = spawn;
    this.resourcesPath = path.join(root, `${workflowId}.resources.json`);

    this.resources = {
      workflowId,
      worktrees: [], // array of { path, taskId, createdAt }
      branches: [], // array of { name, taskId, createdAt }
      sandboxes: {}, // task-specific sandboxes (B7 parallel compatibility)
      status: 'ACTIVE', // ACTIVE | PRESERVED | CLEANED
    };
  }

  async persist() {
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(this.resourcesPath, `${JSON.stringify(this.resources, null, 2)}\n`, 'utf8');
    } catch {
      /* best effort */
    }
  }

  async load() {
    try {
      if (existsSync(this.resourcesPath)) {
        const raw = await readFile(this.resourcesPath, 'utf8');
        this.resources = JSON.parse(raw);
      }
    } catch {
      /* best effort */
    }
  }

  trackWorktree(worktreePath, { taskId = null, branch = null } = {}) {
    if (!isSuperGptOwnedWorktree(worktreePath, this.root)) {
      throw new Error(`Refusing to track non-SuperGPT worktree path: ${worktreePath}`);
    }
    const existing = this.resources.worktrees.find((w) => w.path === worktreePath);
    if (!existing) {
      this.resources.worktrees.push({
        path: worktreePath,
        taskId,
        createdAt: new Date().toISOString(),
      });
    }
    if (taskId) {
      this.resources.sandboxes[taskId] = worktreePath;
    }
    if (branch) {
      this.trackBranch(branch, { taskId });
    }
    this.persist();
  }

  trackBranch(branchName, { taskId = null } = {}) {
    if (!isSuperGptOwnedBranch(branchName)) {
      throw new Error(`Refusing to track non-SuperGPT branch name: ${branchName}`);
    }
    const existing = this.resources.branches.find((b) => b.name === branchName);
    if (!existing) {
      this.resources.branches.push({
        name: branchName,
        taskId,
        createdAt: new Date().toISOString(),
      });
    }
    this.persist();
  }

  async removeSingleWorktree(worktreePath) {
    if (!isSuperGptOwnedWorktree(worktreePath, this.root)) {
      return { skipped: true, reason: 'not_owned' };
    }

    // Attempt clean git worktree remove
    const removeRes = await runGit(['worktree', 'remove', '--force', worktreePath], this.sourceCwd, this.spawn);

    // If git remove failed because the directory was already altered, remove directory directly
    if (existsSync(worktreePath)) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }

    return { removed: worktreePath, code: removeRes.code };
  }

  async removeSingleBranch(branchName) {
    if (!isSuperGptOwnedBranch(branchName)) {
      return { skipped: true, reason: 'not_owned' };
    }
    const res = await runGit(['branch', '-D', branchName], this.sourceCwd, this.spawn);
    return { removed: branchName, code: res.code };
  }

  /**
   * Called on initialization failure before useful work has run (PHASE B6).
   * Teardown worktrees, temporary branches, prune git worktree metadata.
   */
  async onInitFailed() {
    await this.load();
    for (const wt of this.resources.worktrees) {
      await this.removeSingleWorktree(wt.path);
    }
    for (const b of this.resources.branches) {
      await this.removeSingleBranch(b.name);
    }
    await runGit(['worktree', 'prune'], this.sourceCwd, this.spawn);

    // Clean up resource file and workspace metadata
    try {
      await rm(this.resourcesPath, { force: true });
      const wsMeta = path.join(this.root, `${this.workflowId}.workspace.json`);
      await rm(wsMeta, { force: true });
      const statePath = path.join(this.root, `${this.workflowId}.state.json`);
      await rm(statePath, { force: true });
    } catch {
      /* best effort */
    }
  }

  /**
   * Called on successful delivery to the invocation workspace (PHASE B6).
   * Clean up all worktrees and temporary branches for this workflow.
   */
  async onWorkflowDelivered() {
    await this.load();
    for (const wt of this.resources.worktrees) {
      await this.removeSingleWorktree(wt.path);
    }
    for (const b of this.resources.branches) {
      await this.removeSingleBranch(b.name);
    }
    await runGit(['worktree', 'prune'], this.sourceCwd, this.spawn);

    this.resources.status = 'CLEANED';
    await this.persist();
  }

  /**
   * Called when workflow is suspended or failed (HUMAN_REQUIRED, FAILED) (PHASE B6).
   * Preserves resources for debug / resume.
   */
  async onWorkflowSuspended(reason = 'suspended') {
    await this.load();
    this.resources.status = 'PRESERVED';
    this.resources.suspendedReason = reason;
    await this.persist();
  }
}

/**
 * Conservative Garbage Collection for abandoned SuperGPT-owned resources (PHASE B6).
 *
 * Rules:
 *   - Only touches worktrees matching explicit SuperGPT naming pattern in SUPERGPT_WORKTREE_ROOT.
 *   - Checks if any recorded child process is still alive.
 *   - Prunes stale Git worktree metadata.
 *   - Never deletes invocation workspace, invocation branch, or user branches.
 */
export async function gcSuperGptResources({
  root = SUPERGPT_WORKTREE_ROOT,
  maxAgeMs = 24 * 60 * 60 * 1000, // 24 hours default
  sourceCwd = process.cwd(),
  spawn = nodeSpawn,
} = {}) {
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    return { cleanedWorktrees: [], prunedBranches: [], errors: [] };
  }

  const cleanedWorktrees = [];
  const errors = [];
  const now = Date.now();

  for (const name of entries) {
    const fullPath = path.join(root, name);
    if (!isSuperGptOwnedWorktree(fullPath, root)) continue;

    let dirStat;
    try {
      dirStat = await stat(fullPath);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Check age
    const ageMs = now - dirStat.mtimeMs;
    const isStaleByAge = ageMs > maxAgeMs;

    // Check associated workflow state if exists
    let isActiveProcess = false;
    let isFinishedWorkflow = false;
    let isResumable = false;

    // Try finding workflow ID from folder name
    const match = name.match(/-wf-(?:agy-)?[a-zA-Z0-9_-]+/);
    if (match) {
      const wfId = match[0].replace(/^-/, '');
      const stateFile = path.join(root, `${wfId}.state.json`);
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(await readFile(stateFile, 'utf8'));
          if (Array.isArray(state.activeProcesses)) {
            for (const proc of state.activeProcesses) {
              if (isProcessAlive(proc.pid)) {
                isActiveProcess = true;
                break;
              }
            }
          }
          if (['DONE', 'CLEANED', 'STOPPED'].includes(state.workflowStatus)) {
            isFinishedWorkflow = true;
          }
          // A workflow suspended for a human is deliberately idle (no child
          // process) but holds un-delivered edits and is explicitly
          // resumable — it must NOT be treated as age-expired garbage.
          if (state.workflowStatus === 'HUMAN_REQUIRED') {
            isResumable = true;
          }
        } catch {
          /* best effort state check */
        }
      }

      // Explicit resumable markers survive even without a readable state file.
      const controlFile = path.join(root, `${wfId}.control.json`);
      if (existsSync(controlFile)) {
        try {
          const c = JSON.parse(await readFile(controlFile, 'utf8'));
          if (c?.owner?.pid && isProcessAlive(c.owner.pid)) {
            isActiveProcess = true;
          }
          if (c.resumable === true || c.phase === 'delivery_ready') isResumable = true;
        } catch {
          /* best effort */
        }
      }
      const resourcesFile = path.join(root, `${wfId}.resources.json`);
      if (existsSync(resourcesFile)) {
        try {
          const r = JSON.parse(await readFile(resourcesFile, 'utf8'));
          if (r.status === 'PRESERVED') isResumable = true;
        } catch {
          /* best effort */
        }
      }
    }

    if (isActiveProcess) {
      // Actively running workflow — leave intact!
      continue;
    }

    // A finished workflow is disposable regardless of resumable markers
    // (delivered/stopped state is authoritative). Otherwise, an explicitly
    // resumable workflow is protected from age-based collection.
    if (!isFinishedWorkflow && isResumable) {
      continue;
    }

    if (isFinishedWorkflow || isStaleByAge) {
      try {
        await runGit(['worktree', 'remove', '--force', fullPath], sourceCwd, spawn);
        if (existsSync(fullPath)) {
          await rm(fullPath, { recursive: true, force: true });
        }
        cleanedWorktrees.push(fullPath);
      } catch (err) {
        errors.push({ path: fullPath, error: err.message });
      }
    }
  }

  // Prune any stale metadata from Git
  await runGit(['worktree', 'prune'], sourceCwd, spawn);

  return { cleanedWorktrees, errors };
}
