import { resolveAskGpt } from './bridge/transport.js';
import { loadConfig } from './config.js';
import { UsageError, mapErrorToExitCode } from './bridge/errors.js';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'ask') {
    throw new UsageError('Usage: gpt-loop ask "<prompt>"');
  }
  const prompt = rest.join(' ').trim();
  if (!prompt) {
    throw new UsageError('Missing prompt. Usage: gpt-loop ask "<prompt>"');
  }
  return { command, prompt };
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = mapErrorToExitCode(err);
    return;
  }

  try {
    const config = loadConfig();
    const reply = await resolveAskGpt(config)(parsed.prompt, config);
    process.stdout.write(`${reply}\n`);
    process.exitCode = 0;
  } catch (err) {
    console.error(`gpt-loop: ${err.message}`);
    process.exitCode = mapErrorToExitCode(err);
  }
}
