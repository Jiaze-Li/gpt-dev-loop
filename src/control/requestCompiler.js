// Frontend-neutral, deterministic request normalization. This intentionally
// does not create internal Task Cards; planning and decomposition remain a
// Supervisor concern after this small portable request crosses the boundary.
import path from 'node:path';

export const CANONICAL_REQUEST_SCHEMA = 'supergpt.request/v1';

export function compileSuperGptRequest({ goal, cwd = process.cwd(), constraints, preferences, mode = 'prepare' } = {}) {
  if (typeof goal !== 'string' || goal.trim() === '') throw new Error('A natural-language goal is required');
  const normalizedMode = ['prepare', 'plan', 'execute', 'export'].includes(mode) ? mode : 'prepare';
  return {
    schema: CANONICAL_REQUEST_SCHEMA,
    goal: goal.trim(),
    context: null,
    constraints: Array.isArray(constraints) ? constraints : constraints ? [String(constraints)] : [],
    acceptance: [],
    non_goals: [],
    preferences: preferences && typeof preferences === 'object' ? preferences : {},
    execution_mode: normalizedMode,
    workspace: path.resolve(cwd),
    ambiguities: [],
  };
}
