// Lazy, best-effort probe of the local `agy models` catalog for runtime
// model-family resolution.
//
// This is a METADATA listing, not a model call: it consumes no tokens, incurs
// no cost, and is never routed through ModelSpendAuthority. It is invoked at
// most once per production provider-pool construction, is fully injectable,
// and on ANY failure (binary absent, network, timeout, unparseable) returns
// null so resolution falls back to the provider-default path. It never throws.
//
// `geminiDir`, when supplied, is passed as a leading `--gemini_dir=<dir>` arg
// (same isolated-config-root convention as the Reviewer/Supervisor AGY
// transport and the custom-agent capability probe). Callers that spawn this
// as part of ReviewLoop startup/runtime machinery MUST pass the isolated
// ReviewLoop gemini dir — an ambient `agy models` call lets a child `agy`
// pick up ambient AGY MCP config (including ReviewLoop itself), which is the
// recursion this isolation exists to prevent.

import { execFileSync } from 'node:child_process';
import { parseAgyModelCatalog } from '../orchestrator/modelFamilyResolver.js';

let cached; // undefined = not probed, null = probed and unavailable, [] / [ids]

export function probeAgyModelCatalog({
  exec = execFileSync, force = false, timeoutMs = 10_000, geminiDir,
} = {}) {
  if (!force && cached !== undefined) return cached;
  try {
    const args = [];
    if (typeof geminiDir === 'string' && geminiDir.trim() !== '') args.push(`--gemini_dir=${geminiDir.trim()}`);
    args.push('models');
    const out = exec('agy', args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
    const ids = parseAgyModelCatalog(out);
    cached = ids.length ? ids : null;
  } catch {
    cached = null;
  }
  return cached;
}

// Test seam.
export function _resetAgyModelCatalogCache() {
  cached = undefined;
}
