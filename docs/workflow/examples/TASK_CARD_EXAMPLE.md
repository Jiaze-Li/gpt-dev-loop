## task_id
e2e-example-001

## repository_context
repository_name: gpt-dev-loop
repository_url: https://github.com/example/gpt-dev-loop
branch: main
commit_sha: abc123

## goal
Create docs/E2E_TEST.md containing exactly the line "hello supergpt".

## context
First end-to-end validation of the orchestrator's Task Card path; deliberately
trivial so the workflow's mechanics, not the task content, are what's tested.

## scope
In scope:
- Creating docs/E2E_TEST.md with the exact required content.
Out of scope:
- Any change to orchestrator source, adapters, or protocol documents.

## allowed_files
- docs/E2E_TEST.md

## forbidden_files
- src/**
- docs/workflow/**

## acceptance_criteria
- [ ] docs/E2E_TEST.md exists
- [ ] docs/E2E_TEST.md contains exactly "hello supergpt"

## verification_commands
- `cat docs/E2E_TEST.md`

## completion_signal
DONE
