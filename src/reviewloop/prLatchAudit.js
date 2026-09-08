// Append-only, hash-chained audit log for PR HUMAN_REQUIRED latch lifecycle
// events. It is the tamper-evident source of truth for "is this PR under an
// unresolved latch" — the per-PR latch state file carries the detail, this log
// says whether that detail can be trusted.
//
// Each line is a JSON object terminated by "\n":
//   { seq, at, prevHash, event, repositoryIdentity, prNumber, latchCount, meta }
// with `hash = sha256(prevHash + "\n" + canonicalJSON(line without hash))`.
//
// A coding agent with filesystem access can still delete or truncate this file
// (ReviewLoop cannot prevent that on a host where the agent shares the user's
// filesystem). What it CANNOT do is edit a line, reorder lines, or splice in a
// forged APPROVAL_CONSUMED without breaking the chain — every read verifies it.
// Full-file loss is detectable only against the surviving per-PR state file;
// that residual is documented, never silently trusted.

import { createHash } from 'node:crypto';
import {
  readFile, appendFile, mkdir,
} from 'node:fs/promises';
import path from 'node:path';

export const PR_LATCH_AUDIT_FILE = 'pr-latch-audit.log';
const GENESIS = 'GENESIS';

export const PR_LATCH_EVENTS = Object.freeze({
  ARMED: 'ARMED',
  APPROVAL_VERIFIED: 'APPROVAL_VERIFIED',
  APPROVAL_CONSUMED: 'APPROVAL_CONSUMED',
  RESOLVED: 'RESOLVED',
});

function canonical(obj) {
  // Deterministic key order for hashing.
  const ordered = {};
  for (const k of Object.keys(obj).sort()) ordered[k] = obj[k];
  return JSON.stringify(ordered);
}

function lineHash(prevHash, lineNoHash) {
  return createHash('sha256').update(`${prevHash}\n${canonical(lineNoHash)}`).digest('hex');
}

// Parse + verify the whole chain. Returns
//   { ok: true, entries }               intact (possibly empty)
//   { ok: false, reason, entries }       broken at some point (entries = the
//                                        verified prefix)
export async function readAuditChain(runtimeRoot) {
  if (!runtimeRoot) return { ok: true, entries: [], absent: true };
  const file = path.join(runtimeRoot, PR_LATCH_AUDIT_FILE);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, entries: [], absent: true };
    return { ok: false, reason: `audit log unreadable: ${err?.message ?? err}`, entries: [] };
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries = [];
  let prevHash = GENESIS;
  let expectedSeq = 1;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { return { ok: false, reason: `audit log line ${expectedSeq} is not JSON`, entries }; }
    const { hash, ...rest } = obj;
    if (rest.seq !== expectedSeq) return { ok: false, reason: `audit log seq gap at ${expectedSeq} (got ${rest.seq})`, entries };
    if (rest.prevHash !== prevHash) return { ok: false, reason: `audit log chain break at seq ${rest.seq}`, entries };
    if (lineHash(prevHash, rest) !== hash) return { ok: false, reason: `audit log hash mismatch at seq ${rest.seq}`, entries };
    entries.push(rest);
    prevHash = hash;
    expectedSeq += 1;
  }
  return { ok: true, entries, tipHash: prevHash };
}

// Append one event. Never rewrites existing lines.
export async function appendAuditEvent(runtimeRoot, {
  event, repositoryIdentity, prNumber, latchCount, meta = {}, clock = () => Date.now(),
}) {
  if (!runtimeRoot) return null; // in-memory persistence (tests) — nothing durable to chain
  const chain = await readAuditChain(runtimeRoot);
  if (!chain.ok) {
    // Do not append onto a broken chain — that would legitimize the tampering.
    throw new Error(`refusing to append PR-latch audit event onto a broken chain: ${chain.reason}`);
  }
  const seq = (chain.entries.at(-1)?.seq ?? 0) + 1;
  const prevHash = chain.tipHash ?? GENESIS;
  const lineNoHash = {
    seq,
    at: new Date(clock()).toISOString(),
    prevHash,
    event,
    repositoryIdentity: String(repositoryIdentity ?? ''),
    prNumber,
    latchCount: latchCount ?? null,
    meta,
  };
  const hash = lineHash(prevHash, lineNoHash);
  const file = path.join(runtimeRoot, PR_LATCH_AUDIT_FILE);
  await mkdir(runtimeRoot, { recursive: true }).catch(() => {});
  await appendFile(file, `${JSON.stringify({ ...lineNoHash, hash })}\n`, 'utf8');
  return { seq, hash };
}

// Reduce the verified chain to the current latch expectation for one PR:
//   { latched: boolean, reason, lastEvent, latchCount }
// latched === true  -> begin MUST be blocked (a fresh signed approval is needed;
//                      an already-verified-but-not-consumed approval is handled
//                      by the state file, not here).
export function expectedLatchState(entries, { repositoryIdentity, prNumber }) {
  const relevant = entries.filter(
    (e) => e.repositoryIdentity === String(repositoryIdentity) && e.prNumber === prNumber,
  );
  if (relevant.length === 0) return { latched: false, lastEvent: null };
  const last = relevant.at(-1);
  // ARMED or APPROVAL_VERIFIED => still latched (blocked). APPROVAL_CONSUMED =>
  // the one approved loop is running; a *further* begin is still blocked, but
  // that is the state file's job to express (CONSUMED). RESOLVED => cleared.
  const latched = last.event === PR_LATCH_EVENTS.ARMED
    || last.event === PR_LATCH_EVENTS.APPROVAL_VERIFIED
    || last.event === PR_LATCH_EVENTS.APPROVAL_CONSUMED;
  return { latched, lastEvent: last.event, latchCount: last.latchCount };
}
