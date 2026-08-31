import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PR_REVIEWER,
  DEFAULT_MAX_PR_REPAIR_ROUNDS,
  normalizePrReviewer,
} from "./prCloseoutPolicy.js";

// PR Closeout dedicated reviewer config resolution. This is scoped entirely to
// the PR Closeout Review path and must not influence the ordinary Task Reviewer.
export function resolvePrCloseoutConfig(parsed) {
  const closeout = parsed && typeof parsed.prCloseout === "object" && parsed.prCloseout
    ? parsed.prCloseout
    : {};
  const rawReviewer = parsed?.prReviewer ?? parsed?.pr_reviewer ?? closeout.reviewer ?? closeout.prReviewer;
  const rawMaxRounds = parsed?.maxPrRepairRounds ?? parsed?.max_pr_repair_rounds
    ?? closeout.maxRepairRounds ?? closeout.maxPrRepairRounds;
  const prReviewer = normalizePrReviewer(rawReviewer, DEFAULT_PR_REVIEWER);
  const maxPrRepairRounds = Number.isInteger(rawMaxRounds) && rawMaxRounds > 0
    ? rawMaxRounds
    : DEFAULT_MAX_PR_REPAIR_ROUNDS;
  return { prReviewer, maxPrRepairRounds };
}

/**
 * Safely resolves canonical realpath for a given path, or null if it cannot be resolved.
 */
export function safeRealpath(p) {
  if (!p || typeof p !== "string") return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Raised when a workspace file reference cannot be safely represented as a
 * stable workspace-relative path (empty, absolute, or escapes the workspace
 * root via "..").
 */
export class WorkspacePathError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkspacePathError";
    this.details = details;
  }
}

/**
 * Normalize a single workspace file reference to a stable, workspace-relative
 * POSIX path. Collapses redundant "." segments, duplicate separators and
 * resolvable ".." segments, folds "\\" to "/", and strips a leading "./" and
 * trailing slashes. Globs are preserved verbatim.
 *
 * Throws WorkspacePathError when the input is not a non-empty string, is an
 * absolute path (POSIX or Windows drive/UNC), resolves to the workspace root
 * itself, or escapes the workspace root via "..".
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeWorkspaceRelativePath(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new WorkspacePathError("workspace file path must be a non-empty string", {
      input,
      reason: "empty",
    });
  }
  const raw = input.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\")) {
    throw new WorkspacePathError(
      `workspace file path "${raw}" must be workspace-relative, not absolute`,
      { input: raw, reason: "absolute" }
    );
  }
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new WorkspacePathError(
      `workspace file path "${raw}" escapes the workspace root`,
      { input: raw, reason: "escape" }
    );
  }
  const cleaned = normalized.replace(/^\.\//, "").replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") {
    throw new WorkspacePathError(
      `workspace file path "${raw}" does not reference a file within the workspace`,
      { input: raw, reason: "empty" }
    );
  }
  return cleaned;
}

/**
 * Normalize a list of workspace file references, dropping post-normalization
 * duplicates while preserving first-seen order.
 *
 * @param {string[]} inputs
 * @param {object} [opts]
 * @param {boolean} [opts.throwOnInvalid=true]  when false, unsafe entries are
 *        dropped (and reported in `dropped`) instead of throwing.
 * @returns {{ paths: string[], dropped: {input:string, reason:string}[] }}
 */
export function normalizeWorkspaceRelativePaths(inputs, { throwOnInvalid = true } = {}) {
  const list = Array.isArray(inputs) ? inputs : [];
  const seen = new Set();
  const paths = [];
  const dropped = [];
  for (const item of list) {
    let normalized;
    try {
      normalized = normalizeWorkspaceRelativePath(item);
    } catch (err) {
      if (throwOnInvalid || !(err instanceof WorkspacePathError)) throw err;
      dropped.push({
        input: typeof item === "string" ? item : String(item),
        reason: err.details?.reason ?? "invalid",
      });
      continue;
    }
    if (seen.has(normalized)) {
      dropped.push({ input: String(item), reason: "duplicate" });
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return { paths, dropped };
}

/**
 * Resolves a workspace relative path against actual repository files.
 * If the path already exists, returns it as-is.
 * If the path does not exist but matches exactly ONE existing file in the repository
 * (e.g. missing subdirectories like 'adapters/'), it automatically corrects to that file.
 * If there are multiple candidates or zero candidates (e.g. brand new file), returns original normalized path.
 *
 * @param {string} input
 * @param {string[]|Set<string>} [repoFiles]
 * @returns {string}
 */
export function resolveRepoPath(input, repoFiles) {
  const normalized = normalizeWorkspaceRelativePath(input);
  if (!repoFiles) return normalized;

  const fileSet = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);
  if (fileSet.size === 0 || fileSet.has(normalized)) {
    return normalized;
  }

  // Preserve globs verbatim
  if (normalized.includes('*') || normalized.includes('?')) {
    return normalized;
  }

  const targetSegments = normalized.split('/').filter(Boolean);
  const targetBasename = targetSegments[targetSegments.length - 1];

  const candidates = [];
  for (const existingFile of fileSet) {
    const candidateSegments = existingFile.split('/').filter(Boolean);
    const candidateBasename = candidateSegments[candidateSegments.length - 1];
    if (candidateBasename !== targetBasename) continue;

    // Check if target directory segments appear as a subsequence in candidate directory segments
    let tIdx = 0;
    for (let i = 0; i < candidateSegments.length && tIdx < targetSegments.length; i++) {
      if (candidateSegments[i] === targetSegments[tIdx]) {
        tIdx++;
      }
    }
    if (tIdx === targetSegments.length) {
      candidates.push(existingFile);
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return normalized;
}

/**
 * Resolves and normalizes a list of workspace file references with repository-aware path correction.
 *
 * @param {string[]} inputs
 * @param {object} [opts]
 * @param {string[]|Set<string>} [opts.repoFiles]
 * @param {boolean} [opts.throwOnInvalid=true]
 * @returns {{ paths: string[], dropped: {input:string, reason:string}[] }}
 */
export function resolveRepoRelativePaths(inputs, { repoFiles, throwOnInvalid = true } = {}) {
  const { paths: normalizedPaths, dropped } = normalizeWorkspaceRelativePaths(inputs, { throwOnInvalid });
  const seen = new Set();
  const paths = [];
  for (const p of normalizedPaths) {
    const resolved = resolveRepoPath(p, repoFiles);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      paths.push(resolved);
    }
  }
  return { paths, dropped };
}


/**
 * Loads repository/workspace-level SuperGPT configuration from .supergpt/config.json.
 * Returns parsed configuration object with validated externalReadRoots.
 */
export function loadWorkspaceConfig(workspaceCwd = process.cwd()) {
  const defaults = {
    externalReadRoots: [],
    prReviewer: DEFAULT_PR_REVIEWER,
    maxPrRepairRounds: DEFAULT_MAX_PR_REPAIR_ROUNDS,
  };

  if (!workspaceCwd || typeof workspaceCwd !== "string") {
    return { ...defaults };
  }

  const configPath = path.join(workspaceCwd, ".supergpt", "config.json");
  if (!fs.existsSync(configPath)) {
    return { ...defaults };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new ExternalReadRootConfigError(
        `Malformed workspace configuration in .supergpt/config.json: ${parseErr.message}. Fix or remove the file.`,
        { configPath, reason: "invalid_json", error: parseErr.message }
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ExternalReadRootConfigError(
        `Invalid workspace configuration in .supergpt/config.json: expected a JSON object.`,
        { configPath, reason: "invalid_shape" }
      );
    }

    const rawRoots = parsed.externalReadRoots || parsed.approvedExternalRoots || parsed.external_read_roots;
    const externalReadRoots = [];
    if (Array.isArray(rawRoots)) {
      for (const item of rawRoots) {
        if (typeof item === "string" && item.trim()) {
          externalReadRoots.push(item.trim());
        }
      }
    }

    const rawCloseout = parsed.verification?.closeoutCommands ||
      parsed.verification?.closeout_commands ||
      parsed.closeoutCommands ||
      parsed.closeout_verification_commands;
    const closeoutCommands = [];
    if (Array.isArray(rawCloseout)) {
      for (const item of rawCloseout) {
        if (typeof item === "string" && item.trim()) {
          closeoutCommands.push(item.trim());
        }
      }
    }

    const { prReviewer, maxPrRepairRounds } = resolvePrCloseoutConfig(parsed);

    return {
      ...parsed,
      externalReadRoots,
      closeoutCommands,
      prReviewer,
      maxPrRepairRounds,
    };
  } catch (err) {
    if (err instanceof ExternalReadRootConfigError) {
      throw err;
    }
    throw new ExternalReadRootConfigError(
      `Failed to read workspace configuration at .supergpt/config.json: ${err.message}. Fix or remove the file.`,
      { configPath, reason: "read_error", error: err.message }
    );
  }
}

/**
 * Configuration validation error thrown at workflow creation time when
 * a configured externalReadRoot fails strict validation (does not exist,
 * is not a directory, is not readable, or cannot be resolved via realpath).
 */
export class ExternalReadRootConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExternalReadRootConfigError";
    this.details = details;
  }
}

/**
 * Validates and canonicalizes external read roots for workflow creation.
 * Every root MUST:
 *   - resolve via realpath (not just path.resolve)
 *   - exist now
 *   - be a directory
 *   - be readable
 *
 * Throws ExternalReadRootConfigError on the first invalid root with an
 * actionable preflight error. This is called exactly ONCE at workflow
 * creation; the returned list is persisted immutably into workflow metadata.
 */
export function validateAndCanonicalizeRoots(rawRoots, cwd) {
  if (!Array.isArray(rawRoots) || rawRoots.length === 0) return [];

  const canonical = [];
  const seen = new Set();

  for (const item of rawRoots) {
    if (typeof item !== "string" || !item.trim()) continue;
    const trimmed = item.trim();
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);

    // Must resolve via realpath — not just path.resolve
    const real = safeRealpath(resolved);
    if (!real) {
      throw new ExternalReadRootConfigError(
        `externalReadRoot "${trimmed}" does not exist or cannot be resolved via realpath (resolved to "${resolved}"). ` +
          `Fix .supergpt/config.json to reference only existing, readable directories.`,
        { root: trimmed, resolved, reason: "realpath_failed" }
      );
    }

    // Must be a directory
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      throw new ExternalReadRootConfigError(
        `externalReadRoot "${trimmed}" cannot be stat'd at "${real}": ${err.message}`,
        { root: trimmed, resolved: real, reason: "stat_failed" }
      );
    }
    if (!stat.isDirectory()) {
      throw new ExternalReadRootConfigError(
        `externalReadRoot "${trimmed}" resolves to "${real}" which is not a directory.`,
        { root: trimmed, resolved: real, reason: "not_directory" }
      );
    }

    // Must be readable
    try {
      fs.accessSync(real, fs.constants.R_OK);
    } catch {
      throw new ExternalReadRootConfigError(
        `externalReadRoot "${trimmed}" resolves to "${real}" which is not readable.`,
        { root: trimmed, resolved: real, reason: "not_readable" }
      );
    }

    if (!seen.has(real)) {
      seen.add(real);
      canonical.push(real);
    }
  }

  return canonical;
}

/**
 * Resolves approved external roots for workflow creation.
 * Loads workspace config exactly once and validates via realpath.
 *
 * This is the ONLY function used at workflow creation time. It:
 * 1. Loads .supergpt/config.json
 * 2. Validates and canonicalizes every root (fail closed on invalid)
 * 3. Returns the exact immutable list to persist into workflow metadata
 *
 * explicitRoots is retained ONLY for trusted programmatic/test callers,
 * never for MCP model-facing tools.
 */
export function resolveApprovedExternalRoots({
  cwd = process.cwd(),
  workspaceConfig = null,
  explicitRoots = [],
  persistedRoots = [],
} = {}) {
  const wsConfig = workspaceConfig || loadWorkspaceConfig(cwd);
  const candidateList = [
    ...(Array.isArray(persistedRoots) ? persistedRoots : []),
    ...(Array.isArray(wsConfig?.externalReadRoots) ? wsConfig.externalReadRoots : []),
    ...(Array.isArray(explicitRoots) ? explicitRoots : []),
  ];

  const canonicalSet = new Set();
  for (const item of candidateList) {
    if (typeof item !== "string" || !item.trim()) continue;
    const trimmed = item.trim();
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
    const canonical = safeRealpath(resolved) || resolved;
    canonicalSet.add(canonical);
  }

  return Array.from(canonicalSet);
}

/**
 * Load and strictly validate workspace config roots for a NEW workflow.
 * Called exactly once at workflow creation. Throws ExternalReadRootConfigError
 * if any configured root is invalid (fail closed, before model invocation).
 */
export function loadAndValidateExternalRoots(cwd) {
  const wsConfig = loadWorkspaceConfig(cwd);
  return validateAndCanonicalizeRoots(wsConfig.externalReadRoots, cwd);
}
