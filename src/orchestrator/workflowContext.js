const RELEVANT_PATH_FIELDS = [
  'allowed_files',
  'read_targets',
  'required_files',
  'context_files',
  'verification_files',
  'task_relevant_paths',
];

function normalize(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : '';
}

function globPattern(pattern) {
  const escaped = normalize(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')}$`);
}

export function executorRelevantPaths(taskCard) {
  const paths = new Set();
  for (const field of RELEVANT_PATH_FIELDS) {
    const values = Array.isArray(taskCard?.[field]) ? taskCard[field] : [taskCard?.[field]];
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) paths.add(normalize(value.trim()));
    }
  }
  return [...paths].sort();
}

export function isExecutorRelevantPath(filePath, taskCard) {
  const candidate = normalize(filePath);
  if (!candidate) return false;
  return executorRelevantPaths(taskCard).some((selected) => {
    if (selected.includes('*')) return globPattern(selected).test(candidate);
    return candidate === selected || candidate.startsWith(`${selected.replace(/\/$/, '')}/`);
  });
}

function compactStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
}

// This is the sole cross-attempt handoff to an Executor. It intentionally
// accepts durable facts, not provider messages, workflow events, transcripts,
// complete diffs, or prior execution reports.
export function buildExecutorHandoff(taskCard) {
  const handoff = { schema: 'supergpt.executor-handoff/v1', task_id: taskCard.task_id };
  if (taskCard.rework_feedback) {
    handoff.corrections = {
      findings: compactStrings(taskCard.rework_feedback.findings),
      required_changes: compactStrings(taskCard.rework_feedback.required_changes),
      rationale: typeof taskCard.rework_feedback.rationale === 'string' ? taskCard.rework_feedback.rationale.trim() : null,
    };
  }
  const guidance = taskCard.supervisor_guidance ?? taskCard.repair_guidance;
  if (typeof guidance === 'string' && guidance.trim()) handoff.supervisor_guidance = guidance.trim();
  if (taskCard.unauthorized_probe_guidance) {
    handoff.verification_guidance = {
      denied_commands: compactStrings(taskCard.unauthorized_probe_guidance.denied_commands),
      approved_verification_commands: compactStrings(taskCard.verification_commands),
    };
  }
  const snapshots = (taskCard.auxiliary_snapshots ?? [])
    .filter((item) => isExecutorRelevantPath(item?.original_path ?? item?.original_symlink_path, taskCard))
    .map((item) => ({
      original_path: normalize(item.original_path ?? item.original_symlink_path),
      snapshot_path: normalize(item.snapshot_path),
      sha256: item.sha256 ?? item.content_hash ?? null,
      read_only: item.read_only === true,
    }))
    .sort((a, b) => a.original_path.localeCompare(b.original_path));
  if (snapshots.length) handoff.repository_snapshots = snapshots;
  return handoff;
}

export function hasExecutorHandoffFacts(handoff) {
  return Object.keys(handoff).some((key) => !['schema', 'task_id'].includes(key));
}
