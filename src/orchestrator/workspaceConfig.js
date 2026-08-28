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

    return {
      ...parsed,
      externalReadRoots,
    };
  } catch (err) {
    return { externalReadRoots: [] };
  }
}

/**
 * Combines workspace config roots, persisted workflow metadata roots, and explicit
 * user-approved roots into a deterministic, canonicalized, deduplicated list.
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
