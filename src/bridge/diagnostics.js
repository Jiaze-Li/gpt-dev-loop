const CLOUDFLARE_TITLE_PATTERN = /just a moment|checking your browser|attention required|cloudflare/i;

export function isCloudflareChallenge(title) {
  return CLOUDFLARE_TITLE_PATTERN.test(title || '');
}

export function describePageState({ url, title }) {
  return `url=${url || '(unknown)'} title="${title || ''}"`;
}

export function classifyComposerTimeout({ url, title }, timeoutMs) {
  const summary = describePageState({ url, title });

  if (isCloudflareChallenge(title)) {
    return {
      kind: 'cloudflare',
      message:
        `Timed out after ${timeoutMs}ms: ChatGPT appears stuck behind a Cloudflare/bot-check ` +
        `challenge (${summary}). Complete the challenge manually in the opened browser window and retry.`,
    };
  }

  return {
    kind: 'selector-mismatch',
    message:
      `Could not find the ChatGPT composer within ${timeoutMs}ms (${summary}). ` +
      'The page layout may have changed, or login/consent may still be pending.',
  };
}
