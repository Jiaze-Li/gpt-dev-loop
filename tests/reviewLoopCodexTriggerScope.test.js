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

function assertExactHeadScope(body, trigger, headSha) {
  assert.match(body, new RegExp(`^${trigger.replace('@', '\\@')}\\n`));
  assert.match(body, new RegExp(headSha));
  assert.match(body, /current PR HEAD/);
  assert.match(body, /Do not reuse or repeat findings from earlier commits or prior review rounds/);
  assert.match(body, /unless you independently verify the issue still exists/);
  assert.match(body, /An issue introduced earlier in the PR remains in scope if it still exists/);
}

test('Codex PR trigger scopes review to the exact current HEAD without suppressing still-present old bugs', async () => {
  const { backend, posted } = captureBackend();
  const headSha = 'abcdef0123456789abcdef0123456789abcdef01';

  await backend.postReviewTrigger({ prNumber: 4, reviewer: 'codex', headSha });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].prNumber, 4);
  assertExactHeadScope(posted[0].body, '@codex review', headSha);
});

test('Claude PR trigger uses the same exact-current-HEAD scope', async () => {
  const { backend, posted } = captureBackend();
  const headSha = 'fedcba9876543210fedcba9876543210fedcba98';

  await backend.postReviewTrigger({ prNumber: 4, reviewer: 'claude', headSha });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].prNumber, 4);
  assertExactHeadScope(posted[0].body, '@claude review', headSha);
});
