// Cleanup for the per-workflow Chrome profiles created by
// config.js's workflowProfileDir (Phase: GPT reviewer browser isolation).
// Deliberately separate from chromeRuntime.js, which owns the *live*
// persistent context — this only ever touches an already-closed profile's
// files on disk, never a running Chrome instance.

import fs from 'node:fs/promises';
import path from 'node:path';
import { workflowProfileDir } from '../config.js';

// Refuses to remove anything outside a `workflows/<id>/chrome-profile`
// directory, so a bad workflowId (e.g. '..') can't be used to delete
// unrelated files.
function assertSafeToRemove(profileDir, workflowId) {
  const expectedSuffix = path.join('workflows', workflowId, 'chrome-profile');
  if (!profileDir.endsWith(expectedSuffix)) {
    throw new Error(`refusing to remove unexpected chrome profile path: ${profileDir}`);
  }
}

// Removes one workflow's Chrome profile directory. Never touches the
// workflow's artifacts (PERSISTENCE.md), which live under a separate
// baseDir entirely (project-local .gpt-dev-loop/workflows/, not this
// home-dir-rooted profile tree).
export async function cleanupWorkflowChromeProfile(workflowId, baseProfileDir) {
  const profileDir = workflowProfileDir(workflowId, baseProfileDir);
  assertSafeToRemove(profileDir, workflowId);
  await fs.rm(profileDir, { recursive: true, force: true });
  return profileDir;
}
