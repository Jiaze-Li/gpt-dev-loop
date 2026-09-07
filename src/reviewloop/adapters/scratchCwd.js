// Isolated filesystem locations shared by the narrow Reviewer / Supervisor
// transports (agy, codex, claude).
//
//   narrowReviewTransportCwd() — one empty working directory the CLIs run FROM.
//     No repo, no CLAUDE.md / GEMINI.md / AGENTS.md, no project or agent memory
//     to preload.
//
//   narrowAgyGeminiDir() — an isolated "gemini dir" the AGY transport points at
//     via `--gemini_dir`. agy 1.1.27 only discovers custom agents from its
//     gemini-dir config tree (never a workspace `.agents/`), and the real
//     `~/.gemini` is off-limits (user data + daily `agy`). This redirected dir
//     is where the `reviewloop-minimal` agent is provisioned and where agy
//     writes its own logs/cache — so nothing leaks into the user's `~/.gemini`.
//     Auth is unaffected: agy authenticates via the OS keyring, not this dir.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

let cwdDir;
let geminiDir;

export function narrowReviewTransportCwd() {
  if (cwdDir) return cwdDir;
  const d = path.join(os.tmpdir(), 'reviewloop-review-transport');
  try { mkdirSync(d, { recursive: true }); } catch { /* best effort; the CLI still runs */ }
  cwdDir = d;
  return d;
}

export function narrowAgyGeminiDir() {
  if (geminiDir) return geminiDir;
  const d = path.join(os.tmpdir(), 'reviewloop-agy-home');
  try { mkdirSync(d, { recursive: true }); } catch { /* best effort */ }
  geminiDir = d;
  return d;
}
