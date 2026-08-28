#!/usr/bin/env node
// SuperGPT Universal CLI.
//
// Commands:
//   supergpt "<instruction>"                  run from a natural-language goal
//   supergpt run "<goal>" [--plan=<path>]     run the complete loop
//   supergpt plan "<instruction>"             generate plan without execution
//   supergpt status [workflowId]              inspect live/persisted workflow progress
//   supergpt wait <workflowId> [--status=...] wait locally for workflow transition
//   supergpt resume <workflowId> [--answer=]  resume suspended workflow
//   supergpt stop <workflowId> [--reason=...] stop active workflow safely
//   supergpt doctor                           run zero-token system diagnostics
//   supergpt install [--global]               install MCP server and skills
//   supergpt uninstall                        remove global registration
//
// Output modes:
//   --output-format=text (default)            live interactive TTY UI or clean text
//   --output-format=json                      ndjson event stream + JSON result (0 ANSI)
//   --no-spinner                              disable animated TTY spinner

import path from 'node:path';
import {
  supergptPlan,
  runSuperGPT,
  supergptResume,
  supergptStop,
  supergptWait,
  supergptStatus,
  readCanonicalProgress,
} from '../src/orchestrator/supergpt.js';
import { readWorkflowStatus } from '../src/mcp/supergptMcpServer.js';
import { TerminalRenderer } from '../src/renderers/terminalRenderer.js';
import {
  renderGenericProgress,
  renderGenericCompletion,
  renderGenericPlan,
} from '../src/renderers/genericTextRenderer.js';
import { runDoctor } from '../scripts/doctor.js';
import { installGlobal, uninstallGlobal, checkGlobalStatus } from './install-plugin.js';

function parseArgs(argv) {
  const opts = {
    command: null,
    outputFormat: 'text',
    noSpinner: false,
    positionals: [],
  };

  const knownCommands = ['run', 'plan', 'status', 'wait', 'resume', 'stop', 'doctor', 'install', 'uninstall'];

  let i = 0;
  if (argv.length > 0 && knownCommands.includes(argv[0])) {
    opts.command = argv[0];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--no-spinner') opts.noSpinner = true;
    else if (arg.startsWith('--plan=')) opts.planPath = arg.slice('--plan='.length);
    else if (arg.startsWith('--output-format=')) opts.outputFormat = arg.slice('--output-format='.length);
    else if (arg.startsWith('--cwd=')) opts.cwd = arg.slice('--cwd='.length);
    else if (arg.startsWith('--workflow-id=')) opts.workflowId = arg.slice('--workflow-id='.length);
    else if (arg.startsWith('--answer=')) opts.answer = arg.slice('--answer='.length);
    else if (arg.startsWith('--reason=')) opts.reason = arg.slice('--reason='.length);
    else if (arg.startsWith('--status=')) opts.targetStatus = arg.slice('--status='.length);
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = Number(arg.slice('--timeout='.length));
    else if (arg.startsWith('--frontend=')) opts.frontend = arg.slice('--frontend='.length);
    else if (arg === '--global') opts.global = true;
    else if (arg.startsWith('--')) opts.unknown = arg;
    else opts.positionals.push(arg);
  }

  if (!opts.command) {
    opts.command = 'run';
  }

  if (opts.positionals.length > 0) {
    if (['status', 'wait', 'stop', 'resume'].includes(opts.command) && !opts.workflowId) {
      opts.workflowId = opts.positionals[0];
      if (opts.command === 'resume' && opts.positionals.length > 1 && !opts.answer) {
        opts.answer = opts.positionals.slice(1).join(' ');
      }
    } else {
      opts.goal = opts.positionals.join(' ');
    }
  }

  return opts;
}

const USAGE = `usage: supergpt [command] [options] [arguments]

Commands:
  supergpt "<instruction>"                  Run autonomous development loop
  supergpt run "<goal>" [--plan=<path>]     Run autonomous development loop
  supergpt plan "<instruction>"             Generate verification-ready plan
  supergpt status [workflowId]              Inspect workflow status (0 tokens)
  supergpt wait <workflowId> [--status=..]  Wait locally for workflow completion
  supergpt resume <workflowId> [--answer=]  Resume suspended workflow
  supergpt stop <workflowId> [--reason=..]  Stop active workflow safely
  supergpt doctor                           Run zero-token health diagnostics
  supergpt install [--frontend=..]          Install MCP server & global skills
  supergpt uninstall                        Remove global installation

Options:
  --plan=<path>                 Path to plan file
  --cwd=<path>                  Workspace directory (default: current cwd)
  --output-format=text|json     Output format (default: text)
  --no-spinner                  Disable animated live UI spinner
  --help, -h                    Show this help text
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (opts.unknown) {
    process.stderr.write(`supergpt: unknown option ${opts.unknown}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  if (!['json', 'text'].includes(opts.outputFormat)) {
    process.stderr.write(`supergpt: --output-format must be "json" or "text" (got "${opts.outputFormat}")\n`);
    process.exitCode = 1;
    return;
  }

  const effectiveCwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  // 1. DOCTOR
  if (opts.command === 'doctor') {
    const report = runDoctor({ env: process.env });
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  // 2. INSTALL / UNINSTALL
  if (opts.command === 'install') {
    const res = await installGlobal();
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(`✔ SuperGPT installed globally.\n  MCP:   ${res.mcpConfigFile}\n  Skill: ${res.skillTargetFile}\n`);
    }
    return;
  }

  if (opts.command === 'uninstall') {
    const res = await uninstallGlobal();
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(`✔ SuperGPT uninstalled globally.\n`);
    }
    return;
  }

  // 3. PLAN
  if (opts.command === 'plan') {
    if (!opts.goal && !opts.planPath) {
      process.stderr.write(`supergpt plan requires an instruction or --plan=<path>\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const result = await supergptPlan({
      goal: opts.goal,
      planPath: opts.planPath,
      cwd: effectiveCwd,
    });
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderGenericPlan(result)}\n`);
    }
    process.exitCode = result.status === 'READY' ? 0 : 1;
    return;
  }

  // 4. STATUS
  if (opts.command === 'status') {
    if (opts.workflowId) {
      const canonical = readCanonicalProgress({ workflowId: opts.workflowId });
      if (!canonical) {
        process.stderr.write(`No workflow state found for "${opts.workflowId}"\n`);
        process.exitCode = 1;
        return;
      }
      if (opts.outputFormat === 'json') {
        process.stdout.write(`${JSON.stringify(canonical, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderGenericProgress(canonical)}\n`);
      }
      return;
    }

    const workflows = await readWorkflowStatus({});
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify({ workflows }, null, 2)}\n`);
    } else {
      if (workflows.length === 0) {
        process.stdout.write('No SuperGPT workflows found.\n');
        return;
      }
      process.stdout.write(`Active / Recorded SuperGPT Workflows (${workflows.length}):\n\n`);
      for (const wf of workflows) {
        process.stdout.write(`• ${wf.workflow_id} [${wf.status}] (${wf.stage})\n`);
        process.stdout.write(`  Workspace: ${wf.source_workspace}\n`);
        if (wf.summary) process.stdout.write(`  Summary:   ${wf.summary}\n`);
        process.stdout.write('\n');
      }
    }
    return;
  }

  // 5. WAIT
  if (opts.command === 'wait') {
    if (!opts.workflowId) {
      process.stderr.write(`supergpt wait requires a workflowId\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const state = await supergptWait({
      workflowId: opts.workflowId,
      timeoutMs: opts.timeoutMs ?? 60000,
      predicate: (s) => (opts.targetStatus ? s.workflowStatus === opts.targetStatus : true),
    });
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderGenericProgress(state)}\n`);
    }
    return;
  }

  // 6. STOP
  if (opts.command === 'stop') {
    if (!opts.workflowId) {
      process.stderr.write(`supergpt stop requires a workflowId\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    const result = await supergptStop({
      workflowId: opts.workflowId,
      reason: opts.reason || 'stopped by user',
    });
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`✔ Workflow ${opts.workflowId} stopped. (PIDs terminated: ${result.pidsKilled.join(', ') || 'none'})\n`);
    }
    return;
  }

  // 7. RESUME or RUN
  if (opts.command === 'resume' && !opts.workflowId) {
    process.stderr.write(`supergpt resume requires a workflowId\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.command === 'run' && !opts.goal && !opts.planPath) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const isTTY = Boolean(process.stdout.isTTY) && !opts.noSpinner && opts.outputFormat === 'text';
  let renderer = null;

  if (opts.outputFormat === 'text') {
    renderer = new TerminalRenderer({
      stream: process.stdout,
      isTTY,
      showSpinner: isTTY,
    });
  }

  const controller = new AbortController();
  let cancelling = false;
  const onSignal = (sig) => {
    if (cancelling) {
      if (renderer) renderer.cleanup();
      process.exit(130);
    }
    cancelling = true;
    if (renderer) {
      renderer.cleanup();
    }
    if (opts.outputFormat === 'text') {
      process.stderr.write(`\n[supergpt] ${sig} received — cancelling (press again to force-quit)…\n`);
    }
    controller.abort();
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  if (renderer) {
    renderer.start();
  }

  const onEvent = (event) => {
    if (renderer) {
      renderer.emitTransition(event);
      if (event.workflowId) {
        const live = readCanonicalProgress({ workflowId: event.workflowId });
        if (live) renderer.updateState(live);
      }
    }
  };

  try {
    let result;
    if (opts.command === 'resume') {
      result = await supergptResume({
        workflowId: opts.workflowId,
        answer: opts.answer || null,
        cwd: effectiveCwd,
        outputFormat: opts.outputFormat === 'json' ? 'json' : null,
        signal: controller.signal,
        onEvent,
      });
    } else {
      result = await runSuperGPT({
        goal: opts.goal,
        planPath: opts.planPath,
        cwd: effectiveCwd,
        outputFormat: opts.outputFormat === 'json' ? 'json' : null,
        signal: controller.signal,
        onEvent,
      });
    }

    if (renderer) {
      renderer.stop(result);
    } else if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify({ type: 'result', ...result })}\n`);
    } else {
      process.stdout.write(`${renderGenericCompletion(result)}\n`);
    }

    process.exitCode =
      result.status === 'WORKFLOW_DONE' ? 0 : result.status === 'CANCELLED' ? 130 : 1;
  } catch (err) {
    if (renderer) renderer.cleanup();
    process.stderr.write(`supergpt: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  } finally {
    if (renderer) renderer.cleanup();
  }
}

main().catch((err) => {
  process.stderr.write(`supergpt: ${err?.stack || err?.message || err}\n`);
  process.exitCode = 1;
});
