// `gh api --paginate --slurp` returns ONE JSON array of per-page arrays. The
// backend must parse+flatten it so multi-page review / review-comment results
// are not lost to a `JSON.parse` failure on concatenated arrays. Zero network:
// every `gh` call is a fake execFile.

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

test('listReviews: two pages are slurped, flattened and mapped', async () => {
  const { transport, calls } = transportWith((args) => {
    assert.ok(args.includes('--paginate') && args.includes('--slurp'), 'uses --paginate --slurp');
    return JSON.stringify([[review(1), review(2)], [review(3)]]);
  });
  const out = await transport.listReviews({ prNumber: 7 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.id), [1, 2, 3]);
  assert.equal(out[0].login, 'bot');
  assert.equal(out[2].body, 'b3');
  assert.equal(calls.length, 1);
});

test('listReviewComments: two pages are slurped, flattened and mapped', async () => {
  const { transport } = transportWith(() => JSON.stringify([[comment(1)], [comment(2), comment(3)]]));
  const out = await transport.listReviewComments({ prNumber: 7 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.line), [1, 2, 3]);
  assert.equal(out[1].path, 'a.js');
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

test('flattenPaginated tolerates an already-flat array of objects', () => {
  assert.deepEqual(flattenPaginated(JSON.stringify([{ id: 1 }, { id: 2 }])), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(flattenPaginated('  '), []);
  assert.deepEqual(flattenPaginated(JSON.stringify([[{ id: 1 }], [{ id: 2 }]])), [{ id: 1 }, { id: 2 }]);
});
