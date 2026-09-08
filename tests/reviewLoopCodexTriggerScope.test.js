import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubReviewBackend } from '../src/reviewloop/githubBackend.js';

function captureBackend() {
  const posted = [];
  return {
    posted,
    backend: createGithubReviewBackend({
      transport: {
        async postComment(args) {
          posted.push(args);
          return { id: 'trigger-1' };
        },
      },
    }),
  };
}

test('Codex PR trigger scopes review to the exact current HEAD without suppressing still-present old bugs', async () => {
  const { backend, posted } = captureBackend();
  const headSha = 'abcdef0123456789abcdef0123456789abcdef01';

  await backend.postReviewTrigger({ prNumber: 4, reviewer: 'codex', headSha });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].prNumber, 4);
  assert.match(posted[0].body, /^@codex review\n/);
  assert.match(posted[0].body, new RegExp(headSha));
  assert.match(posted[0].body, /current PR HEAD/);
  assert.match(posted[0].body, /Do not reuse or repeat findings from earlier commits or prior review rounds/);
  assert.match(posted[0].body, /unless you independently verify the issue still exists/);
  assert.match(posted[0].body, /An issue introduced earlier in the PR remains in scope if it still exists/);
});

test('Claude PR trigger remains the standard command', async () => {
  const { backend, posted } = captureBackend();

  await backend.postReviewTrigger({ prNumber: 4, reviewer: 'claude', headSha: 'HEAD' });

  assert.equal(posted[0].body, '@claude review');
});
