import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAgySupervisorProvider, buildAgySupervisorPrompt } from '../src/orchestrator/adapters/agySupervisorProvider.js';
import { createAgySupervisorSession, createAgyProviderSessionStore } from '../src/orchestrator/agyProviderSessions.js';
import { UsageTracker } from '../src/orchestrator/usageTracker.js';
import { TokenAwareSessionPolicy, createSupervisorCheckpoint } from '../src/orchestrator/tokenAwareSessionPolicy.js';
import { SUPERVISOR_SESSION_STRATEGIES } from '../src/orchestrator/supervisorCostPolicy.js';
import { assertRealProviderCallsAuthorized, REAL_PROVIDER_CALL_FLAG } from '../src/orchestrator/realProviderCallGuard.js';

async function main() {
  assertRealProviderCallsAuthorized({
    explicitLiveIntent: process.argv.slice(2).includes(REAL_PROVIDER_CALL_FLAG),
    entrypoint: 'scripts/measure-supervisor-decisions.js',
  });

  const usageTracker = new UsageTracker();
  const store = createAgyProviderSessionStore();
  const rawProvider = createAgySupervisorProvider();

  const supervisor = createAgySupervisorSession(rawProvider, {
    store,
    tokenPressureThreshold: 30000,
    usageTracker,
    requestedFamily: 'agy:gemini',
    strategy: SUPERVISOR_SESSION_STRATEGIES.CHECKPOINT_FRESH,
  });

  const decisionsContext = [
    {
      title: 'Turn 1 (Initial Plan Execution)',
      context: {
        workflowGoal: 'Build key-value parser and formatter module',
        repositoryContext: { repository_name: 'test-repo', branch: 'main', commit_sha: 'abc123' },
        history: [],
        latestReviewResult: null,
      },
    },
    {
      title: 'Turn 2 (Task 1 Complete -> Next Task)',
      context: {
        workflowGoal: 'Build key-value parser and formatter module',
        repositoryContext: { repository_name: 'test-repo', branch: 'main', commit_sha: 'def456' },
        history: [{ task_id: 'task-1-parser', decision: 'PASS', attempts: 1 }],
        latestReviewResult: { decision: 'PASS', task_id: 'task-1-parser' },
      },
    },
    {
      title: 'Turn 3 (Task 2 Complete -> Workflow Done)',
      context: {
        workflowGoal: 'Build key-value parser and formatter module',
        repositoryContext: { repository_name: 'test-repo', branch: 'main', commit_sha: '789xyz' },
        history: [
          { task_id: 'task-1-parser', decision: 'PASS', attempts: 1 },
          { task_id: 'task-2-formatter', decision: 'PASS', attempts: 1 },
        ],
        latestReviewResult: { decision: 'PASS', task_id: 'task-2-formatter' },
      },
    },
  ];

  const results = [];
  for (let i = 0; i < decisionsContext.length; i++) {
    const { title, context } = decisionsContext[i];
    const promptText = buildAgySupervisorPrompt(context);
    const promptBytes = Buffer.byteLength(promptText, 'utf8');
    const checkpoint = createSupervisorCheckpoint(context);
    const checkpointBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');

    const t0 = Date.now();
    const decision = await supervisor.decide(context);
    const durationMs = Date.now() - t0;

    const convId = decision.conversationId ?? null;

    results.push({
      callNum: i + 1,
      title,
      action: decision.action,
      convId,
      sessionGeneration: supervisor.sessionGeneration,
      fresh: true,
      effortRequested: decision.effortResolved ?? 'low',
      promptBytes,
      checkpointBytes,
      durationMs,
      usage: decision.usage || {},
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

// Only run the live measurement when executed directly, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(err.exitCode ?? 1);
  });
}
