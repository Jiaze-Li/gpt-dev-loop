// One isolated, empty working directory shared by every narrow Reviewer /
// Supervisor transport (agy, codex, claude). Running the CLIs from here means
// there is no repo, no CLAUDE.md / GEMINI.md / AGENTS.md, no project or agent
// memory for them to preload — the single biggest transport-context lever.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

let dir;

export function narrowReviewTransportCwd() {
  if (dir) return dir;
  const d = path.join(os.tmpdir(), 'reviewloop-review-transport');
  try { mkdirSync(d, { recursive: true }); } catch { /* best effort; the CLI still runs */ }
  dir = d;
  return d;
}
