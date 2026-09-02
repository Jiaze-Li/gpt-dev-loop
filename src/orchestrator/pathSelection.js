// Deterministic Fast Path vs Full Path selection.
//
// Invoked once by the canonical workflow startup (src/orchestrator/supergpt.js
// defaultPipeline) BEFORE any model is called. Consumes zero model tokens: it
// is pure string / structure inspection of trusted request and workspace
// inputs only. It never calls a provider, never reads the network, and never
// guesses — an input it cannot conservatively classify selects Full Path.
//
// Contract:
//
//   Fast Path is selected ONLY when Core can construct exactly one safe,
//   bounded Task Card from trusted inputs, with:
//     - a concrete, bounded file scope (no globs, no bare directories, no
//       traversal, a small capped count), and
//     - at least one deterministic verification command, and
//     - a goal that shows no explicit multi-step decomposition, no
//       architectural / product ambiguity, no high-risk operation, and is
//       not closeout-only work.
//
//   Everything else — including any uncertainty — selects Full Path.
//
//   Fast Path skips the Planner and the model Supervisor on its normal path
//   but still runs Executor -> deterministic Gate -> independent Reviewer ->
//   DONE | ordinary REWORK. Full Path runs the Planner once and freezes its
//   ordered task queue.
//
// Resume safety: a persisted decision is restored verbatim through
// `frozenDecision`. Resume never recomputes the path and never weakens the
// bounded scope.

import fs from 'node:fs';
import path from 'node:path';
import { parsePrCloseoutGoal } from './prCloseoutIntent.js';

export const WORKFLOW_PATHS = Object.freeze({
  FAST: 'FAST',
  FULL: 'FULL',
  PR_CLOSEOUT: 'PR_CLOSEOUT',
});

export const PATH_SELECTION_REASONS = Object.freeze({
  FAST_BOUNDED_SINGLE_TASK: 'fast_bounded_single_task',
  FAST_DERIVED_BOUNDED_TASK: 'fast_derived_bounded_task',
  PR_CLOSEOUT_INTENT: 'pr_closeout_intent',
  FULL_NO_BOUNDED_TASK: 'full_no_bounded_task',
  FULL_EXPLICIT_REQUEST: 'full_explicit_request',
  FULL_EXPLICIT_MULTI_STEP: 'full_explicit_multi_step',
  FULL_MISSING_FILE_SCOPE: 'full_missing_file_scope',
  FULL_BROAD_FILE_SCOPE: 'full_broad_file_scope',
  FULL_MISSING_VERIFICATION: 'full_missing_verification',
  FULL_AMBIGUOUS_INTENT: 'full_ambiguous_intent',
  FULL_HIGH_RISK: 'full_high_risk',
  FULL_CLOSEOUT_ONLY: 'full_closeout_only',
  FULL_INVALID_BOUNDED_TASK: 'full_invalid_bounded_task',
  FULL_UNCERTAIN_CLASSIFICATION: 'full_uncertain_classification',
  RESTORED_FROM_STATE: 'restored_from_state',
});

// Upper bound on how many files a single Fast Path Task Card may touch. Beyond
// this the change is no longer "safely bounded" and must go through planning.
export const FAST_PATH_MAX_FILES = 12;

const MULTI_STEP_PATTERNS = [
  /\bthen\b/i,
  /\bafter (?:that|which)\b/i,
  /\bnext[, ]/i,
  /\bfinally\b/i,
  /\bstep\s*\d/i,
  /\bphase\s*\d/i,
  /\band also\b/i,
  /\bas well as\b/i,
  /\bmultiple (?:tasks|steps|changes)\b/i,
  /\bseveral (?:tasks|steps|changes)\b/i,
  /\bfirst\b[\s\S]*\bthen\b/i,
  /(?:^|\n)\s*\d[.)]\s+\S/, // an enumerated list
  /(?:^|\n)\s*[-*]\s+\S[\s\S]*(?:\n)\s*[-*]\s+\S/, // two or more bullets
];

const AMBIGUITY_PATTERNS = [
  /\bdesign\b/i,
  /\bdecide\b/i,
  /\bfigure out\b/i,
  /\binvestigate\b/i,
  /\bexplore\b/i,
  /\bresearch\b/i,
  /\bevaluate\b/i,
  /\boption(?:s)?\b/i,
  /\brecommend\b/i,
  /\bnot sure\b/i,
  /\bsomehow\b/i,
  /\barchitect(?:ure|ing)?\b/i,
  /\brefactor the (?:whole|entire|overall)\b/i,
  /\?\s*$/m,
  /\bwhich\b[\s\S]*\?/i,
];

const HIGH_RISK_PATTERNS = [
  /\bdelete\b/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /--force\b/i,
  /force[- ]push/i,
  /\brm\s+-rf\b/i,
  /\brewrite\b/i,
  /\bcredential/i,
  /\bsecret/i,
  /\bpassword/i,
  /\bapi[_ ]?key/i,
  /\.github\/workflows/i,
  /\bproduction\b/i,
  /\bdeploy\b/i,
  /\bpublish\b/i,
  /\brelease\b/i,
];

const CLOSEOUT_ONLY_PATTERNS = [
  /\bmerge (?:the )?(?:pr|branch|pull request)\b/i,
  /\bclose (?:out )?(?:the )?(?:pr|pull request|ticket|issue)\b/i,
  /\bbump (?:the )?version\b/i,
  /\bcut a release\b/i,
  /\btag (?:the )?release\b/i,
  /\bfinali[sz]e (?:the )?(?:pr|pull request|release)\b/i,
];

function firstMatch(patterns, text) {
  for (const re of patterns) {
    if (re.test(text)) return re.source;
  }
  return null;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// A concrete file path: a relative path with no glob metacharacters, no parent
// traversal, not a bare directory, not the repo root, and not an existing directory on disk.
function isConcreteFilePath(entry, cwd = null) {
  if (!isNonEmptyString(entry)) return false;
  const p = entry.trim();
  if (p === '.' || p === '/' || p === './') return false;
  if (p.startsWith('/')) return false; // absolute paths are not workspace-relative scope
  if (p.includes('..')) return false;
  if (/[*?\[\]{}!]/.test(p)) return false; // glob metacharacters
  if (p.endsWith('/')) return false; // bare directory
  const base = p.split('/').pop();
  if (!base) return false;
  if (cwd && typeof cwd === 'string') {
    try {
      const full = path.resolve(cwd, p);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        return false;
      }
    } catch {}
  }
  return true;
}

/**
 * Normalize and validate a caller-supplied bounded task into a Fast Path Task
 * contract. Returns `{ ok: true, contract }` or `{ ok: false, reason, detail }`
 * with a PATH_SELECTION_REASONS value.
 */
export function buildFastPathTaskContract(boundedTask, { cwd = null } = {}) {
  if (Array.isArray(boundedTask)) {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP, detail: 'bounded task input is a list of tasks' };
  }
  if (!boundedTask || typeof boundedTask !== 'object') {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_NO_BOUNDED_TASK, detail: 'no bounded task contract supplied' };
  }
  if (Array.isArray(boundedTask.tasks) && boundedTask.tasks.length > 1) {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP, detail: 'bounded task carries more than one task' };
  }

  if (!isNonEmptyString(boundedTask.goal)) {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_INVALID_BOUNDED_TASK, detail: 'bounded task has no goal' };
  }

  const allowedRaw = boundedTask.allowed_files ?? boundedTask.allowedFiles;
  if (!Array.isArray(allowedRaw) || allowedRaw.length === 0) {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_MISSING_FILE_SCOPE, detail: 'bounded task has no allowed_files' };
  }
  if (allowedRaw.length > FAST_PATH_MAX_FILES) {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_BROAD_FILE_SCOPE, detail: `allowed_files count ${allowedRaw.length} exceeds Fast Path limit ${FAST_PATH_MAX_FILES}` };
  }
  const allowed_files = [];
  for (const entry of allowedRaw) {
    if (!isConcreteFilePath(entry, cwd)) {
      return { ok: false, reason: PATH_SELECTION_REASONS.FULL_BROAD_FILE_SCOPE, detail: `allowed_files entry is not a concrete bounded path: ${JSON.stringify(entry)}` };
    }
    allowed_files.push(entry.trim());
  }

  const verifyRaw = boundedTask.verification_commands ?? boundedTask.verificationCommands;
  if (!Array.isArray(verifyRaw) || verifyRaw.length === 0) {
    return { ok: false, reason: PATH_SELECTION_REASONS.FULL_MISSING_VERIFICATION, detail: 'bounded task has no verification_commands' };
  }
  const verification_commands = [];
  for (const cmd of verifyRaw) {
    if (!isNonEmptyString(cmd)) {
      return { ok: false, reason: PATH_SELECTION_REASONS.FULL_MISSING_VERIFICATION, detail: 'verification_commands contains an empty entry' };
    }
    verification_commands.push(cmd.trim());
  }

  const forbiddenRaw = boundedTask.forbidden_files ?? boundedTask.forbiddenFiles ?? [];
  const forbidden_files = Array.isArray(forbiddenRaw)
    ? forbiddenRaw.filter(isNonEmptyString).map((s) => s.trim())
    : [];

  return {
    ok: true,
    contract: {
      task_id: isNonEmptyString(boundedTask.task_id) ? boundedTask.task_id.trim() : 'fast-path-task',
      goal: boundedTask.goal.trim(),
      scope: isNonEmptyString(boundedTask.scope) ? boundedTask.scope.trim() : null,
      allowed_files,
      forbidden_files,
      verification_commands,
    },
  };
}

function classifyGoalText(text) {
  const t = String(text ?? '');
  const multi = firstMatch(MULTI_STEP_PATTERNS, t);
  if (multi) return { reason: PATH_SELECTION_REASONS.FULL_EXPLICIT_MULTI_STEP, detail: `explicit multi-step marker: /${multi}/` };
  const risk = firstMatch(HIGH_RISK_PATTERNS, t);
  if (risk) return { reason: PATH_SELECTION_REASONS.FULL_HIGH_RISK, detail: `high-risk marker: /${risk}/` };
  const closeout = firstMatch(CLOSEOUT_ONLY_PATTERNS, t);
  if (closeout) return { reason: PATH_SELECTION_REASONS.FULL_CLOSEOUT_ONLY, detail: `closeout-only marker: /${closeout}/` };
  const ambiguous = firstMatch(AMBIGUITY_PATTERNS, t);
  if (ambiguous) return { reason: PATH_SELECTION_REASONS.FULL_AMBIGUOUS_INTENT, detail: `ambiguity marker: /${ambiguous}/` };
  return null;
}

// ---- Deterministic bounded-task derivation from a plain request goal --------
//
// The path selector's Fast Path was previously reachable ONLY when a caller
// handed in a pre-structured `boundedTask` contract. The MCP entrypoints
// (`supergpt_start_and_wait` etc.) never construct one, so every plain
// natural-language request — however small and mechanically bounded — fell to
// Full Path and paid for a Planner model call.
//
// This derivation closes that gap WITHOUT an LLM call and without special-
// casing any fixture: it keys purely on structural properties of the request
// text and the workspace. It only produces a candidate when the request
//   (a) names one or a few concrete, in-repo (or new-in-existing-dir) files,
//       and
//   (b) names at least one recognized deterministic verification command.
// The candidate is then subject to the SAME downstream gating as an explicit
// contract (`buildFastPathTaskContract` scope/verification checks plus
// `classifyGoalText` multi-step / ambiguity / high-risk / closeout markers),
// so decomposable, ambiguous, or risky work still routes to the Planner.
// Anything it cannot confidently derive returns null -> Full Path unchanged.

// Source-ish file extensions worth treating as a bounded edit target.
const DERIVE_FILE_EXT = 'js|jsx|ts|tsx|mjs|cjs|py|go|rs|rb|java|kt|kts|swift|scala|clj|cljs|ex|exs|erl|c|h|cc|cpp|hpp|cxx|hxx|m|mm|cs|php|lua|dart|sh|bash|zsh|sql|css|scss|sass|less|html|vue|svelte|json|jsonc|ya?ml|toml|ini|cfg|conf|env|properties|gradle|md|mdx|txt|proto|graphql|gql';
const DERIVE_FILE_RE = new RegExp(
  String.raw`(?<![\w@./-])((?:[\w.-]+/)*[\w.-]+\.(?:${DERIVE_FILE_EXT}))(?![\w/])`,
  'gi',
);

// Conventional source roots accepted when on-disk existence cannot be checked
// (no usable cwd). A bare `foo.js` with no directory part is never accepted.
const DERIVE_CONVENTIONAL_ROOT_RE = /^(?:src|lib|app|pkg|internal|cmd|scripts?|config|test|tests|spec|packages|components?|server|client|api|core)\//i;

// Recognized deterministic verification runners. A candidate command must start
// with one of these AND carry no shell chaining/redirection/substitution.
const DERIVE_VERIFY_CMD_RE = /^(?:npm|npx|pnpm|yarn|bun|deno|node|python3?|py|pytest|tox|unittest|cargo|go|make|just|jest|vitest|mocha|ava|tap|rspec|rake|bundle\s+exec|phpunit|composer|dotnet|gradle|\.\/gradlew|mvn|ctest|cmake|swift|dart|flutter|elixir|mix|rustc|tsc|eslint|ruff|pyright|mypy)\b/i;
const DERIVE_CMD_UNSAFE_RE = /[;&|<>`$\n]|\|\||&&/;

function deriveVerificationCommands(goal) {
  const text = String(goal ?? '');
  const candidates = [];
  // 1. backtick-quoted spans
  const btRe = /`([^`\n]{1,160})`/g;
  let m;
  while ((m = btRe.exec(text)) !== null) candidates.push(m[1]);
  // 2. "verify with X", "run X to verify", "verification command: X",
  //    "verify: X", "test command: X", "tests: X" — to end of line.
  const cueRe = /(?:verify(?:\s+(?:it|this|the\s+change|by\s+running))?\s+with|run\s+|verification\s+command\s*[:=]|verify\s*[:=]|test\s+command\s*[:=]|tests?\s*[:=])\s*`?([^\n`]{1,160})`?/gi;
  while ((m = cueRe.exec(text)) !== null) candidates.push(m[1]);

  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    let c = String(raw).trim().replace(/^['"]|['"]$/g, '').trim();
    // trim a trailing sentence period / clause punctuation
    c = c.replace(/[.,;:)\s]+$/g, '').trim();
    if (!c || c.length > 160) continue;
    if (DERIVE_CMD_UNSAFE_RE.test(c)) continue;
    if (!DERIVE_VERIFY_CMD_RE.test(c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function deriveAllowedFiles(goal, cwd) {
  const text = String(goal ?? '');
  let cwdIsDir = false;
  if (cwd && typeof cwd === 'string') {
    try { cwdIsDir = fs.existsSync(cwd) && fs.statSync(cwd).isDirectory(); } catch { cwdIsDir = false; }
  }
  const out = [];
  const seen = new Set();
  let m;
  DERIVE_FILE_RE.lastIndex = 0;
  while ((m = DERIVE_FILE_RE.exec(text)) !== null) {
    const entry = m[1].trim();
    if (seen.has(entry)) continue;
    if (!isConcreteFilePath(entry, cwd)) continue;
    let accept = false;
    if (cwdIsDir) {
      try {
        const full = path.resolve(cwd, entry);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          accept = true;
        } else {
          // a not-yet-created file is a valid bounded target only when its
          // immediate parent directory already exists inside the workspace.
          const parent = path.dirname(full);
          accept = fs.existsSync(parent) && fs.statSync(parent).isDirectory();
        }
      } catch { accept = false; }
    } else {
      // No usable cwd: accept only a path that is clearly workspace source,
      // i.e. has a directory part under a conventional root.
      accept = entry.includes('/') && DERIVE_CONVENTIONAL_ROOT_RE.test(entry);
    }
    if (!accept) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

// A path that names a test/spec file rather than an implementation target.
const DERIVE_TEST_FILE_RE = /(?:^|\/)(?:__tests__|__specs__|tests?|specs?)\/|\.(?:test|spec)\.[a-z]+$|_(?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+\.[a-z]+$/i;

// Explicit intent to edit the test files themselves (direct object), which is
// the only case a named test/spec file stays a writable Fast Path target.
const DERIVE_EDIT_TESTS_RE = /(?<!\bnot\s)(?<!\bnever\s)(?<!n['’]t\s)\b(?:modif(?:y|ies)|edit|editing|updat(?:e|ing)|chang(?:e|ing)|rewrit(?:e|ing)|extend(?:ing)?|add(?:ing)?\s+(?:a\s+)?(?:new\s+)?(?:case|assertion|test))\b[^.\n]{0,40}\b(?:test|spec)s?\b|\b(?:test|spec)s?\b[^.\n]{0,40}\b(?:file|suite)\b[^.\n]{0,20}\b(?:modif|edit|updat|chang|rewrit)/i;

// Explicit "do not modify <path>" / "leave <path> unchanged" clauses.
function deriveForbiddenFiles(goal) {
  const text = String(goal ?? '');
  const out = new Set();
  const ext = `(?:${DERIVE_FILE_EXT})`;
  const negRe = new RegExp(
    String.raw`(?:do not|don't|never|without|avoid)\s+(?:modif|edit|chang|touch|alter)\w*[^.\n]{0,80}?((?:[\w.-]+/)*[\w.-]+\.${ext})`,
    'gi',
  );
  const leaveRe = new RegExp(
    String.raw`leave\s+((?:[\w.-]+/)*[\w.-]+\.${ext})\s+(?:unchanged|as-is|as is|alone|intact|untouched)`,
    'gi',
  );
  let m;
  while ((m = negRe.exec(text)) !== null) out.add(m[1].trim());
  while ((m = leaveRe.exec(text)) !== null) out.add(m[1].trim());
  return [...out];
}

/**
 * Deterministically derive a single bounded-task contract candidate from a
 * plain request goal and the workspace. Returns a `boundedTask`-shaped object
 * (`{ goal, allowed_files, forbidden_files, verification_commands }`) or null
 * when the request is not structurally a single mechanically-verifiable task.
 *
 * Pure: string inspection plus read-only `fs.existsSync`/`statSync`. No model
 * call, no network, no writes.
 */
export function deriveBoundedTaskFromGoal(goal, { cwd = null } = {}) {
  if (!isNonEmptyString(goal)) return null;

  const named = deriveAllowedFiles(goal, cwd);
  if (named.length === 0) return null;

  const explicitForbidden = new Set(deriveForbiddenFiles(goal));
  const editTests = DERIVE_EDIT_TESTS_RE.test(goal);

  const implFiles = named.filter((f) => !DERIVE_TEST_FILE_RE.test(f) && !explicitForbidden.has(f));
  const testFiles = named.filter((f) => DERIVE_TEST_FILE_RE.test(f) && !explicitForbidden.has(f));

  const allowed_files = [];
  const forbidden_files = new Set(explicitForbidden);
  for (const f of implFiles) allowed_files.push(f);
  for (const f of testFiles) {
    // In a bounded "implement X, the tests verify it" task the named test
    // files are the acceptance spec, not an edit target — protect them unless
    // the request explicitly asks to edit the tests themselves. A request that
    // names ONLY test files (no impl target) is not a Fast Path shape.
    if (editTests && implFiles.length > 0) allowed_files.push(f);
    else forbidden_files.add(f);
  }

  // Need at least one concrete implementation target to edit.
  if (implFiles.length === 0) return null;
  if (allowed_files.length === 0) return null;
  if (allowed_files.length > FAST_PATH_MAX_FILES) return null;

  const verification_commands = deriveVerificationCommands(goal);
  if (verification_commands.length === 0) return null;

  return {
    goal: goal.trim(),
    allowed_files,
    forbidden_files: [...forbidden_files],
    verification_commands,
    __derived: true,
  };
}

function fullDecision(reason, detail) {
  return Object.freeze({
    path: WORKFLOW_PATHS.FULL,
    reason,
    reasonDetail: detail ?? null,
    taskContract: null,
    frozenPlan: null,
    restored: false,
  });
}

/**
 * Validate a persisted decision object restored on resume. Throws if the
 * persisted record is structurally unusable — resume must fail closed rather
 * than silently fall back to a different path.
 */
export function restorePathDecision(frozen) {
  if (!frozen || typeof frozen !== 'object') {
    throw new Error('restorePathDecision: persisted path decision is missing or not an object');
  }
  if (frozen.path !== WORKFLOW_PATHS.FAST && frozen.path !== WORKFLOW_PATHS.FULL && frozen.path !== WORKFLOW_PATHS.PR_CLOSEOUT) {
    throw new Error(`restorePathDecision: persisted path "${frozen.path}" is not a recognized workflow path`);
  }
  if (frozen.path === WORKFLOW_PATHS.PR_CLOSEOUT) {
    return Object.freeze({
      path: frozen.path,
      reason: frozen.reason ?? PATH_SELECTION_REASONS.RESTORED_FROM_STATE,
      reasonDetail: frozen.reasonDetail ?? 'restored from persisted workflow state',
      prNumber: frozen.prNumber ?? null,
      repository: frozen.repository ?? null,
      taskContract: null,
      frozenPlan: null,
      restored: true,
    });
  }
  let taskContract = null;
  if (frozen.path === WORKFLOW_PATHS.FAST) {
    const rebuilt = buildFastPathTaskContract(frozen.taskContract);
    if (!rebuilt.ok) {
      throw new Error(`restorePathDecision: persisted Fast Path contract no longer validates (${rebuilt.detail}) — refusing to weaken scope on resume`);
    }
    taskContract = rebuilt.contract;
  }
  return Object.freeze({
    path: frozen.path,
    reason: frozen.reason ?? PATH_SELECTION_REASONS.RESTORED_FROM_STATE,
    reasonDetail: frozen.reasonDetail ?? 'restored from persisted workflow state',
    taskContract,
    frozenPlan: frozen.frozenPlan ?? null,
    restored: true,
  });
}

/**
 * Select Fast Path, Full Path, or PR Closeout mode.
 *
 * @param {object} opts
 * @param {string} [opts.goal]              natural-language request text
 * @param {string} [opts.cwd]               workspace directory
 * @param {object} [opts.boundedTask]       caller-supplied structured single-task
 *                                          contract from trusted input; its
 *                                          absence forces Full Path
 * @param {boolean} [opts.explicitFullPath] caller explicitly wants planning
 * @param {object} [opts.frozenDecision]    persisted decision restored on resume
 * @returns {Readonly<{path:string, reason:string, reasonDetail:string|null,
 *                     prNumber?:number|null, repository?:string|null,
 *                     taskContract:object|null, frozenPlan:object|null,
 *                     restored:boolean}>}
 */
export function selectWorkflowPath({ goal, cwd = process.cwd(), boundedTask, explicitFullPath = false, frozenDecision = null } = {}) {
  if (frozenDecision) {
    return restorePathDecision(frozenDecision);
  }

  // 1. Natural-language PR Closeout intent recognition -> PR_CLOSEOUT mode directly
  const prIntent = parsePrCloseoutGoal(goal, { cwd });
  if (prIntent && prIntent.isPrCloseout && prIntent.prNumber) {
    return Object.freeze({
      path: WORKFLOW_PATHS.PR_CLOSEOUT,
      reason: PATH_SELECTION_REASONS.PR_CLOSEOUT_INTENT,
      reasonDetail: `PR Closeout mode for PR #${prIntent.prNumber}${prIntent.repository ? ` (${prIntent.repository})` : ''}`,
      prNumber: prIntent.prNumber,
      repository: prIntent.repository ?? null,
      taskContract: null,
      frozenPlan: null,
      restored: false,
    });
  }

  if (explicitFullPath === true) {
    return fullDecision(PATH_SELECTION_REASONS.FULL_EXPLICIT_REQUEST, 'caller explicitly requested the Full Path / planning');
  }

  let derived = false;
  let effectiveBoundedTask = boundedTask;
  if (effectiveBoundedTask === undefined || effectiveBoundedTask === null) {
    // No caller-supplied contract: try to derive one deterministically from the
    // request text + workspace. Still fully gated below.
    effectiveBoundedTask = deriveBoundedTaskFromGoal(goal, { cwd });
    if (!effectiveBoundedTask) {
      return fullDecision(PATH_SELECTION_REASONS.FULL_NO_BOUNDED_TASK, 'no bounded single-task contract in trusted input and none derivable from the request; planning required');
    }
    derived = true;
  }

  const built = buildFastPathTaskContract(effectiveBoundedTask, { cwd });
  if (!built.ok) {
    return fullDecision(built.reason, built.detail);
  }

  // Inspect BOTH the free-form request goal and the bounded task goal/scope.
  const combined = [goal, built.contract.goal, built.contract.scope].filter(isNonEmptyString).join('\n');
  const textVerdict = classifyGoalText(combined);
  if (textVerdict) {
    return fullDecision(textVerdict.reason, textVerdict.detail);
  }

  return Object.freeze({
    path: WORKFLOW_PATHS.FAST,
    reason: derived
      ? PATH_SELECTION_REASONS.FAST_DERIVED_BOUNDED_TASK
      : PATH_SELECTION_REASONS.FAST_BOUNDED_SINGLE_TASK,
    reasonDetail: `${derived ? 'derived ' : ''}single bounded task, ${built.contract.allowed_files.length} file(s) in scope, ${built.contract.verification_commands.length} verification command(s)`,
    taskContract: built.contract,
    frozenPlan: null,
    restored: false,
  });
}

/**
 * The durable fields persisted so a resume restores the same path and scope.
 */
export function serializePathDecision(decision) {
  if (!decision) return null;
  return {
    path: decision.path,
    reason: decision.reason,
    reasonDetail: decision.reasonDetail ?? null,
    prNumber: decision.prNumber ?? null,
    repository: decision.repository ?? null,
    taskContract: decision.taskContract ?? null,
    frozenPlan: decision.frozenPlan ?? null,
  };
}

/**
 * The flat fields recorded onto workflow state so status / watch / result
 * expose the selected path consistently.
 */
export function pathProgressFields(decision) {
  if (!decision) return {};
  return {
    workflowPath: decision.path,
    pathSelectionReason: decision.reason,
    pathSelectionDetail: decision.reasonDetail ?? null,
  };
}

/**
 * One-line human description for CLI / status rendering.
 */
export function describePathDecision(decision) {
  if (!decision) return 'path: unknown';
  const label = decision.path === WORKFLOW_PATHS.FAST ? 'Fast Path' : 'Full Path';
  return `${label} (${decision.reason})`;
}

/**
 * Build the synthetic resolved-plan object the canonical pipeline consumes
 * when Fast Path bypasses the Planner. Mirrors the shape returned by
 * resolveWorkflowPlan()/parsePlannerJson() closely enough for the automated
 * loop: one frozen task, plan text derived from the bounded contract, and the
 * contract's verification commands promoted to the closeout policy.
 */
export function fastPathResolvedPlan(decision, { goal } = {}) {
  if (!decision || decision.path !== WORKFLOW_PATHS.FAST || !decision.taskContract) {
    throw new Error('fastPathResolvedPlan requires a Fast Path decision with a task contract');
  }
  const c = decision.taskContract;
  const planText = [
    '# Fast Path plan (Planner bypassed — single bounded task)',
    '',
    `Goal: ${c.goal}`,
    goal && goal.trim() && goal.trim() !== c.goal ? `Original request: ${goal.trim()}` : null,
    '',
    c.scope ? `Scope: ${c.scope}` : null,
    '',
    'Allowed files:',
    ...c.allowed_files.map((f) => `  - ${f}`),
    c.forbidden_files.length ? 'Forbidden files:' : null,
    ...c.forbidden_files.map((f) => `  - ${f}`),
    '',
    'Verification commands:',
    ...c.verification_commands.map((v) => `  - ${v}`),
  ].filter((line) => line !== null).join('\n');

  return {
    status: 'READY',
    plan: planText,
    planText,
    summary: `Fast Path: ${c.goal}`,
    tasks: [{
      task_id: c.task_id,
      goal: c.goal,
      scope: c.scope,
      allowed_files: [...c.allowed_files],
      forbidden_files: [...c.forbidden_files],
      verification_commands: [...c.verification_commands],
    }],
    closeoutVerificationCommands: [...c.verification_commands],
    closeoutPolicySources: ['fast-path:bounded-task-contract'],
  };
}
