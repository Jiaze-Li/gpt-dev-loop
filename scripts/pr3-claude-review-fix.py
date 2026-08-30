from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once(
    'src/orchestrator/preflight.js',
    '  realpathSync,\n  readFileSync,',
    '  realpathSync,\n  readlinkSync,\n  readFileSync,',
)

replace_once(
    'src/orchestrator/workflowOwnership.js',
    'export function acquireWorkflowOwnership({\n',
    'export async function acquireWorkflowOwnership({\n',
)
replace_once(
    'src/orchestrator/workflowOwnership.js',
    "    const until = Date.now() + initializingRetryMs;\n    while (Date.now() < until) { /* brief spin; publication window is microseconds */ }",
    "    await new Promise((resolve) => setTimeout(resolve, initializingRetryMs));",
)

replace_once(
    'src/orchestrator/supergpt.js',
    '  const ownership = acquireWorkflowOwnership({\n',
    '  const ownership = await acquireWorkflowOwnership({\n',
)

print('remaining Claude review fixes applied')
