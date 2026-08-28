import fs from "node:fs";
import path from "node:path";

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
 * Loads repository/workspace-level SuperGPT configuration from .supergpt/config.json.
 * Returns parsed configuration object with validated externalReadRoots.
 */
export function loadWorkspaceConfig(workspaceCwd = process.cwd()) {
  if (!workspaceCwd || typeof workspaceCwd !== "string") {
    return { externalReadRoots: [] };
  }

  const configPath = path.join(workspaceCwd, ".supergpt", "config.json");
  if (!fs.existsSync(configPath)) {
    return { externalReadRoots: [] };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { externalReadRoots: [] };
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

    return {
      ...parsed,
      externalReadRoots,
      closeoutCommands,
    };
  } catch (err) {
    return { externalReadRoots: [], closeoutCommands: [] };
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
