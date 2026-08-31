import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectReviewThreads } from '../src/dashboard/meta.js';
import { deriveWorkflowTimeline } from '../src/dashboard/timeline.js';
import { getWorkflowDetail } from '../src/dashboard/server.js';
import { renderDashboardHtml } from '../src/dashboard/view.js';

const findings = [
  { signature: 'open', lifecycle: 'OPEN', threadResolutionStatus: 'NOT_ATTEMPTED', file: 'src/a.js', line: 4, severity: 'P1' },
  { signature: 'fixed', lifecycle: 'FIXED', threadResolutionStatus: 'PENDING', file: 'src/b.js', line: 8, severity: 'P2' },
  { signature: 'resolved', lifecycle: 'RESOLVED', threadResolutionStatus: 'RESOLVED', file: 'src/c.js', line: 12, severity: 'P2' },
  { signature: 'failed', lifecycle: 'FIXED', threadResolutionStatus: 'FAILED', file: 'src/d.js', line: 16, severity: 'P1' },
];

test('review-thread projection reflects durable lifecycle and does not count FAILED as resolved', () => {
  const projection = projectReviewThreads({ prCloseout: { reviewFindings: findings } });
  assert.deepEqual(
    { open: projection.open, resolved: projection.resolved, resolutionFailed: projection.resolutionFailed },
    { open: 3, resolved: 1, resolutionFailed: 1 },
  );
  assert.deepEqual(projection.findings.map((finding) => finding.lifecycle), ['OPEN', 'FIXED', 'RESOLVED', 'FIXED']);

  const inconsistent = projectReviewThreads({ reviewFindings: [
    { lifecycle: 'RESOLVED', threadResolutionStatus: 'FAILED' },
  ] });
  assert.equal(inconsistent.resolved, 0);
  assert.equal(inconsistent.open, 1);
  assert.equal(inconsistent.resolutionFailed, 1);
  assert.equal(inconsistent.findings[0].lifecycle, 'FIXED');
});

test('workflow detail and timeline expose the persisted review-thread projection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-review-threads-'));
  const workflowId = 'wf-agy-review-1111-2222-3333-444455556666';
  const now = new Date().toISOString();
  const state = {
    workflowId,
    workflowStatus: 'DONE',
    stage: 'DONE',
    startedAt: now,
    lastProgressAt: now,
    heartbeatAt: now,
    prCloseout: { reviewFindings: findings },
  };
  fs.writeFileSync(path.join(root, `${workflowId}.state.json`), JSON.stringify(state));

  try {
    const detail = getWorkflowDetail({ workflowId, root });
    assert.equal(detail.reviewThreads.open, 3);
    assert.equal(detail.reviewThreads.resolved, 1);
    assert.equal(detail.reviewThreads.resolutionFailed, 1);
    assert.match(detail.timeline.find((event) => event.type === 'REVIEW_THREADS').label,
      /Open 3, Resolved 1, Resolution Failed 1/);

    const chronological = deriveWorkflowTimeline(state);
    assert.ok(chronological.some((event) => event.detail?.includes('OPEN P1 src/a.js')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard HTML renders review thread summary and per-finding lifecycle badges', () => {
  const html = renderDashboardHtml();
  assert.match(html, /Review Threads/);
  assert.match(html, /Resolution Failed/);
  assert.match(html, /reviewThreads\.findings\.map/);
  assert.match(html, /\['OPEN', 'FIXED', 'RESOLVED'\]/);
});
