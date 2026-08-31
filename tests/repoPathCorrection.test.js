import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRepoPath,
  resolveRepoRelativePaths,
  WorkspacePathError,
} from '../src/orchestrator/workspaceConfig.js';
import { parsePlannerJson } from '../src/orchestrator/planner.js';

test('repo path correction: 缺少 adapters/ 层级时自动解析到真实文件', () => {
  const repoFiles = [
    'package.json',
    'src/orchestrator/adapters/claudeExecutorAdapter.js',
    'tests/claudeExecutorAdapter.test.js',
  ];

  const resolved = resolveRepoPath('src/orchestrator/claudeExecutorAdapter.js', repoFiles);
  assert.equal(resolved, 'src/orchestrator/adapters/claudeExecutorAdapter.js');
});

test('repo path correction: 唯一匹配自动纠正', () => {
  const repoFiles = [
    'src/deep/nested/sub/module/helper.js',
    'src/other/file.js',
  ];

  const resolved = resolveRepoPath('sub/module/helper.js', repoFiles);
  assert.equal(resolved, 'src/deep/nested/sub/module/helper.js');
});

test('repo path correction: 多候选时不猜', () => {
  const repoFiles = [
    'src/adapters/index.js',
    'src/control/index.js',
    'src/orchestrator/index.js',
  ];

  const resolved = resolveRepoPath('index.js', repoFiles);
  assert.equal(resolved, 'index.js');
});

test('repo path correction: 新文件保持原路径', () => {
  const repoFiles = [
    'src/orchestrator/adapters/claudeExecutorAdapter.js',
    'package.json',
  ];

  const resolved = resolveRepoPath('src/orchestrator/newFeature.js', repoFiles);
  assert.equal(resolved, 'src/orchestrator/newFeature.js');
});

test('repo path correction: 不允许越界路径', () => {
  const repoFiles = ['src/a.js'];
  assert.throws(() => resolveRepoPath('../outside.js', repoFiles), (err) => err instanceof WorkspacePathError);
  assert.throws(() => resolveRepoPath('/etc/passwd', repoFiles), (err) => err instanceof WorkspacePathError);
});

test('parsePlannerJson corrects allowed_files with repository context', () => {
  const repoFiles = [
    'src/orchestrator/adapters/claudeExecutorAdapter.js',
    'package.json',
  ];

  const plannerOutput = {
    status: 'READY',
    summary: 'Fix adapter',
    plan_text: '1. Update adapter',
    tasks: [
      {
        task_id: 'fix-adapter',
        goal: 'Fix adapter error handling',
        allowed_files: ['src/orchestrator/claudeExecutorAdapter.js', 'src/newFile.js'],
        verification_commands: ['npm test'],
      },
    ],
  };

  const parsed = parsePlannerJson(plannerOutput, { repoFiles });
  assert.deepEqual(parsed.tasks[0].allowed_files, [
    'src/orchestrator/adapters/claudeExecutorAdapter.js',
    'src/newFile.js',
  ]);
});
