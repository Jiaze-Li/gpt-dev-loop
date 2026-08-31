import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const repoUrl = new URL('..', import.meta.url);

const adapterFiles = [
  'src/adapters/frontend/geminiAdapter.js',
  'src/adapters/frontend/claudeAdapter.js',
  'src/adapters/frontend/codexAdapter.js',
];

const retiredPolicyFiles = [
  'skills/supergpt/SKILL.md',
  '.agents/skills/supergpt/SKILL.md',
  '.agents/rules/',
  'agent-policy/CLAUDE.md',
  'agent-policy/CODEX.md',
  'agent-policy/AGY.md',
];

test('COMMON.md is the sole active front-agent routing and launch contract', async () => {
  const common = await readFile(new URL('agent-policy/COMMON.md', repoUrl), 'utf8');
  const installer = await readFile(new URL('bin/install-plugin.js', repoUrl), 'utf8');

  assert.match(common, /single active SuperGPT policy/i);
  assert.match(common, /default to SuperGPT/i);
  assert.match(common, /supergpt_route\(\{ goal, cwd \}\)/);
  assert.match(common, /supergpt_start\(\{ goal, cwd \}\)/);
  assert.match(common, /supergpt_watch\(\{ workflowId \}\)/);
  assert.match(common, /supergpt_run/);
  assert.match(common, /blocking convenience operation/i);
  assert.match(common, /do not use the SuperGPT CLI as an agent fallback/i);

  assert.match(installer, /agent-policy['"], ['"]COMMON\.md/);
  assert.doesNotMatch(installer, /POLICY_FILE[\s\S]*skills[\/\\]supergpt/i);

  for (const relativePath of retiredPolicyFiles) {
    assert.equal(
      existsSync(new URL(relativePath, repoUrl)),
      false,
      `Retired parallel policy must not exist: ${relativePath}`,
    );
  }
});

test('frontend adapters contain transport mechanics only, not duplicated behavior policy', async () => {
  for (const relativePath of adapterFiles) {
    const text = await readFile(new URL(relativePath, repoUrl), 'utf8');
    assert.match(text, /generateMcpConfig/);
    assert.match(text, /agent-policy\/COMMON\.md/);
    assert.doesNotMatch(text, /supergpt_(?:start|watch|run|plan|status|resume|stop)/);
    assert.doesNotMatch(text, /HUMAN_REQUIRED/);
    assert.doesNotMatch(text, /Normal autonomous/i);
    assert.doesNotMatch(text, /Use SuperGPT to/i);
  }
});
