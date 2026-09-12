// Lazy, best-effort probe of the local `agy models` catalog for runtime
// model-family resolution.
//
// This is a METADATA listing, not a model call: it consumes no tokens, incurs
// no cost, and is never routed through ModelSpendAuthority. It is invoked at
// most once per production provider-pool construction, is fully injectable,
// and on ANY failure (binary absent, network, timeout, unparseable) returns
// null so resolution falls back to the provider-default path. It never throws.

import { execFileSync } from 'node:child_process';
import { parseAgyModelCatalog } from '../orchestrator/modelFamilyResolver.js';

let cached; // undefined = not probed, null = probed and unavailable, [] / [ids]

export function probeAgyModelCatalog({ exec = execFileSync, force = false, timeoutMs = 10_000 } = {}) {
  if (!force && cached !== undefined) return cached;
  try {
    const out = exec('agy', ['models'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
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
