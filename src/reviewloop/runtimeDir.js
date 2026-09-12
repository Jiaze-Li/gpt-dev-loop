// ReviewLoop runtime/state root.
//
//   ~/.reviewloop        active runtime state (durable loop state, ledgers)
//
// ~/.supergpt is NOT read or written by ReviewLoop. Old V2 SuperGPT state is
// historical user data — never auto-resumed, never migrated in place. A fresh
// ReviewLoop session must not accidentally continue a V2 workflow.

import os from 'node:os';
import path from 'node:path';

export function resolveReviewLoopRuntimeRoot(env = process.env, homeDir = os.homedir()) {
  if (env.REVIEWLOOP_RUNTIME_DIR) return env.REVIEWLOOP_RUNTIME_DIR;
  return path.join(homeDir, '.reviewloop');
}

export const REVIEWLOOP_RUNTIME_ROOT = resolveReviewLoopRuntimeRoot();

// State-file / persistence schema prefix. No fresh state is ever written under
// a `supergpt.*` schema.
export const REVIEWLOOP_SCHEMA_PREFIX = 'reviewloop';
