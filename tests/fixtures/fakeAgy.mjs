// Deterministic fake for src/agy/agyClient.js's callAgy(), for the Gemini
// Supervisor / Reviewer provider tests. No real `agy` process is spawned.
//
// Each queue entry is one of:
//   - an object            -> returned as the model's JSON answer (text = JSON.stringify)
//   - a string             -> returned verbatim as the model's answer text
//   - an Error             -> thrown (models an agy timeout / nonzero exit)
//   - a function({prompt,model}) -> its return value is used as the result
// The last entry is reused for any further calls.

export function makeFakeCallAgy(payloads) {
  const queue = Array.isArray(payloads) ? [...payloads] : [payloads];
  const calls = [];

  async function callAgy({ prompt, model, timeoutMs, jsonSchema } = {}) {
    calls.push({ prompt, model, timeoutMs, jsonSchema });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next({ prompt, model });
    const text = typeof next === 'string' ? next : JSON.stringify(next);
    return { model, exitCode: 0, text, json: { result: text }, stdout: text, durationMs: 1 };
  }

  callAgy.calls = calls;
  return callAgy;
}

export function validTaskCardObject(overrides = {}) {
  return {
    task_id: 'auto-a',
    repository_context: {
      repository_name: 'gpt-dev-loop',
      repository_url: 'none',
      branch: 'phase1-handshake',
      commit_sha: 'unknown',
    },
    goal: 'Create work/auto-a.txt with the exact content auto-a-ok.',
    context: 'MVP smoke task.',
    scope: 'Only work/auto-a.txt is in scope.',
    allowed_files: ['work/auto-a.txt'],
    forbidden_files: [],
    acceptance_criteria: ['work/auto-a.txt contains exactly auto-a-ok'],
    verification_commands: ['test "$(cat work/auto-a.txt)" = "auto-a-ok"'],
    completion_signal: 'DONE',
    ...overrides,
  };
}
