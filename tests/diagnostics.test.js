import test from 'node:test';
import assert from 'node:assert/strict';
import { isCloudflareChallenge, describePageState, classifyComposerTimeout } from '../src/bridge/diagnostics.js';

test('isCloudflareChallenge recognizes common Cloudflare interstitial titles', () => {
  assert.equal(isCloudflareChallenge('Just a moment...'), true);
  assert.equal(isCloudflareChallenge('Checking your browser before accessing chatgpt.com'), true);
  assert.equal(isCloudflareChallenge('Attention Required! | Cloudflare'), true);
  assert.equal(isCloudflareChallenge('ChatGPT'), false);
  assert.equal(isCloudflareChallenge(''), false);
  assert.equal(isCloudflareChallenge(undefined), false);
});

test('describePageState formats url and title for diagnostics', () => {
  const summary = describePageState({ url: 'https://chatgpt.com/', title: 'ChatGPT' });
  assert.equal(summary, 'url=https://chatgpt.com/ title="ChatGPT"');
});

test('describePageState tolerates missing url/title', () => {
  const summary = describePageState({});
  assert.equal(summary, 'url=(unknown) title=""');
});

test('classifyComposerTimeout flags a Cloudflare title distinctly from a generic mismatch', () => {
  const cloudflare = classifyComposerTimeout({ url: 'https://chatgpt.com/', title: 'Just a moment...' }, 5000);
  assert.equal(cloudflare.kind, 'cloudflare');
  assert.match(cloudflare.message, /Cloudflare/);
  assert.match(cloudflare.message, /url=https:\/\/chatgpt\.com\//);

  const mismatch = classifyComposerTimeout({ url: 'https://chatgpt.com/', title: 'ChatGPT' }, 5000);
  assert.equal(mismatch.kind, 'selector-mismatch');
  assert.match(mismatch.message, /layout may have changed/);
  assert.match(mismatch.message, /title="ChatGPT"/);
});
