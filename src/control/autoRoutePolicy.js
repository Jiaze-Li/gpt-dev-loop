// Deterministic frontend routing; this is deliberately not Core orchestration
// and never creates a classifier model call.
export const AUTO_ROUTE = Object.freeze({ AUTO: 'AUTO', FORCE: 'FORCE', BYPASS: 'BYPASS' });

export function decideAutoRoute(goal = '') {
  const text = String(goal).toLowerCase();
  if (/\b(do not|don't|dont|without)\s+use\s+supergpt\b/.test(text)) return { mode: AUTO_ROUTE.BYPASS, route: false };
  if (/\b(use|run|via)\s+supergpt\b/.test(text)) return { mode: AUTO_ROUTE.FORCE, route: true };

  const engineering = /\b(create|implement|build|fix|refactor|migrate|upgrade|replace)\b/.test(text);
  const scopeSignals = [
    /\b(server|client|frontend|backend|api|database|schema|module|component|repository|repo)\b/,
    /\b(test|acceptance|compatib|migration|preserve|rollback)\b/,
    /\b(across|multiple|several|and)\b/,
  ].filter((re) => re.test(text)).length;
  const nonEngineering = /\b(explain|what does|why does|summari[sz]e|research|stack trace)\b/.test(text);
  return { mode: AUTO_ROUTE.AUTO, route: engineering && scopeSignals >= 2 && !nonEngineering };
}
