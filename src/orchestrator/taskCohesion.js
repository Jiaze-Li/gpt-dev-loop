// Deterministic Full-Path task-collapse normalization.
//
// Principle: FULL != multiple tasks. The Planner is asked for the smallest
// bounded task set, but it still tends to split a single cohesive change into
// several Executor+Reviewer pipelines — each split multiplies token cost
// (fresh Executor context + an independent Reviewer pass) with no isolation,
// independent-verification, or context-boundary benefit in return.
//
// This module is a PURE, deterministic post-parse layer: given the already
// validated/normalized planner task list, it greedily merges *adjacent* tasks
// that are provably cohesive, so order and dependency information are preserved
// exactly. It never splits, never reorders, and never widens write scope — a
// merged task's `allowed_files` is exactly the union of its members'.
//
// A merge is lossless:
//   - goal      : member goals joined in original order
//   - scope     : member scopes (constraints) joined in original order
//   - allowed_files          : sorted set-union of members
//   - verification_commands  : order-preserving concat, exact-string de-duped
//   - task_id   : `${a}+${b}` (still a unique non-empty id)
//   - merged_from: flat list of original ids, for traceability
//
// Independent subsystems (disjoint files AND no shared verification) are never
// merged.

function normCommand(cmd) {
  return String(cmd).trim().replace(/\s+/g, ' ');
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 0;
  let inter = 0;
  for (const v of aSet) if (bSet.has(v)) inter += 1;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function intersectionSize(aSet, bSet) {
  let n = 0;
  for (const v of aSet) if (bSet.has(v)) n += 1;
  return n;
}

/**
 * Deterministic cohesion predicate for two parsed planner tasks.
 * Returns { cohesive:boolean, score:number, signals:string[] }.
 */
export function assessTaskCohesion(a, b) {
  const fA = new Set((a.allowed_files ?? []).map(String));
  const fB = new Set((b.allowed_files ?? []).map(String));
  const vA = new Set((a.verification_commands ?? []).map(normCommand));
  const vB = new Set((b.verification_commands ?? []).map(normCommand));

  const fInter = intersectionSize(fA, fB);
  const vInter = intersectionSize(vA, vB);
  const fJac = jaccard(fA, fB);
  const vJac = jaccard(vA, vB);
  const identicalVerification = vA.size > 0 && vJac === 1;
  const minFiles = Math.min(fA.size, fB.size);
  const subsetish = minFiles > 0 && fInter === minFiles;

  const signals = [];
  let score = 0;

  // File-scope relationship.
  if (fJac >= 0.5) { score += 2; signals.push('files-jaccard>=0.5'); }
  else if (fInter > 0) { score += 1; signals.push('files-overlap'); }

  // Verification relationship.
  if (identicalVerification) { score += 2; signals.push('verification-identical'); }
  else if (vJac >= 0.5) { score += 1; signals.push('verification-jaccard>=0.5'); }
  else if (vInter > 0) { score += 0.5; signals.push('verification-overlap'); }

  // One task's write scope is fully contained in the other's -> the later task
  // is almost certainly touching the same code the earlier one just changed.
  if (subsetish) { score += 1; signals.push('files-subset'); }

  // A merge requires an actual shared surface: shared files, or the exact same
  // verification contract. Pure independent subsystems never qualify.
  const hasSharedSurface = fInter > 0 || identicalVerification;
  const cohesive = hasSharedSurface && score >= 2;

  return { cohesive, score, signals };
}

function dedupeStable(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeTwo(a, b) {
  const scopes = [a.scope, b.scope].filter((s) => typeof s === 'string' && s.trim());
  return {
    task_id: `${a.task_id}+${b.task_id}`,
    goal: `${a.goal}\n${b.goal}`,
    scope: scopes.length ? scopes.join('\n') : null,
    allowed_files: [...new Set([...(a.allowed_files ?? []), ...(b.allowed_files ?? [])])].sort(),
    verification_commands: dedupeStable([
      ...(a.verification_commands ?? []),
      ...(b.verification_commands ?? []),
    ]),
    merged_from: [
      ...(a.merged_from ?? [a.task_id]),
      ...(b.merged_from ?? [b.task_id]),
    ],
  };
}

/**
 * Greedily collapse adjacent cohesive tasks to a fixed point.
 *
 * @param {object[]} tasks  parsed planner tasks (see planner.js#parsePlannerJson)
 * @returns {{ tasks: object[], collapsed: boolean, from: number, to: number,
 *             groups: string[][] }}
 */
export function collapseCohesiveTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length <= 1) {
    return {
      tasks: Array.isArray(tasks) ? tasks : [],
      collapsed: false,
      from: Array.isArray(tasks) ? tasks.length : 0,
      to: Array.isArray(tasks) ? tasks.length : 0,
      groups: Array.isArray(tasks) ? tasks.map((t) => [t.task_id]) : [],
    };
  }

  const from = tasks.length;
  let current = tasks.map((t) => ({ ...t }));

  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    for (let i = 0; i < current.length - 1; i += 1) {
      if (assessTaskCohesion(current[i], current[i + 1]).cohesive) {
        current.splice(i, 2, mergeTwo(current[i], current[i + 1]));
        changed = true;
        break;
      }
    }
  }

  return {
    tasks: current,
    collapsed: current.length < from,
    from,
    to: current.length,
    groups: current.map((t) => (Array.isArray(t.merged_from) ? [...t.merged_from] : [t.task_id])),
  };
}
