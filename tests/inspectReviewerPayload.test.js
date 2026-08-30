import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sizeOf, sliceSections, classifyStatus, inspect } from '../scripts/inspect-reviewer-payload.js';

test('sizeOf reports chars, utf-8 bytes, lines', () => {
  assert.deepEqual(sizeOf('abc'), { chars: 3, bytes: 3, lines: 1 });
  assert.deepEqual(sizeOf('a\nb'), { chars: 3, bytes: 3, lines: 2 });
  assert.deepEqual(sizeOf('é'), { chars: 1, bytes: 2, lines: 1 });
  assert.deepEqual(sizeOf(''), { chars: 0, bytes: 0, lines: 0 });
});

test('sliceSections splits on literal headings', () => {
  const text = '# A\naaa\n# B\nbbb\n# C\nccc';
  const out = sliceSections(text, ['# A', '# B', '# C']);
  assert.equal(out['# A'], '# A\naaa\n');
  assert.equal(out['# B'], '# B\nbbb\n');
  assert.equal(out['# C'], '# C\nccc');
});

test('sliceSections returns null for an absent heading', () => {
  const out = sliceSections('# A\nx', ['# A', '# Z']);
  assert.equal(out['# Z'], null);
});

test('classifyStatus separates tracked/untracked/staged', () => {
  const porcelain = [
    ' M src/a.js',
    'M  src/b.js',
    'MM src/c.js',
    'A  src/d.js',
    '?? new.txt',
    '?? another.txt',
  ].join('\n');
  const c = classifyStatus(porcelain);
  assert.equal(c.total, 6);
  assert.equal(c.trackedChanged, 4);
  assert.equal(c.untracked, 2);
  assert.equal(c.staged, 3); // M , MM, A  (index side non-space)
});

test('inspect() reproduces git-diff-HEAD evidence scope with no base anchor', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'inspect-payload-')));
  try {
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
    g('add', '-A');
    g('commit', '-qm', 'init');
    // pre-existing dirty change unrelated to any task
    writeFileSync(path.join(dir, 'tracked.txt'), 'modified unrelated\n');
    // an untracked file, as a task that only creates files would produce
    writeFileSync(path.join(dir, 'task-output.txt'), 'agy-e2e-ok\n');
    const planPath = path.join(dir, 'plan.txt');
    writeFileSync(planPath, 'Create task-output.txt with content agy-e2e-ok\n');

    const r = await inspect(planPath, { cwd: dir });
    assert.equal(r.baseCommit, null);
    assert.match(r.diffScope, /ENTIRE dirty working tree/);
    // the unrelated tracked change IS in the diff
    assert.equal(r.changedFileCount, 1);
    assert.ok(r.rawGitDiff.chars > 0);
    // untracked files (task output + plan) are NOT counted in the diff
    assert.equal(r.workingTree.untracked, 2);
    assert.equal(r.workingTree.trackedChanged, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
