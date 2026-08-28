// Minimal JSON-file persistence shared by the two-phase attach/resume live
// E2E scripts (test-supervisor-attach-live.js, test-reviewer-attach-live.js).
// Deliberately not src/orchestrator/persistence.js — that implements full
// workflow state.json/events.jsonl crash recovery per
// docs/workflow/PERSISTENCE.md, which is explicitly out of scope for this
// primitive (see the attach() primitive's own doc comments in
// src/bridge/supervisorSession.js / reviewerSession.js). All this needs to
// prove is that a conversationId written by one Node process can be read
// back by a completely separate later process — a single small JSON file is
// sufficient and does not pretend to be more than that.
//
// Lives under .gpt-dev-loop/ (already gitignored) so a real conversationId
// captured against your live ChatGPT account is never committed.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE_DIR = path.join(process.cwd(), '.gpt-dev-loop');

export function defaultStatePath(name) {
  return path.join(DEFAULT_STATE_DIR, `${name}.json`);
}

export async function writeSessionState(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function readSessionState(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}
