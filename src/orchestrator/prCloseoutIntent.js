// Resolves PR Closeout intent from natural language instructions.

import { execSync } from 'node:child_process';

export function parseRepoFromGit(cwd = process.cwd()) {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!remoteUrl) return null;
    // matches git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (match) return match[1];
  } catch {}
  return null;
}

export function parsePrCloseoutGoal(goal = '', { cwd = process.cwd() } = {}) {
  const text = String(goal || '').trim();
  if (!text) return { isPrCloseout: false };

  // Check if text matches PR closeout intent
  const isCloseoutIntent =
    /\b(close\s*out|closeout|review\s*(?:and|&)?\s*(?:fix|repair)|fix\s*until\s*(?:review\s*)?clean)\b/i.test(text) ||
    /检查.*(?:修复|clean|pr|pull\s*request)/i.test(text) ||
    /修到.*clean/i.test(text) ||
    /修(?:复)?到\s*(?:review\s*)?clean/i.test(text) ||
    (/\b(?:pr|pull\s*request)\s*#?\d+\b/i.test(text) && /(fix|repair|clean|close|review|检查|修复|审查|修到)/i.test(text));

  if (!isCloseoutIntent) {
    return { isPrCloseout: false };
  }

  // 1. Extract PR number
  let prNumber = null;
  const prMatch = text.match(/(?:pr|pull\s*request)\s*#?(\d+)/i) || text.match(/#(\d+)/);
  if (prMatch) {
    prNumber = parseInt(prMatch[1], 10);
  }

  if (!prNumber) {
    return { isPrCloseout: false };
  }

  // 2. Extract repository
  let ownerRepo = null;
  // Check explicit owner/repo (e.g. "owner/repo PR #123" or "github.com/owner/repo/pull/123")
  const explicitRepoMatch = text.match(/\b([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\s+(?:pr|pull\s*request)/i) ||
    text.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/pull\/\d+/i);

  if (explicitRepoMatch) {
    ownerRepo = explicitRepoMatch[1];
  } else {
    // If not in goal, derive from current cwd git repository
    ownerRepo = parseRepoFromGit(cwd);
  }

  return {
    isPrCloseout: true,
    prNumber,
    repository: ownerRepo || null,
    ambiguousRepo: !ownerRepo,
  };
}
