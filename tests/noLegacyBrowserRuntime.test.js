import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function walkFiles(dir, predicate = () => true) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(...walkFiles(fullPath, predicate));
    } else if (entry.isFile() && predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

test('1. retired extension/ and src/bridge/ directories and legacy entrypoints do not exist', () => {
  const forbiddenPaths = [
    path.join(REPO_ROOT, 'extension'),
    path.join(REPO_ROOT, 'src', 'bridge'),
    path.join(REPO_ROOT, 'bin', 'gpt-loop.js'),
    path.join(REPO_ROOT, 'bin', 'gpt-loop-run.js'),
    path.join(REPO_ROOT, 'bin', 'gpt-loop-mcp.js'),
    path.join(REPO_ROOT, 'src', 'cli.js'),
    path.join(REPO_ROOT, 'src', 'orchestratorCli.js'),
    path.join(REPO_ROOT, 'src', 'mcp', 'server.js'),
    path.join(REPO_ROOT, 'src', 'config.js'),
    path.join(REPO_ROOT, 'src', 'orchestrator', 'adapters', 'gptReviewerAdapter.js'),
  ];

  for (const forbiddenPath of forbiddenPaths) {
    assert.equal(
      existsSync(forbiddenPath),
      false,
      `Forbidden legacy path still exists: ${path.relative(REPO_ROOT, forbiddenPath)}`
    );
  }
});

test('2. no active production source/bin/scripts import from extension/ or src/bridge/', () => {
  const sourceDirs = [
    path.join(REPO_ROOT, 'bin'),
    path.join(REPO_ROOT, 'src'),
    path.join(REPO_ROOT, 'scripts'),
    path.join(REPO_ROOT, 'tests'),
  ];

  const files = sourceDirs.flatMap((dir) =>
    walkFiles(dir, (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'))
  );

  const importPattern = /(?:from\s+['"][^'"]*(?:extension\/|bridge\/|src\/bridge|gptReviewerAdapter)[^'"]*['"]|import\s*\(['"][^'"]*(?:extension\/|bridge\/|src\/bridge|gptReviewerAdapter)[^'"]*['"]\))/g;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const matches = content.match(importPattern);
    assert.equal(
      matches,
      null,
      `File ${path.relative(REPO_ROOT, file)} has forbidden imports: ${matches?.join(', ')}`
    );
  }
});

test('3. package.json dependencies contain no browser automation / CDP / websocket bridge libraries', () => {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  const forbiddenLibs = [
    'playwright',
    'playwright-core',
    'puppeteer',
    'puppeteer-core',
    'selenium-webdriver',
    'chrome-remote-interface',
    'ws',
  ];

  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };

  for (const forbidden of forbiddenLibs) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(allDeps, forbidden),
      false,
      `package.json must not depend on ${forbidden}`
    );
  }
});

test('4. .mcp.json exposes only the current SuperGPT MCP server', () => {
  const mcpConfigPath = path.join(REPO_ROOT, '.mcp.json');
  assert.ok(existsSync(mcpConfigPath), '.mcp.json must exist');
  const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));

  assert.deepEqual(Object.keys(mcpConfig.mcpServers ?? {}), ['supergpt']);
  assert.equal(mcpConfig.mcpServers.supergpt.command, 'node');
  assert.deepEqual(mcpConfig.mcpServers.supergpt.args, ['bin/supergpt-mcp.js']);
});

test('5. package.json public bins are the intended V1 production bins', () => {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert.deepEqual(pkg.bin, {
    supergpt: 'bin/supergpt.js',
    'supergpt-mcp': 'bin/supergpt-mcp.js',
  });
});

test('6. active skill and architecture documentation does not instruct frontends to use Chrome extension or browser bridge', () => {
  const activeDocFiles = [
    path.join(REPO_ROOT, 'README.md'),
    path.join(REPO_ROOT, 'docs', 'ARCHITECTURE.md'),
    path.join(REPO_ROOT, 'skills', 'supergpt', 'SKILL.md'),
    path.join(REPO_ROOT, '.agents', 'skills', 'supergpt', 'SKILL.md'),
  ];

  const forbiddenInstructions = [
    /chrome\.runtime\.sendMessage/i,
    /GPT_BROWSER_MODE/i,
    /chrome-extension:\/\//i,
    /chatgpt.*dom.*automation/i,
    /chrome.*extension.*bridge/i,
  ];

  for (const docFile of activeDocFiles) {
    if (!existsSync(docFile)) continue;
    const content = readFileSync(docFile, 'utf8');
    for (const pattern of forbiddenInstructions) {
      assert.doesNotMatch(
        content,
        pattern,
        `Active document ${path.relative(REPO_ROOT, docFile)} matches forbidden pattern ${pattern}`
      );
    }
  }
});

test('7. docs/handoff/archive is explicitly exempt and preserved as historical record', () => {
  const archiveDir = path.join(REPO_ROOT, 'docs', 'handoff', 'archive');
  assert.ok(existsSync(archiveDir), 'docs/handoff/archive must exist');
  const archiveFiles = readdirSync(archiveDir);
  assert.ok(
    archiveFiles.includes('2026-08-25-chrome-extension-bridge.md'),
    '2026-08-25-chrome-extension-bridge.md must be preserved in archive'
  );
});
