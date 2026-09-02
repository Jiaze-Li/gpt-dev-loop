// Shared Gate-failure identity extraction.
//
// One parser, used by both:
//   - deterministicSupervisorPolicy.js  (gateFailureFingerprint / no-new-information)
//   - baselineDiffGate.js               (baseline vs current failing-test diff)
//
// The unit of comparison is a *normalized failure identity* — the name of a
// failing test / assertion with volatile bits (durations, absolute worktree
// paths, stack-trace line:col) stripped so the same failure produces the same
// identity across runs and across machines.

import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// Pull the individual failing test / assertion identifiers out of a Gate
// command's captured output. Supports node:test's spec reporter (`✖ name`)
// and TAP (`not ok N - name`). Durations and surrounding whitespace are
// stripped so the identifier is stable across runs.
export function extractFailingTestIds(output) {
  const text = String(output || '');
  const ids = new Set();
  const patterns = [
    /^\s*[✖✗✘]\s+(.+?)\s*$/gm, // ✖ ✗ ✘  (node:test)
    /^\s*not ok \d+\s*(?:-\s*)?(.+?)\s*$/gm, // TAP
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]
        .replace(/\s*\(\d+(?:\.\d+)?\s*(?:ms|s)\)\s*$/i, '') // trailing duration
        .replace(/\s+/g, ' ')
        .trim();
      if (!name) continue;
      if (/^failing tests:?$/i.test(name)) continue; // TAP/spec summary header
      ids.add(name);
    }
  }
  return [...ids].sort();
}

// Volatile-bit-stripped digest of a Gate output, used only when no structured
// failing-test identifiers could be extracted.
export function normalizeGateOutput(output) {
  return String(output || '')
    .replace(/\(\d+(?:\.\d+)?\s*(?:ms|s)\)/g, '(t)') // durations
    .replace(/\/[^\s:'"]*\/(?:gpt-dev-loop|\.supergpt)[^\s:'"]*/g, '<path>') // worktree paths
    .replace(/:\d+:\d+/g, ':L:C') // stack-trace line:col
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hex>') // commit / blob ids
    .replace(/\bpid[=: ]\d+/gi, 'pid=<n>')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// Read a numeric exit code off a per-command Gate result regardless of which
// key the collector used.
export function resultExitCode(result) {
  if (!result || typeof result !== 'object') return null;
  return Number.isFinite(result.exitCode) ? result.exitCode
    : Number.isFinite(result.exit_code) ? result.exit_code
      : Number.isFinite(result.code) ? result.code : null;
}

// Failure identities for ONE failing per-command Gate result.
//
//   { command, identities: string[], reliable: boolean }
//
// `reliable` is true only when at least one structured failing-test identity
// could be extracted. A failing command that produced no parseable failing
// test line (a build error, a crashed runner, a bare `exit 1`) is NOT
// reliable: callers MUST NOT treat its failure as comparable to a baseline.
export function failureIdentitiesForResult(result) {
  const command = typeof result?.command === 'string' ? result.command.trim() : '';
  const identities = extractFailingTestIds(result?.output);
  return {
    command,
    identities,
    reliable: identities.length > 0,
  };
}

// Collect the union of failing-test identities across every failing per-command
// result in a Gate-evidence-shaped object, plus a per-command reliability map.
//
//   {
//     identities: string[],                 // sorted union
//     reliable: boolean,                    // every failing command was parseable
//     unreliableCommands: string[],         // failing commands with no parseable identity
//     byCommand: Map<command, {identities, reliable, exitCode}>,
//   }
export function collectFailureIdentities(evidence) {
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  const failing = results.filter((r) => r && r.pass !== true);
  const identities = new Set();
  const unreliableCommands = [];
  const byCommand = new Map();
  let reliable = true;

  for (const r of failing) {
    const info = failureIdentitiesForResult(r);
    byCommand.set(info.command, {
      identities: info.identities,
      reliable: info.reliable,
      exitCode: resultExitCode(r),
    });
    for (const id of info.identities) identities.add(id);
    if (!info.reliable) {
      reliable = false;
      unreliableCommands.push(info.command);
    }
  }

  return {
    identities: [...identities].sort(),
    reliable,
    unreliableCommands: [...new Set(unreliableCommands)].sort(),
    byCommand,
  };
}
