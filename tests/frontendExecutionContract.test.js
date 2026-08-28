import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { GeminiFrontendAdapter } from '../src/adapters/frontend/geminiAdapter.js';
import { ClaudeFrontendAdapter } from '../src/adapters/frontend/claudeAdapter.js';
import { CodexFrontendAdapter } from '../src/adapters/frontend/codexAdapter.js';

const repoUrl = new URL('..', import.meta.url);

test('installed skill and frontend rules default normal autonomous execution to non-blocking supergpt_start', async () => {
  const skill = await readFile(new URL('.agents/skills/supergpt/SKILL.md', repoUrl), 'utf8');
  const rule = await readFile(new URL('.agents/rules/supergpt.md', repoUrl), 'utf8');
  const instructions = [
    skill,
    rule,
    new GeminiFrontendAdapter().generateSkillDefinition(),
    new ClaudeFrontendAdapter().generateClaudeInstructions(),
    new CodexFrontendAdapter().generateCodexInstructions(),
  ];

  for (const text of instructions) {
    assert.match(text, /supergpt_start\(\{ goal, cwd \}\)/);
    assert.match(text, /status: "RUNNING", workflowId/);
    assert.match(text, /supergpt_run/);
    assert.match(text, /blocking convenience API/i);
  }

  assert.doesNotMatch(skill, /\| \*"Use SuperGPT to implement X"\*[\s\S]*?\| If sufficiently clear, call `supergpt_run/);
  assert.doesNotMatch(rule, /normal autonomous chat\/frontend execution, invoke `supergpt_run/);
});
