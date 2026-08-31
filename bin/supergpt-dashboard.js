#!/usr/bin/env node
// SuperGPT Dashboard CLI.
// Starts local zero-token read-only web dashboard.

import { createDashboardServer } from '../src/dashboard/server.js';

function parseDashboardArgs(argv) {
  let port = 4317;
  let host = '127.0.0.1';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`usage: supergpt dashboard [--port=<port>] [--host=<host>]

Options:
  --port=<port>   Port to listen on (default: 4317)
  --host=<host>   Loopback host (default: 127.0.0.1)
`);
      process.exit(0);
    }
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    }
  }

  return { port, host };
}

async function main() {
  const { port, host } = parseDashboardArgs(process.argv.slice(2));

  try {
    const dashboard = createDashboardServer({ port, host });
    const info = await dashboard.start();

    console.log(`
SuperGPT Dashboard
${info.url}

(Press Ctrl+C to stop)
`);

    const onExit = async () => {
      await dashboard.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
