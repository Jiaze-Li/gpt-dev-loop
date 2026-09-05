// Planner — turn a high-level natural-language coding instruction into a
// bounded, verification-ready SuperGPT plan, using Gemini (via the proven
// src/agy/agyClient.js transport) with repository context.
//
// Two pure-ish pieces, both injectable for deterministic tests:
//
//   collectRepositoryContext({ cwd })  -> a structured summary object plus a
//       formatted `promptBlock` string. Reads package.json (name / version /
//       scripts / dependency names), the tracked file listing (git ls-files,
//       falling back to a shallow readdir), the top-level entries, and a
//       whitelist of well-known config files. Missing / unreadable files are
//       tolerated — never thrown on.
//
//   generatePlan({ userIntent, repoContext, callAgy, model, timeoutMs })  ->
//       builds the planner prompt (repo context + user instruction), asks
//       Gemini for ONE bare JSON object, and parses it fail-closed:
//         { status: 'READY',     planText, summary, tasks }   or
//         { status: 'AMBIGUOUS', question }
//       Anything else — malformed JSON, an unknown status, a missing required
//       field, an agy timeout / nonzero exit — throws a PlannerError. No
//       key-guessing, no natural-language fallback, no retry.
//
// Privacy: this module never logs prompt or model-reply text.

import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile as fsReadFile, readdir } from 'node:fs/promises';

import {
  callAgy as defaultCallAgy,
  AgyError,
  AgyTimeoutError,
  AgyExitError,
  AgyExecutableNotFoundError,
} from '../agy/agyClient.js';
import { AgyStructuredOutputError, parseAgyJsonObject, isNonEmptyString } from '../agy/agyJson.js';
import { AGY_SUPERVISOR_DEFAULT_MODEL } from '../agy/agyConfig.js';
import { normalizeWorkspaceRelativePaths, resolveRepoRelativePaths, WorkspacePathError } from './workspaceConfig.js';

const execFileAsync = promisify(execFile);

export class PlannerError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'PlannerError';
    this.code = code;
  }
}

function invalidPlan(message) {
  return new PlannerError('PLANNER_INVALID_OUTPUT', message);
}

// Well-known project config / manifest / testing policy files worth surfacing to the planner.
const CONFIG_FILE_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.supergpt/config.json',
  'docs/architecture/TESTING_STRATEGY.md',
  'docs/TESTING_STRATEGY.md',
  'TESTING.md',
  'tsconfig.json',
  'jsconfig.json',
  'jest.config.js',
  'vitest.config.js',
  'babel.config.js',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.prettierrc',
  '.nvmrc',
  'Dockerfile',
  'docker-compose.yml',
  'Makefile',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Package.swift',
  'README.md',
];

// Specific testing policy candidate files to inspect and boundedly ingest for the planner
const POLICY_FILE_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.supergpt/config.json',
  'docs/architecture/TESTING_STRATEGY.md',
  'docs/TESTING_STRATEGY.md',
  'TESTING.md',
];

// Maximum byte limit for ingested testing policy files (bounded context)
const MAX_POLICY_FILE_BYTES = 4096;

// --- default (real) repository probes ------------------------------------

async function defaultReadTextFile(cwd, rel) {
  try {
    return await fsReadFile(path.resolve(cwd, rel), 'utf8');
  } catch {
    return null;
  }
}

async function defaultListRepoFiles(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'ls-files'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    /* not a git repo, or git unavailable — fall back to a shallow listing */
  }
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

// --- repository context collection --------------------------------------

function parsePackageJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keysOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : []);
  return {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    scripts:
      parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
        ? { ...parsed.scripts }
        : {},
    dependencies: keysOf(parsed.dependencies),
    devDependencies: keysOf(parsed.devDependencies),
  };
}

/**
 * Collect a structured, prompt-ready summary of the repository at `cwd`.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {(rel:string)=>Promise<string|null>} [opts.readTextFile]  injectable file reader
 * @param {()=>Promise<string[]>} [opts.listRepoFiles]              injectable file lister
 * @param {number} [opts.maxFilesListed]
 * @returns {Promise<object>} summary with a `.promptBlock` string
 */
export async function collectRepositoryContext({
  cwd = process.cwd(),
  readTextFile,
  listRepoFiles,
  maxFilesListed = 200,
} = {}) {
  const readFn = readTextFile ?? ((rel) => defaultReadTextFile(cwd, rel));
  const listFn = listRepoFiles ?? (() => defaultListRepoFiles(cwd));

  const files = (await listFn()) ?? [];
  const pkg = parsePackageJson(await readFn('package.json'));

  const topLevel = [
    ...new Set(
      files.map((f) => {
        const seg = String(f).split('/');
        return seg.length > 1 ? `${seg[0]}/` : seg[0];
      }),
    ),
  ].sort();

  const fileSet = new Set(files);
  const configFiles = [];
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    if (fileSet.has(candidate)) {
      configFiles.push(candidate);
      continue;
    }
    const body = await readFn(candidate);
    if (typeof body === 'string') configFiles.push(candidate);
  }

  // Bounded inspection of testing policy files
  const policyContexts = [];
  for (const candidate of POLICY_FILE_CANDIDATES) {
    let content = await readFn(candidate);
    if (typeof content === 'string' && content.trim()) {
      if (content.length > MAX_POLICY_FILE_BYTES) {
        content = `${content.slice(0, MAX_POLICY_FILE_BYTES)}\n...[truncated ${content.length - MAX_POLICY_FILE_BYTES} bytes]...`;
      }
      policyContexts.push({ path: candidate, content: content.trim() });
    }
  }

  const repository_name = (pkg && pkg.name) || path.basename(cwd) || 'unknown';

  const summary = {
    repository_name,
    package: pkg,
    top_level_entries: topLevel,
    file_count: files.length,
    files: files.slice(0, maxFilesListed),
    all_files: files,
    files_truncated: files.length > maxFilesListed,
    config_files: configFiles,
    policy_contexts: policyContexts,
  };
  summary.promptBlock = formatRepositoryContextBlock(summary);
  return summary;
}

// Pure: structured summary -> the text block embedded in the planner prompt.
export function formatRepositoryContextBlock(summary = {}) {
  const s = summary ?? {};
  const lines = [`repository_name: ${s.repository_name ?? 'unknown'}`];

  if (s.package) {
    const scripts = Object.entries(s.package.scripts ?? {});
    lines.push(
      '',
      'package.json:',
      `  name: ${s.package.name ?? '(none)'}`,
      `  version: ${s.package.version ?? '(none)'}`,
      `  scripts: ${scripts.length ? scripts.map(([k, v]) => `${k}="${v}"`).join(', ') : '(none)'}`,
      `  dependencies: ${(s.package.dependencies ?? []).join(', ') || '(none)'}`,
      `  devDependencies: ${(s.package.devDependencies ?? []).join(', ') || '(none)'}`,
    );
  } else {
    lines.push('', 'package.json: (absent or unreadable)');
  }

  lines.push(
    '',
    `top-level entries: ${(s.top_level_entries ?? []).join(', ') || '(none)'}`,
    `config files: ${(s.config_files ?? []).join(', ') || '(none)'}`,
  );

  if (Array.isArray(s.policy_contexts) && s.policy_contexts.length > 0) {
    lines.push('', 'repository testing / project policy files:');
    for (const p of s.policy_contexts) {
      lines.push(`--- ${p.path} ---`, p.content, '------------------------');
    }
  }

  lines.push('');

  const files = s.files ?? [];
  const total = s.file_count ?? files.length;
  lines.push(
    `tracked files (${total}${s.files_truncated ? `, showing first ${files.length}` : ''}):`,
    ...files.map((f) => `  ${f}`),
  );
  return lines.join('\n');
}

// --- plan generation ---------------------------------------------------

export function buildPlannerPrompt({ userIntent, repositoryContextBlock }) {
  return `You are the Planner for SuperGPT, an automated development loop (Supervisor -> Executor -> Reviewer). Turn the user's high-level instruction into a bounded, verification-ready plan.

Reply with ONLY one JSON object, no prose, no code fence. Shape:

{
  "status": "READY" | "AMBIGUOUS",
  "summary": "<1-3 sentences describing the overall plan>",        // REQUIRED iff status == "READY"
  "plan_text": "<a complete, ordered, self-contained plan document the Supervisor derives tasks from>",  // REQUIRED iff status == "READY"
  "tasks": [                                                       // REQUIRED iff status == "READY", at least one
    {
      "task_id": "<short-kebab-id>",
      "goal": "<1-3 sentences>",
      "scope": "<in scope / out of scope>",
      "allowed_files": ["<path or glob>", "..."],
      "verification_commands": ["<shell command that exits non-zero on failure>", "..."]
    }
  ],
  "closeout_verification_commands": ["<final suite command or overall verification command>"], // REQUIRED iff status == "READY"
  "closeout_policy_sources": ["<path to policy file such as 'docs/architecture/TESTING_STRATEGY.md'>"], // OPTIONAL
  "question": "<the single most important question a human must answer>"  // REQUIRED iff status == "AMBIGUOUS"
}

Rules:
- The "status" property must be exactly "READY" or "AMBIGUOUS" (never "SUCCESS", "DONE", or other strings).
- Use AMBIGUOUS only for a genuine architecture / product / scope decision you cannot responsibly make from the repository context. A merely underspecified detail you can reasonably choose is NOT ambiguous.
- NEVER return status "AMBIGUOUS" merely because the user did not supply a ready-made shell verification command.
- For tasks with deterministic requirements (e.g. creating/editing files, matching specific text/regex, JSON parsing, function return values, running tests), you MUST synthesize precise, deterministic, safe verification commands (e.g. test -f <path>, node -e "...", grep -q "...", pytest, npm test, etc.).
- Every READY task must name concrete allowed_files and at least one verification command that exits non-zero on failure.
- closeout_verification_commands must contain the final verification command(s) that confirm the user's overall goal is met (or repository test suites if applicable).
- Keep the plan bounded: the smallest set of tasks that satisfies the instruction.
- plan_text must stand alone — the Supervisor sees only plan_text, never this prompt or the repository context below.

# Repository context
${repositoryContextBlock}

# User instruction (authoritative)
${userIntent}

Reply with the JSON object now.`;
}

export function parsePlannerJson(obj, { repoFiles } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw invalidPlan('planner output was not a JSON object');
  }
  const status = obj.status;
  if (status !== 'READY' && status !== 'AMBIGUOUS') {
    throw invalidPlan(`planner "status" must be "READY" or "AMBIGUOUS" — got ${JSON.stringify(status)}`);
  }

  if (status === 'AMBIGUOUS') {
    if (!isNonEmptyString(obj.question)) {
      throw invalidPlan('AMBIGUOUS planner output must include a non-empty "question"');
    }
    return { status: 'AMBIGUOUS', question: obj.question.trim() };
  }

  if (!isNonEmptyString(obj.summary)) {
    throw invalidPlan('READY planner output must include a non-empty "summary"');
  }
  if (!isNonEmptyString(obj.plan_text)) {
    throw invalidPlan('READY planner output must include a non-empty "plan_text"');
  }
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw invalidPlan('READY planner output must include a non-empty "tasks" array');
  }

  const tasks = obj.tasks.map((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw invalidPlan(`planner tasks[${i}] must be an object`);
    }
    if (!isNonEmptyString(t.task_id)) throw invalidPlan(`planner tasks[${i}].task_id must be a non-empty string`);
    if (!isNonEmptyString(t.goal)) throw invalidPlan(`planner tasks[${i}].goal must be a non-empty string`);
    if (!Array.isArray(t.allowed_files) || t.allowed_files.length === 0) {
      throw invalidPlan(`planner tasks[${i}].allowed_files must be a non-empty array`);
    }
    if (!Array.isArray(t.verification_commands) || t.verification_commands.length === 0) {
      throw invalidPlan(`planner tasks[${i}].verification_commands must be a non-empty array`);
    }
    let allowedFiles;
    try {
      allowedFiles = resolveRepoRelativePaths(t.allowed_files.map(String), { repoFiles }).paths;
    } catch (err) {
      if (err instanceof WorkspacePathError) {
        throw invalidPlan(`planner tasks[${i}].allowed_files: ${err.message}`);
      }
      throw err;
    }
    if (allowedFiles.length === 0) {
      throw invalidPlan(`planner tasks[${i}].allowed_files must be a non-empty array`);
    }
    return {
      task_id: t.task_id.trim(),
      goal: t.goal.trim(),
      scope: isNonEmptyString(t.scope) ? t.scope.trim() : null,
      allowed_files: allowedFiles,
      verification_commands: t.verification_commands.map(String),
    };
  });

  let closeoutVerificationCommands = Array.isArray(obj.closeout_verification_commands)
    ? obj.closeout_verification_commands.map(String).map((c) => c.trim()).filter(Boolean)
    : [];

  if (closeoutVerificationCommands.length === 0 && tasks.length > 0) {
    const taskCommands = tasks.flatMap((t) => (Array.isArray(t.verification_commands) ? t.verification_commands : []));
    closeoutVerificationCommands = [...new Set(taskCommands.map((c) => String(c).trim()).filter(Boolean))];
  }

  const closeoutPolicySources = resolveRepoRelativePaths(
    Array.isArray(obj.closeout_policy_sources)
      ? obj.closeout_policy_sources.map(String).map((s) => s.trim()).filter(Boolean)
      : [],
    { repoFiles, throwOnInvalid: false },
  ).paths;

  return {
    status: 'READY',
    planText: obj.plan_text.trim(),
    summary: obj.summary.trim(),
    tasks,
    closeoutVerificationCommands,
    closeoutPolicySources,
  };
}

function mapPlannerAgyError(err) {
  if (err instanceof AgyTimeoutError) return new PlannerError('PLANNER_TIMEOUT', err.message);
  if (
    err instanceof AgyError ||
    err instanceof AgyExitError ||
    err instanceof AgyExecutableNotFoundError
  ) {
    return new PlannerError('PLANNER_MODEL_UNAVAILABLE', err.message);
  }
  return err;
}

function resolveContextBlock(repoContext) {
  if (typeof repoContext === 'string') return repoContext;
  if (repoContext && typeof repoContext.promptBlock === 'string') return repoContext.promptBlock;
  return formatRepositoryContextBlock(repoContext ?? {});
}

/**
 * @param {object} opts
 * @param {string} opts.userIntent
 * @param {object|string} opts.repoContext   collectRepositoryContext() output, or a raw block string
 * @param {Function} [opts.callAgy]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.jsonSchema]
 * @returns {Promise<{status:'READY',planText:string,summary:string,tasks:object[]}
 *                  | {status:'AMBIGUOUS',question:string}>}
 */
export async function generatePlan({
  userIntent,
  repoContext,
  callAgy = defaultCallAgy,
  model = AGY_SUPERVISOR_DEFAULT_MODEL,
  timeoutMs = 180_000,
  jsonSchema,
} = {}) {
  if (!isNonEmptyString(userIntent)) {
    throw new PlannerError('PLANNER_BAD_INPUT', 'generatePlan requires a non-empty userIntent string');
  }

  const prompt = buildPlannerPrompt({
    userIntent: userIntent.trim(),
    repositoryContextBlock: resolveContextBlock(repoContext),
  });

  let result;
  try {
    result = await callAgy({ prompt, model, timeoutMs, jsonSchema });
  } catch (err) {
    throw mapPlannerAgyError(err);
  }

  let obj;
  try {
    obj = parseAgyJsonObject(result);
  } catch (err) {
    if (err instanceof AgyStructuredOutputError) throw invalidPlan(err.message);
    throw err;
  }
  const repoFiles = repoContext?.all_files || repoContext?.files || (Array.isArray(repoContext) ? repoContext : null);
  return parsePlannerJson(obj, { repoFiles });
}

