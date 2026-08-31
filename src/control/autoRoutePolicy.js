// SuperGPT Deterministic Route Policy (V2).
//
// Shared local deterministic router for Claude, Codex, and AGY.
// Consumes zero model tokens and is authoritative:
//   supergpt_route({ goal, cwd }) -> DIRECT | SUPERGPT
//
// Policy:
// - explicit request not to use SuperGPT -> DIRECT
// - explicit request to use SuperGPT -> SUPERGPT
// - explanation/research/non-modifying request -> DIRECT
// - clearly trivial single-step low-risk edit -> DIRECT
// - feature, bug fix, refactor, migration, debugging, tests, multi-file/layer work, or repeated implement/verify work -> SUPERGPT
// - uncertain classification -> SUPERGPT

export const ROUTE_DECISION = Object.freeze({
  DIRECT: 'DIRECT',
  SUPERGPT: 'SUPERGPT',
});

export const ROUTE_RULE = Object.freeze({
  EXPLICIT_BYPASS: 'EXPLICIT_BYPASS',
  EXPLICIT_FORCE: 'EXPLICIT_FORCE',
  NON_MODIFYING: 'NON_MODIFYING',
  TRIVIAL_EDIT: 'TRIVIAL_EDIT',
  SUBSTANTIAL_ENGINEERING: 'SUBSTANTIAL_ENGINEERING',
  UNCERTAIN_DEFAULT: 'UNCERTAIN_DEFAULT',
});

export const AUTO_ROUTE = Object.freeze({
  AUTO: 'AUTO',
  FORCE: 'FORCE',
  BYPASS: 'BYPASS',
});

export function supergptRoute({ goal = '', cwd } = {}) {
  const text = String(goal || '').trim().toLowerCase();

  if (!text) {
    return {
      decision: ROUTE_DECISION.SUPERGPT,
      rule: ROUTE_RULE.UNCERTAIN_DEFAULT,
      reason: 'Empty request defaults to SuperGPT',
      route: true,
      mode: AUTO_ROUTE.AUTO,
    };
  }

  // 1. Explicit request not to use SuperGPT -> DIRECT
  const explicitBypass =
    /\b(do not|don't|dont|without|never|no)\s+(use\s+|run\s+|launch\s+)?supergpt\b/i.test(text) ||
    /\b(bypass\s+supergpt|direct\s+(only|execution|mode))\b/i.test(text) ||
    /\bhandle\s+(this\s+)?directly\b/i.test(text);

  if (explicitBypass) {
    return {
      decision: ROUTE_DECISION.DIRECT,
      rule: ROUTE_RULE.EXPLICIT_BYPASS,
      reason: 'Explicit user instruction to bypass SuperGPT / handle directly',
      route: false,
      mode: AUTO_ROUTE.BYPASS,
    };
  }

  // 2. Explicit request to use SuperGPT -> SUPERGPT
  const explicitForce =
    /\b(use|run|via|with|using|launch|delegate\s+to|start|execute\s+via)\s+supergpt\b/i.test(text) ||
    /^supergpt\b/i.test(text) ||
    /\b(in|via|through)\s+supergpt\b/i.test(text);

  if (explicitForce) {
    return {
      decision: ROUTE_DECISION.SUPERGPT,
      rule: ROUTE_RULE.EXPLICIT_FORCE,
      reason: 'Explicit user instruction to use SuperGPT',
      route: true,
      mode: AUTO_ROUTE.FORCE,
    };
  }

  // Code modification / engineering action verbs
  const modifyingVerbs =
    /\b(fix|implement|create|build|develop|add|refactor|update|modify|delete|remove|write|migrate|upgrade|patch|rewrite|integrate|wire|test|replace|change|edit|bump|rename|debug|resolve)\b/i.test(text);

  // 3. Explanation / research / non-modifying request -> DIRECT
  const nonModifyingQuery =
    /^(explain|what\s+is|what\s+does|what\s+are|why\s+is|why\s+does|how\s+does|how\s+do|summarize|summari[sz]e|research|search|find|locate|where\s+is|where\s+are|read|show\s+me|list|check\s+whether|inspect|describe|clarify|look\s+up|tell\s+me\s+about)\b/i.test(text) ||
    /\b(explain|what\s+does|why\s+does|how\s+does|summarize|summari[sz]e|research|stack\s*trace)\b/i.test(text);

  if (nonModifyingQuery && !modifyingVerbs) {
    return {
      decision: ROUTE_DECISION.DIRECT,
      rule: ROUTE_RULE.NON_MODIFYING,
      reason: 'Explanation, research, or non-modifying request',
      route: false,
      mode: AUTO_ROUTE.AUTO,
    };
  }

  // 4. Clearly trivial single-step low-risk edit -> DIRECT
  const scopeOrComplexitySignals = [
    /\b(across|multiple|several|all|every)\b/i,
    /\b(server|client|frontend|backend|database|schema|api|service|module|component|pipeline)\b/i,
    /\b(test|tests|acceptance|compatib|migration|preserve|rollback|security|auth|jwt|oauth)\b/i,
    /\b(refactor|rewrite|redesign|restructure|architect)\b/i,
    /\b(bug|crash|leak|deadlock|race\s+condition|error|fail|failure|broken)\b/i,
  ].filter((re) => re.test(text)).length;

  const isTrivialEdit =
    (
      /\b(fix|correct)\s+(a\s+|an\s+)?(small\s+|minor\s+|single\s+)?(typo|spelling|spelling\s+mistake)\b/i.test(text) ||
      /\b(fix|correct)\s+typo\s+in\s+[\w.-]+\b/i.test(text) ||
      /\b(add|update|fix|change)\s+(a\s+)?(comment|docstring|documentation\s+note)\b/i.test(text) ||
      /\b(bump|update|change)\s+(the\s+)?(version|port|constant|variable\s+name)\b/i.test(text) ||
      /\brename\s+(the\s+)?variable\s+\w+\s+to\s+\w+\b/i.test(text)
    ) && scopeOrComplexitySignals === 0;

  if (isTrivialEdit) {
    return {
      decision: ROUTE_DECISION.DIRECT,
      rule: ROUTE_RULE.TRIVIAL_EDIT,
      reason: 'Clearly trivial single-step low-risk edit',
      route: false,
      mode: AUTO_ROUTE.AUTO,
    };
  }

  // 5. Feature, bug fix, refactor, migration, debugging, tests, multi-file/layer work, or repeated implement/verify work -> SUPERGPT
  const engineeringKeywords =
    /\b(implement|create|build|develop|feature|bug|fix|refactor|migrate|upgrade|replace|debug|test|tests|testing|coverage|rewrite|restructure|optimize|benchmark|closeout|close\s*out|pr\s*#?\d+|pull\s*request|检查并修复|修到\s*(?:review\s*)?clean)\b/i.test(text)
    || /\breview\s*(?:and|&)?\s*(?:fix|repair)\b/i.test(text);

  if (engineeringKeywords || scopeOrComplexitySignals > 0) {
    return {
      decision: ROUTE_DECISION.SUPERGPT,
      rule: ROUTE_RULE.SUBSTANTIAL_ENGINEERING,
      reason: 'Substantial engineering task (feature, bug fix, refactor, migration, tests, or multi-file work)',
      route: true,
      mode: AUTO_ROUTE.AUTO,
    };
  }

  // 6. Uncertain classification -> SUPERGPT
  return {
    decision: ROUTE_DECISION.SUPERGPT,
    rule: ROUTE_RULE.UNCERTAIN_DEFAULT,
    reason: 'Defaulting to SuperGPT for uncertain or ambiguous modification request',
    route: true,
    mode: AUTO_ROUTE.AUTO,
  };
}

export function decideAutoRoute(goal = '') {
  const result = supergptRoute({ goal });
  return {
    mode: result.mode,
    route: result.route,
    decision: result.decision,
    rule: result.rule,
    reason: result.reason,
  };
}

