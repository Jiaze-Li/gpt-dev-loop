#!/usr/bin/env node
// SuperGPT MCP server.
//
// Exposes SuperGPT to a front-facing agent (Gemini, an external coding
// agent, an IDE assistant) as three MCP tools, so the agent can invoke and
// supervise a full autonomous development loop without micromanaging it:
//
//   supergpt_plan   — turn a natural-language instruction into a bounded,
//                     verification-ready plan (or surface an AMBIGUOUS
//                     question) WITHOUT executing anything.
//   supergpt_run    — run the complete loop (isolated worktree -> plan ->
//                     Supervisor/Executor/Reviewer -> safe delivery),
//                     returning the structured result plus every typed
//                     event that was emitted.
//   supergpt_status — report on SuperGPT workflows that have started,
//                     reading only the safe workspace-state metadata
//                     SuperGPT records per workflow (never file contents,
//                     diffs, or prompt/reply text).
//
// Everything is dependency-injected so tests stay deterministic and
// offline — no Chrome, no agy, no git worktrees.

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { runSuperGPT } from '../src/orchestrator/supergpt.js';
import { SUPERGPT_WORKTREE_ROOT } from '../src/orchestrator/workflowWorktree.js';
import { resolveWorkflowPlan } from '../scripts/run-agy-workflow.js';
import { callAgy as defaultCallAgy } from '../src/agy/agyClient.js';

const WORKSPACE_METADATA_SUFFIX = '.workspace.json';

// Read the safe per-workflow workspace metadata SuperGPT records under
// SUPERGPT_WORKTREE_ROOT. Returns an array (newest-mtime first). Missing
// root / unreadable or malformed files are tolerated, never thrown on.
export async function readWorkflowStatus({
  root = SUPERGPT_WORKTREE_ROOT,
  workflowId,
  readDir = readdir,
  readTextFile = (p) => readFile(p, 'utf8'),
} = {}) {
  let entries;
  try {
    entries = await readDir(root);
  } catch {
    return [];
  }
  const files = entries.filter((name) => String(name).endsWith(WORKSPACE_METADATA_SUFFIX));

  const workflows = [];
  for (const name of files) {
    let meta;
    try {
      meta = JSON.parse(await readTextFile(path.join(root, name)));
    } catch {
      continue;
    }
    if (!meta || typeof meta !== 'object') continue;
    if (workflowId && meta.workflow_id !== workflowId) continue;
    workflows.push(meta);
  }
  workflows.sort((a, b) => String(b.workflow_id).localeCompare(String(a.workflow_id)));
  return workflows;
}

export function createSuperGptMcpServer({
  runSuperGptFn = runSuperGPT,
  resolveWorkflowPlanFn = resolveWorkflowPlan,
  readWorkflowStatusFn = readWorkflowStatus,
  callAgy = defaultCallAgy,
  cwd = process.cwd(),
} = {}) {
  const server = new McpServer({ name: 'supergpt', version: '0.1.0' });

  server.registerTool(
    'supergpt_plan',
    {
      description:
        'Turn a natural-language coding instruction into a bounded, verification-ready SuperGPT plan without executing it. Returns status "READY" with a summary + ordered tasks, or "AMBIGUOUS" with the single question a human must answer.',
      inputSchema: {
        goal: z.string().min(1, 'goal must not be empty'),
        cwd: z.string().optional().describe('repository to plan against (default: server cwd)'),
      },
      outputSchema: {
        status: z.enum(['READY', 'AMBIGUOUS']),
        summary: z.string().nullable(),
        planText: z.string().nullable(),
        tasks: z.array(z.record(z.string(), z.any())).nullable(),
        question: z.string().nullable(),
      },
    },
    async ({ goal, cwd: planCwd }) => {
      const resolved = await resolveWorkflowPlanFn({
        planArg: goal,
        cwd: planCwd ? path.resolve(planCwd) : cwd,
        callAgy,
      });
      const structured =
        resolved.status === 'AMBIGUOUS'
          ? {
              status: 'AMBIGUOUS',
              summary: null,
              planText: null,
              tasks: null,
              question: resolved.question,
            }
          : {
              status: 'READY',
              summary: resolved.summary ?? null,
              planText: resolved.plan ?? null,
              tasks: resolved.tasks ?? null,
              question: null,
            };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    'supergpt_run',
    {
      description:
        'Run the complete SuperGPT development loop for a goal (or an existing plan file): isolated worktree, planning, Supervisor/Executor/Reviewer, then safe delivery back to the invocation workspace. Returns the structured result and every typed event emitted. status is WORKFLOW_DONE | HUMAN_REQUIRED | CANCELLED | FAILED; on HUMAN_REQUIRED read "question".',
      inputSchema: {
        goal: z.string().min(1).optional().describe('natural-language instruction'),
        planPath: z.string().min(1).optional().describe('path to an existing plan file (takes precedence over goal)'),
        cwd: z.string().optional().describe('invocation workspace (default: server cwd)'),
      },
      outputSchema: {
        status: z.string(),
        summary: z.string().nullable(),
        deliveredFiles: z.array(z.string()),
        workflowId: z.string().nullable(),
        reason: z.string().nullable(),
        question: z.string().nullable(),
        events: z.array(z.record(z.string(), z.any())),
      },
    },
    async ({ goal, planPath, cwd: runCwd }) => {
      if (!goal && !planPath) {
        throw new Error('supergpt_run requires either "goal" or "planPath"');
      }
      const events = [];
      const result = await runSuperGptFn({
        goal,
        planPath,
        cwd: runCwd ? path.resolve(runCwd) : cwd,
        onEvent: (event) => events.push(event),
      });
      const structured = {
        status: result.status,
        summary: result.summary ?? null,
        deliveredFiles: result.deliveredFiles ?? [],
        workflowId: result.workflowId ?? null,
        reason: result.reason ?? null,
        question: result.question ?? null,
        events,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError: structured.status === 'FAILED',
      };
    },
  );

  server.registerTool(
    'supergpt_status',
    {
      description:
        'Report on SuperGPT workflows that have started, from the safe workspace-state metadata SuperGPT records per workflow. Pass "workflowId" to narrow to one. Never exposes file contents, diffs, or prompt/reply text.',
      inputSchema: {
        workflowId: z.string().optional().describe('narrow to a single workflow id'),
      },
      outputSchema: {
        workflows: z.array(z.record(z.string(), z.any())),
      },
    },
    async ({ workflowId }) => {
      const workflows = await readWorkflowStatusFn({ workflowId });
      const structured = { workflows };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  );

  return server;
}

export async function startSuperGptMcpServer(options = {}) {
  const server = createSuperGptMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  await startSuperGptMcpServer();
}
