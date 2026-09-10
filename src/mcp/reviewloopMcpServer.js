// ReviewLoop MCP Server.
//
// Deliberately TINY agent-facing surface — every exposed tool/schema is
// always-loaded Worker context. Exactly two normal Worker-facing tools:
//
//   reviewloop_begin(goal, cwd, prNumber?)
//       Register the immutable review objective and capture the baseline
//       (LOCAL) or bind the exact PR snapshot: repository, prNumber, base SHA,
//       HEAD SHA (PR). Zero model calls.
//
//   reviewloop_review(loopId)
//       The one re-entrant operation: deterministic Gate -> Reviewer (if
//       justified) -> convergence policy -> Supervisor (only on non-
//       convergence). For a PR target the same engine runs over the PR
//       base -> exact HEAD diff, with a pre-PASS live-HEAD recheck. Returns
//       PASS | REWORK | HUMAN_REQUIRED | WAITING_FOR_REVIEW | NO_PROGRESS |
//       PUSH_REQUIRED.
//
// Status / dashboard / stop live on the human `reviewloop` CLI, not here.

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createReviewLoopController } from '../reviewloop/controller.js';
import {
  createProductionReviewLoopProviders,
  detectAgyCustomAgentSupport,
  narrowAgyGeminiDir,
} from '../reviewloop/providerWiring.js';
import { probeAgyModelCatalog } from '../agy/agyModelCatalog.js';
import { probeReviewTransportRuntime } from '../reviewloop/adapters/cliReviewTransports.js';

export function createReviewLoopMcpServer({
  controller = null,
  cwd = process.cwd(),
  // Runtime resolution inputs, probed once by startReviewLoopMcpServer (async).
  // Left null here so a bare createReviewLoopMcpServer() spawns nothing.
  agyCatalog = null,
  transportRuntime = null,
  // { supported, reason } verdict that agy actually loads the isolated
  // reviewloop-minimal agent. null -> AGY per-call verification stays off.
  customAgentSupport = null,
} = {}) {
  const server = new McpServer({ name: 'reviewloop', version: '1.0.0' });

  const ctl = controller ?? createReviewLoopController(
    createProductionReviewLoopProviders({ agyCatalog, transportRuntime, customAgentSupport }),
  );

  server.registerTool(
    'reviewloop_begin',
    {
      description:
        'Register a ReviewLoop session for a non-trivial coding task BEFORE your first edit so the baseline is captured. Pass prNumber to review an open PR instead (PR base -> exact PR HEAD). ReviewLoop does not implement the task — you do, in this session. Returns a loopId. Zero model calls.',
      inputSchema: {
        goal: z.string().min(1).describe('the original user coding goal (immutable success definition)'),
        cwd: z.string().optional().describe('workspace directory (default: server cwd)'),
        prNumber: z.number().int().optional().describe('PR number — review the PR (base -> exact HEAD) instead of the local worktree'),
      },
      outputSchema: {
        loopId: z.string(),
        mode: z.enum(['LOCAL', 'PR']),
        status: z.literal('READY'),
        baseline: z.record(z.string(), z.any()).nullable(),
        prHead: z.string().nullable(),
        prBaseSha: z.string().nullable().optional(),
        repository: z.string().nullable().optional(),
        reviewer: z.string(),
      },
    },
    async ({ goal, cwd: reqCwd, prNumber }, extra) => {
      const res = await ctl.begin({
        goal,
        cwd: reqCwd ? path.resolve(reqCwd) : cwd,
        prNumber: prNumber ?? null,
        signal: extra?.signal,
      });
      const structured = {
        loopId: res.loopId,
        mode: res.mode,
        status: 'READY',
        baseline: res.baseline ?? null,
        prHead: res.prHead ?? null,
        prBaseSha: res.prBaseSha ?? null,
        repository: res.repository ?? null,
        reviewer: res.reviewer,
      };
      return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
    },
  );

  server.registerTool(
    'reviewloop_review',
    {
      description:
        'Run one ReviewLoop round for a loopId: deterministic Gate, then independent Reviewer if justified, then convergence policy. PASS -> done. REWORK -> fix the returned findings yourself in THIS session and call again. HUMAN_REQUIRED -> surface the blocker. WAITING_FOR_REVIEW -> transient (loop lease held, or the PR HEAD kept moving); call again once state settles. Blocks locally with zero model tokens while waiting.',
      inputSchema: {
        loopId: z.string().min(1).describe('the loopId from reviewloop_begin'),
      },
      outputSchema: {
        status: z.string(),
        loopId: z.string(),
        round: z.number().optional(),
        reason: z.string().nullable().optional(),
        blockingFindings: z.array(z.record(z.string(), z.any())).optional(),
        nonBlockingFindings: z.array(z.record(z.string(), z.any())).optional(),
        supervisorGuidance: z.string().nullable().optional(),
        head: z.string().nullable().optional(),
        nextAction: z.string().nullable().optional(),
        telemetry: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ loopId }, extra) => {
      const res = await ctl.review({
        loopId,
        signal: extra?.signal,
        onHeartbeat: async (msg) => {
          if (typeof extra?.sendNotification === 'function') {
            try {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken: extra?._meta?.progressToken ?? loopId,
                  progress: 1,
                  message: msg ?? `ReviewLoop ${loopId}: waiting (0 model tokens)`,
                },
              });
            } catch { /* ignore */ }
          }
        },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res,
        isError: res.status === 'FAILED',
      };
    },
  );

  return server;
}

export async function startReviewLoopMcpServer(options = {}) {
  // Probe runtime resolution inputs once at startup: the `agy models` catalog
  // (metadata listing, not a model call) and the CLI-transport availability
  // (`codex --version` / `claude --version`). Both degrade safely on failure.
  const [agyCatalog, transportRuntime, customAgentSupport] = await Promise.all([
    Promise.resolve().then(() => probeAgyModelCatalog()),
    probeReviewTransportRuntime(),
    // Zero-model-turn probe: does this agy build load the isolated
    // reviewloop-minimal agent from the redirected gemini dir? Unsupported ->
    // the AGY families fail closed instead of silently running the default agent.
    detectAgyCustomAgentSupport({ geminiDir: narrowAgyGeminiDir() }).catch((err) => ({
      supported: false, reason: `capability probe threw: ${err?.message ?? err}`,
    })),
  ]);
  const server = createReviewLoopMcpServer({
    agyCatalog, transportRuntime, customAgentSupport, ...options,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
