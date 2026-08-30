// Central workflow-ID validation + path containment.
//
// Workflow IDs flow from public entrypoints (run/start/status/watch/wait/
// stop/resume/verify, MCP handlers, the CLI) straight into durable
// filesystem paths:
//
//   path.join(root, `${workflowId}.control.json`)
//   path.join(root, `${workflowId}.stop.json`)
//   path.join(root, `${workflowId}.owner.lock`)
//   path.join(SUPERGPT_WORKTREE_ROOT, workflowId, 'persistence')
//   ...
//
// An unconstrained ID such as "../escape" or "/tmp/escape" would let those
// joins normalise OUTSIDE SUPERGPT_WORKTREE_ROOT — a path-traversal write /
// read / delete primitive. Every public API and every low-level durable
// path constructor MUST run the ID through validateWorkflowId() BEFORE the
// first path is constructed. We never silently sanitise: an invalid ID is a
// hard, typed failure.

import path from 'node:path';

export class WorkflowIdError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'WorkflowIdError';
    this.code = 'INVALID_WORKFLOW_ID';
    if (details && typeof details === 'object') this.details = details;
  }
}

// Deliberately narrow. Must stay compatible with every generated ID:
//   wf-<uuid>            (workflowManager)
//   wf-agy-<uuid>        (supergpt runSuperGPT / startSuperGPT)
// and permissive enough for hand-authored IDs like "my-workflow_123".
//   - first char: ASCII alphanumeric (no leading "." / "-" )
//   - rest: ASCII alphanumeric plus "." "_" "-"
//   - total length 1..128
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const WORKFLOW_ID_MAX_LENGTH = 128;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// Validate a workflow ID. Returns the ID unchanged on success; throws
// WorkflowIdError (code INVALID_WORKFLOW_ID) otherwise. Never mutates or
// "cleans" the input.
export function validateWorkflowId(workflowId) {
  if (typeof workflowId !== 'string') {
    throw new WorkflowIdError(
      `workflow id must be a non-empty string, got ${workflowId === null ? 'null' : typeof workflowId}`
    );
  }
  if (workflowId.length === 0) {
    throw new WorkflowIdError('workflow id must not be empty');
  }
  if (workflowId.length > WORKFLOW_ID_MAX_LENGTH) {
    throw new WorkflowIdError(
      `workflow id is ${workflowId.length} chars, over the ${WORKFLOW_ID_MAX_LENGTH}-char limit`
    );
  }
  if (CONTROL_CHAR_RE.test(workflowId)) {
    throw new WorkflowIdError('workflow id contains a NUL or control character');
  }
  // Explicit traversal / separator / absolute-path rejection with a clear
  // reason, before the catch-all pattern check. Windows-style "\" and drive
  // letters are rejected on POSIX too so they can never become portable
  // attack input.
  if (workflowId.includes('/') || workflowId.includes('\\')) {
    throw new WorkflowIdError('workflow id must not contain a path separator');
  }
  if (workflowId.includes('..')) {
    throw new WorkflowIdError('workflow id must not contain ".."');
  }
  if (workflowId === '.' || workflowId === '..') {
    throw new WorkflowIdError('workflow id must not be a relative path segment');
  }
  if (path.isAbsolute(workflowId) || /^[A-Za-z]:/.test(workflowId)) {
    throw new WorkflowIdError('workflow id must not be an absolute path');
  }
  // A safe ID is its own basename — no directory component survives.
  if (path.basename(workflowId) !== workflowId) {
    throw new WorkflowIdError('workflow id must not contain a directory component');
  }
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new WorkflowIdError(
      `workflow id does not match the required format ${WORKFLOW_ID_PATTERN}`
    );
  }
  return workflowId;
}

// Defence-in-depth path containment. Given a trusted root and a candidate
// path derived from (already-validated) caller input, assert the resolved
// candidate is strictly inside the resolved root. Separator-aware so
// "/root/foobar" is NOT considered inside "/root/foo".
export function assertPathWithinRoot(root, candidate, label = 'path') {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  const escapes =
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (resolved !== resolvedRoot && escapes) {
    throw new WorkflowIdError(
      `refusing to use ${label} outside the SuperGPT worktree root`,
      { root: resolvedRoot, resolved }
    );
  }
  return resolved;
}

// Convenience: validate the ID and return a contained durable path
// `<root>/<workflowId><suffix>`.
export function durableWorkflowPath(root, workflowId, suffix = '') {
  validateWorkflowId(workflowId);
  return assertPathWithinRoot(
    root,
    path.join(root, `${workflowId}${suffix}`),
    `"${workflowId}${suffix}"`
  );
}
