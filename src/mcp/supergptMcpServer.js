// SuperGPT MCP Server implementation.
//
// Exposes SuperGPT to any front-facing agent (Gemini, Claude Code, Codex, IDE assistants)
// as stable, frontend-neutral MCP tools:
//
//   supergpt_plan   — turn a natural-language instruction into a bounded,
//                     verification-ready plan (or surface an AMBIGUOUS
//                     question) WITHOUT executing anything.
//   supergpt_run    — run the complete loop (isolated worktree -> plan ->
//                     Supervisor/Executor/Reviewer -> safe delivery),
//                     returning the structured result plus every typed
//                     event that was emitted.
//   supergpt_start  — alias for supergpt_run.
//   supergpt_status — report on SuperGPT workflows with live state, progress block,
//                     heartbeat, and process health without calling an LLM.
//   supergpt_wait   — wait locally for workflow completion/transition (0 model tokens).
//   supergpt_resume — resume a suspended workflow (e.g. after HUMAN_REQUIRED).
//   supergpt_stop   — safely stop an active workflow and kill child processes.

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  runSuperGPT,
  startSuperGPT,
  supergptResume,
  supergptStop,
  supergptWait,
  supergptFormatProgress,
  toCanonicalProgress,
} from '../orchestrator/supergpt.js';
import { SUPERGPT_WORKTREE_ROOT } from '../orchestrator/workflowWorktree.js';
import { resolveWorkflowPlan } from '../../scripts/run-agy-workflow.js';
import { callAgy as defaultCallAgy } from '../agy/agyClient.js';
import { renderGenericProgress } from '../renderers/genericTextRenderer.js';
import { compileSuperGptRequest } from '../control/requestCompiler.js';

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

    // Merge live state if exists
    const stateFile = name.replace(WORKSPACE_METADATA_SUFFIX, '.state.json');
    let live = null;
    try {
      live = JSON.parse(await readTextFile(path.join(root, stateFile)));
    } catch {
      /* ignore */
    }

    const canonical = live ? toCanonicalProgress(live) : null;

    const merged = {
      workflow_id: meta.workflow_id,
      source_workspace: meta.source_workspace,
      source_branch: meta.source_branch,
      worktree_path: meta.worktree_path,
      created_at: meta.created_at,
      status: live?.workflowStatus ?? 'UNKNOWN',
      stage: live?.stage ?? 'UNKNOWN',
      taskIndex: live?.taskIndex ?? null,
      taskTotal: live?.taskTotal ?? null,
      taskId: live?.taskId ?? null,
      taskName: live?.taskName ?? null,
      attempt: live?.attempt ?? 1,
      executorModel: live?.executorModel ?? 'sonnet',
      modelEscalated: live?.modelEscalated ?? false,
      escalationReason: live?.escalationReason ?? null,
      heartbeatAt: live?.heartbeatAt ?? null,
      lastProgressAt: live?.lastProgressAt ?? null,
      lastActivityAt: live?.lastActivityAt ?? null,
      stageStatuses: live?.stageStatuses ?? null,
      tokenUsage: live?.tokenUsage ?? null,
      reason: live?.reason ?? live?.error ?? null,
      question: live?.question ?? null,
      summary: live?.summary ?? null,
      formattedProgress: live ? renderGenericProgress(canonical || live) : null,
      canonicalProgress: canonical,
    };
    workflows.push(merged);
  }
  workflows.sort((a, b) => String(b.workflow_id).localeCompare(String(a.workflow_id)));
  return workflows;
}

export function createSuperGptMcpServer({
  runSuperGptFn = runSuperGPT,
  startSuperGptFn = startSuperGPT,
  resumeSuperGptFn = supergptResume,
  stopSuperGptFn = supergptStop,
  waitSuperGptFn = supergptWait,
  resolveWorkflowPlanFn = resolveWorkflowPlan,
  readWorkflowStatusFn = readWorkflowStatus,
  callAgy = defaultCallAgy,
  cwd = process.cwd(),
} = {}) {
  const server = new McpServer({ name: 'supergpt', version: '1.0.0' });

  server.registerTool(
    'supergpt_prepare',
    {
      description: 'Use this whenever a user asks to use SuperGPT, wants a SuperGPT-ready prompt, wants work converted into SuperGPT format, or asks for SuperGPT planning/execution. Pass the raw user intent and invocation workspace; SuperGPT returns portable supergpt.request/v1 semantics and owns normalization and task decomposition. The caller never writes internal Task Cards.',
      inputSchema: {
        goal: z.string().min(1).describe('raw natural-language user request'),
        cwd: z.string().optional().describe('exact invocation workspace'),
        constraints: z.union([z.string(), z.array(z.string())]).optional(),
        mode: z.enum(['prepare', 'plan', 'execute', 'export']).optional(),
      },
      outputSchema: { schema: z.literal('supergpt.request/v1'), goal: z.string(), execution_mode: z.string(), workspace: z.string() },
    },
    async ({ goal, cwd: requestCwd, constraints, mode }) => {
      const structured = compileSuperGptRequest({ goal, cwd: requestCwd ? path.resolve(requestCwd) : cwd, constraints, mode });
      return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
    },
  );

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

  const runHandler = async ({ goal, planPath, cwd: runCwd }) => {
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
      tokenUsage: result.tokenUsage ?? null,
      events,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
      isError: structured.status === 'FAILED',
    };
  };

  server.registerTool(
    'supergpt_run',
    {
      description:
        'Run the complete SuperGPT development loop for a goal (or an existing plan file): isolated worktree, planning, Supervisor/Executor/Reviewer, then safe delivery back to the invocation workspace. Returns the structured result, token usage, and events.',
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
        tokenUsage: z.record(z.string(), z.any()).nullable().optional(),
        events: z.array(z.record(z.string(), z.any())),
      },
    },
    runHandler,
  );

  server.registerTool(
    'supergpt_start',
    {
      description: 'Non-blocking start. Returns RUNNING and workflowId immediately; Core owns the workflow lifetime.',
      inputSchema: {
        goal: z.string().min(1).optional().describe('natural-language instruction'),
        planPath: z.string().min(1).optional().describe('path to an existing plan file'),
        cwd: z.string().optional().describe('invocation workspace (default: server cwd)'),
      },
      outputSchema: {
        status: z.string(),
        workflowId: z.string().nullable(),
      },
    },
    async ({ goal, planPath, cwd: runCwd }) => {
      if (!goal && !planPath) throw new Error('supergpt_start requires either "goal" or "planPath"');
      const started = startSuperGptFn({ goal, planPath, cwd: runCwd ? path.resolve(runCwd) : cwd });
      const structured = { status: 'RUNNING', workflowId: started.workflowId };
      return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
    },
  );

  server.registerTool(
    'supergpt_status',
    {
      description:
        'Report on SuperGPT workflows with live state, progress block, heartbeat, and process health without calling an LLM. Pass "workflowId" to narrow to one.',
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

  server.registerTool(
    'supergpt_wait',
    {
      description:
        'Wait locally with zero model tokens. Without targetStatus, waits until terminal; with targetStatus, waits for that status.',
      inputSchema: {
        workflowId: z.string().min(1).describe('workflow id to wait for'),
        timeoutMs: z.number().optional().describe('maximum milliseconds to wait (default: 60000)'),
        targetStatus: z.string().optional().describe('target status to wait for (e.g. DONE, HUMAN_REQUIRED, STOPPED)'),
      },
      outputSchema: {
        workflowId: z.string(),
        status: z.string(),
        stage: z.string(),
        formattedProgress: z.string(),
      },
    },
    async ({ workflowId, timeoutMs = 60000, targetStatus }) => {
      const state = await waitSuperGptFn({
        workflowId,
        timeoutMs,
        predicate: (s) => (targetStatus ? s.workflowStatus === targetStatus : ['DONE', 'HUMAN_REQUIRED', 'FAILED', 'TIMEOUT', 'STALLED', 'STOPPED'].includes(s.workflowStatus)),
      });
      const structured = {
        workflowId,
        status: state.workflowStatus,
        stage: state.stage,
        formattedProgress: renderGenericProgress(toCanonicalProgress(state) || state),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    'supergpt_resume',
    {
      description:
        'Resume a suspended SuperGPT workflow (e.g. after HUMAN_REQUIRED). Preserves exact workflow state, worktree, and conversations, and applies user answer/clarification.',
      inputSchema: {
        workflowId: z.string().min(1).describe('id of the suspended workflow to resume'),
        answer: z.string().optional().describe('user decision / answer to the question if status was HUMAN_REQUIRED'),
        cwd: z.string().optional().describe('workspace directory'),
      },
      outputSchema: {
        status: z.string(),
        summary: z.string().nullable(),
        deliveredFiles: z.array(z.string()),
        workflowId: z.string().nullable(),
        reason: z.string().nullable(),
        question: z.string().nullable(),
        tokenUsage: z.record(z.string(), z.any()).nullable().optional(),
        events: z.array(z.record(z.string(), z.any())),
      },
    },
    async ({ workflowId, answer, cwd: runCwd }) => {
      const events = [];
      const result = await resumeSuperGptFn({
        workflowId,
        answer,
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
        tokenUsage: result.tokenUsage ?? null,
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
    'supergpt_stop',
    {
      description:
        'Safely stop an active SuperGPT workflow. Terminates active child processes, records STOPPED state, and preserves recoverable resources.',
      inputSchema: {
        workflowId: z.string().min(1).describe('workflow id to stop'),
        reason: z.string().optional().describe('reason for stopping (default: stopped by user)'),
      },
      outputSchema: {
        workflowId: z.string(),
        status: z.string(),
        reason: z.string(),
        pidsKilled: z.array(z.number()),
      },
    },
    async ({ workflowId, reason = 'stopped by user' }) => {
      const result = await stopSuperGptFn({ workflowId, reason });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
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
