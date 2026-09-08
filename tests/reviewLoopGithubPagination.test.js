// `gh api --paginate` concatenates every page's JSON array back-to-back. The
// backend must parse+flatten that so multi-page review / review-comment results
// are not lost to a `JSON.parse` failure on concatenated arrays — WITHOUT
// depending on `gh --slurp` (gh >= 2.44). Zero network: every `gh` call is a
// fake execFile.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhTransport, flattenPaginated } from '../src/reviewloop/githubBackend.js';

function transportWith(responder) {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: responder(args) };
  };
  return { transport: createGhTransport({ execFile }), calls };
}

const review = (id, login = 'bot') => ({
  id, user: { login }, state: 'COMMENTED', body: `b${id}`,
  commit_id: 'HEAD', submitted_at: `2026-01-0${id}`, html_url: `u${id}`,
});
const comment = (id, login = 'bot') => ({
  id, user: { login }, body: `c${id}`, path: 'a.js', line: id,
  commit_id: 'HEAD', original_commit_id: 'HEAD', pull_request_review_id: 9, html_url: `cu${id}`,
});

test('listReviews: concatenated page arrays (plain --paginate) are flattened and mapped', async () => {
  const { transport, calls } = transportWith((args) => {
    assert.ok(args.includes('--paginate'), 'uses --paginate');
    assert.ok(!args.includes('--slurp'), 'does NOT depend on --slurp (gh >= 2.44)');
    // Real `gh api --paginate` output: two JSON arrays back-to-back.
    return `${JSON.stringify([review(1), review(2)])}\n${JSON.stringify([review(3)])}\n`;
  });
  const out = await transport.listReviews({ prNumber: 7 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.id), [1, 2, 3]);
  assert.equal(out[0].login, 'bot');
  assert.equal(out[2].body, 'b3');
  assert.equal(calls.length, 1);
});

test('listReviewComments: concatenated page arrays are flattened and mapped', async () => {
  const { transport } = transportWith(
    () => `${JSON.stringify([comment(1)])}${JSON.stringify([comment(2), comment(3)])}`,
  );
  const out = await transport.listReviewComments({ prNumber: 7 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.line), [1, 2, 3]);
  assert.equal(out[1].path, 'a.js');
});

test('a page whose body contains a bracket inside a string does not mis-split', () => {
  const weird = [{ id: 1, body: 'see ] and [ and "\\" here' }, { id: 2, body: 'plain' }];
  assert.deepEqual(flattenPaginated(`${JSON.stringify(weird)}${JSON.stringify([{ id: 3 }])}`),
    [...weird, { id: 3 }]);
});

test('empty result set -> [] (both endpoints)', async () => {
  const { transport } = transportWith(() => '[]');
  assert.deepEqual(await transport.listReviews({ prNumber: 7 }), []);
  assert.deepEqual(await transport.listReviewComments({ prNumber: 7 }), []);
});

test('empty stdout -> [] (no throw)', async () => {
  const { transport } = transportWith(() => '');
  assert.deepEqual(await transport.listReviews({ prNumber: 7 }), []);
});

test('single page does not regress', async () => {
  const { transport } = transportWith(() => JSON.stringify([[review(1), review(2)]]));
  const out = await transport.listReviews({ prNumber: 7 });
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

test('flattenPaginated tolerates an already-flat array, blank input, and legacy --slurp output', () => {
  assert.deepEqual(flattenPaginated(JSON.stringify([{ id: 1 }, { id: 2 }])), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(flattenPaginated('  '), []);
  // Legacy `--slurp` shape (one array of page arrays) still flattens correctly.
  assert.deepEqual(flattenPaginated(JSON.stringify([[{ id: 1 }], [{ id: 2 }]])), [{ id: 1 }, { id: 2 }]);
  // Concatenated empty pages.
  assert.deepEqual(flattenPaginated('[][]'), []);
});
