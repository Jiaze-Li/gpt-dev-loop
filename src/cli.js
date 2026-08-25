import { resolveAskGpt } from './bridge/transport.js';
import { loadConfig } from './config.js';
import { UsageError, mapErrorToExitCode } from './bridge/errors.js';
import { closeExtensionServer } from './bridge/extensionServer.js';

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

  let config;
  try {
    config = loadConfig();
    const reply = await resolveAskGpt(config)(parsed.prompt, config);
    process.stdout.write(`${reply}\n`);
    process.exitCode = 0;
  } catch (err) {
    console.error(`gpt-loop: ${err.message}`);
    process.exitCode = mapErrorToExitCode(err);
  } finally {
    // The extension transport's bridge server (extensionServer.js) is a
    // loopback WebSocket *listener* — an open listening socket keeps
    // Node's event loop alive, so without an explicit close() here this
    // one-shot CLI process would never exit after using extension mode. A
    // leaked process like that also keeps holding the port, so every
    // subsequent `ask` invocation fails to bind its own server and the
    // extension (which reconnects automatically) ends up talking to that
    // stale process instead of the current one.
    if (config?.browserMode === 'extension') {
      await closeExtensionServer();
    }
  }
}
