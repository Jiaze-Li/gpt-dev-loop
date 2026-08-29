// Cross-process ownership contender. Driven entirely by env vars so the test
// can spawn several of these against one workflow and release a barrier so
// they all reach ownership acquisition at nearly the same instant.
//
//   OWN_ROOT     worktree root (for MODE=acquire)
//   OWN_HOME     $HOME override (for MODE=run, so SUPERGPT_WORKTREE_ROOT resolves there)
//   OWN_WF       workflowId
//   OWN_BARRIER  barrier dir: writes ready-<id>, spins until <barrier>/go exists
//   OWN_ID       this contender's id
//   OWN_MODE     'acquire' (raw lease) | 'run' (full runSuperGPT resume w/ marker pipeline)

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const workflowId = process.env.OWN_WF;
const barrierDir = process.env.OWN_BARRIER;
const mode = process.env.OWN_MODE || 'acquire';
const id = process.env.OWN_ID || String(process.pid);

if (process.env.OWN_HOME) process.env.HOME = process.env.OWN_HOME;
const root = process.env.OWN_ROOT || path.join(process.env.HOME, '.supergpt', 'worktrees');

function out(o) { process.stdout.write(`${JSON.stringify({ pid: process.pid, id, ...o })}\n`); }

mkdirSync(barrierDir, { recursive: true });
writeFileSync(path.join(barrierDir, `ready-${id}`), '1');

const goFile = path.join(barrierDir, 'go');
const started = Date.now();
while (!existsSync(goFile)) {
  if (Date.now() - started > 15000) { out({ error: 'barrier timeout' }); process.exit(2); }
}

try {
  if (mode === 'acquire') {
    const { tryAcquireWorkflowOwnership } = await import(new URL('../../src/orchestrator/workflowOwnership.js', import.meta.url));
    const r = tryAcquireWorkflowOwnership({ root, workflowId });
    out({ acquired: r.acquired, code: r.code, ownerToken: r.ownerToken, ownerPid: r.ownerPid });
    if (r.acquired) { const t = Date.now(); while (Date.now() - t < 800) { /* hold live lease */ } }
  } else {
    const { runSuperGPT } = await import(new URL('../../src/orchestrator/supergpt.js', import.meta.url));
    const res = await runSuperGPT({
      workflowId,
      isResume: true,
      externalReadRoots: [],
      _pipeline: async () => {
        appendFileSync(path.join(barrierDir, 'pipeline.log'), `${process.pid}\n`);
        if (process.env.__CRASH === '1') throw new Error('simulated crash before delivery');
        await new Promise((rs) => setTimeout(rs, 500));
        return { status: 'WORKFLOW_DONE', summary: 'ok' };
      },
    });
    out({ status: res.status, code: res.code ?? null, ownerPid: res.ownerPid ?? null });
  }
} catch (err) {
  out({ error: err?.message ?? String(err) });
  process.exit(1);
}
