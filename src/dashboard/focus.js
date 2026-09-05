// Dashboard Focus Tracking Module.
//
// Maintains the latest explicit USER workflow focus for the local Dashboard UI.
// Rules:
//   - Only a top-level USER workflow initiated by a new user prompt (e.g. supergpt_start)
//     can update the Dashboard focus.
//   - INTERNAL_TEST / test workflows and background tasks are strictly forbidden
//     from updating focus.
//   - Focus is purely UI presentation state; it is NOT an orchestrator / Core state truth.
//   - Zero model tokens, safe atomic file operations, loopback only.

import fs from 'node:fs';
import path from 'node:path';
import { SUPERGPT_WORKTREE_ROOT } from '../orchestrator/workflowWorktree.js';
import { isTestWorkflowId, validateWorkflowId } from '../orchestrator/workflowId.js';

const FOCUS_FILE_NAME = '.dashboard_focus.json';

export function getDashboardFocusFilePath(root = SUPERGPT_WORKTREE_ROOT) {
  return path.join(root, FOCUS_FILE_NAME);
}

export function recordDashboardFocus({
  workflowId,
  kind = 'USER',
  root = SUPERGPT_WORKTREE_ROOT,
} = {}) {
  if (!workflowId || typeof workflowId !== 'string') return null;
  try {
    validateWorkflowId(workflowId);
  } catch {
    return null;
  }

  // INTERNAL_TEST and test workflow IDs can NEVER set user focus.
  if (kind === 'INTERNAL_TEST' || isTestWorkflowId(workflowId)) {
    return null;
  }

  try {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    const focusData = {
      focusWorkflowId: workflowId,
      kind: 'USER',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(getDashboardFocusFilePath(root), JSON.stringify(focusData, null, 2), 'utf8');
    return focusData;
  } catch {
    return null;
  }
}

export function getDashboardFocus({ root = SUPERGPT_WORKTREE_ROOT } = {}) {
  try {
    const focusPath = getDashboardFocusFilePath(root);
    if (!fs.existsSync(focusPath)) return null;
    const raw = fs.readFileSync(focusPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.focusWorkflowId) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearDashboardFocus({ root = SUPERGPT_WORKTREE_ROOT } = {}) {
  try {
    const focusPath = getDashboardFocusFilePath(root);
    if (fs.existsSync(focusPath)) {
      fs.unlinkSync(focusPath);
    }
    return true;
  } catch {
    return false;
  }
}
