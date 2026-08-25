## task_id
e2e-test-001

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/Jiaze-Li/gpt-dev-loop
branch: phase1-handshake
commit_sha: none

## goal
Create docs/E2E_TEST.md with exactly:

hello supergpt

## context
This is the first end-to-end validation of gpt-dev-loop.
The task is intentionally simple to verify the complete workflow execution path.

## scope
In scope:
- Creating docs/E2E_TEST.md with the required content.
Out of scope:
- Any other file.

## allowed_files
- docs/E2E_TEST.md

## forbidden_files
- src/**
- docs/workflow/**

## acceptance_criteria
- [ ] docs/E2E_TEST.md exists
- [ ] content is exactly: hello supergpt

## verification_commands
- `cat docs/E2E_TEST.md`

## completion_signal
DONE
