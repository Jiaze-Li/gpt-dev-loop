// Shared: turn one agy `--output-format json` reply into a parsed object,
// failing closed on anything that is not a single well-formed JSON object.
//
// The agy transport (src/agy/agyClient.js) already unwraps agy's own
// envelope and hands us `result.text` — the model's actual answer, which we
// instructed to be a bare JSON object. Gemini sometimes still wraps it in a
// ```json fence; that single, well-understood deviation is stripped. Nothing
// else is repaired: no key-guessing, no partial-object recovery, no
// natural-language fallback. This mirrors the "no malformed-output repair"
// policy already enforced in supervisorProtocol.js / gptReviewerAdapter.js.

export class AgyStructuredOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgyStructuredOutputError';
  }
}

export function parseAgyJsonObject(result) {
  const text = result && typeof result.text === 'string' ? result.text : null;
  if (text === null || text.trim() === '') {
    throw new AgyStructuredOutputError('agy returned no assistant text to parse as JSON');
  }

  let candidate = text.trim();
  const fence = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) candidate = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new AgyStructuredOutputError(`agy structured output was not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgyStructuredOutputError('agy structured output was not a JSON object');
  }
  return parsed;
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
