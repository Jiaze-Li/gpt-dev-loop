import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { cleanupWorkflowChromeProfile } from '../src/bridge/chromeProfile.js';
import { workflowProfileDir } from '../src/config.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gpt-dev-loop-chrome-profile-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('cleanupWorkflowChromeProfile removes only that workflow_id\'s Chrome profile directory', async () => {
  await withTempDir(async (baseDir) => {
    const baseProfileDir = path.join(baseDir, '.gpt-dev-loop', 'chrome-profile');
    const first = workflowProfileDir('wf-111', baseProfileDir);
    const second = workflowProfileDir('wf-222', baseProfileDir);
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(path.join(first, 'Cookies'), 'demo');
    await fs.writeFile(path.join(second, 'Cookies'), 'demo');

    await cleanupWorkflowChromeProfile('wf-111', baseProfileDir);

    await assert.rejects(() => fs.access(first));
    await assert.doesNotReject(() => fs.access(second));
  });
});

test('cleanupWorkflowChromeProfile does not touch sibling artifacts directories', async () => {
  await withTempDir(async (baseDir) => {
    const baseProfileDir = path.join(baseDir, '.gpt-dev-loop', 'chrome-profile');
    const profileDir = workflowProfileDir('wf-111', baseProfileDir);
    await fs.mkdir(profileDir, { recursive: true });

    const artifactsDir = path.join(baseDir, 'project', '.gpt-dev-loop', 'workflows', 'wf-111', 'demo-task', 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'task_card.json'), '{}');

    await cleanupWorkflowChromeProfile('wf-111', baseProfileDir);

    await assert.rejects(() => fs.access(profileDir));
    await assert.doesNotReject(() => fs.access(path.join(artifactsDir, 'task_card.json')));
  });
});

test('cleanupWorkflowChromeProfile is a no-op when the profile directory never existed', async () => {
  await withTempDir(async (baseDir) => {
    const baseProfileDir = path.join(baseDir, '.gpt-dev-loop', 'chrome-profile');
    await assert.doesNotReject(() => cleanupWorkflowChromeProfile('wf-never-ran', baseProfileDir));
  });
});

test('cleanupWorkflowChromeProfile refuses a workflowId that would escape the workflows/ tree', async () => {
  await withTempDir(async (baseDir) => {
    const baseProfileDir = path.join(baseDir, '.gpt-dev-loop', 'chrome-profile');
    await assert.rejects(() => cleanupWorkflowChromeProfile('../../etc', baseProfileDir));
  });
});
