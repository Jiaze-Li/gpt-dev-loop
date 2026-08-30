# SuperGPT Front-Agent Contract

This is the single active SuperGPT policy for Claude, Codex, and AGY. Do not maintain client-specific routing or launch rules elsewhere.

## Front-agent role

Claude, Codex, and AGY are human interfaces and launchers. They accept the user's request, decide whether it belongs in SuperGPT, launch the workflow, relay local progress, and return the terminal result. Once SuperGPT owns a task, the front agent must not duplicate planning, implementation, verification, review, or rework.

## V1 routing

For requests that modify code, default to SuperGPT unless the work is obviously a trivial, single-step, low-risk edit.

Use the front agent directly only for explanation/research-only requests and obvious tiny edits such as a typo, one small documentation edit, or one explicit low-risk value change.

Use SuperGPT for features, bug fixes, refactors, migrations, debugging, tests, multi-file or multi-layer changes, repeated implement/verify cycles, or any request where planning and independent review are valuable. When uncertain, choose SuperGPT.

V2 will replace this front-agent judgment with the deterministic zero-token `supergpt_route` operation. Until then, all three frontends apply this exact policy.

## One launch path

When SuperGPT is selected, use the SuperGPT MCP tools. Do not use the SuperGPT CLI as an agent fallback and do not create another execution path.

Normal autonomous execution:

1. Call `supergpt_start({ goal, cwd })` with the user's original goal and exact current workspace.
2. Receive `{ status: "RUNNING", workflowId }`.
3. Attach `supergpt_watch({ workflowId })` for local zero-model-token progress until terminal.
4. Relay meaningful progress without redoing SuperGPT's reasoning or work.
5. Return the terminal result. Ask the user only when the workflow reaches a genuine `HUMAN_REQUIRED` state or the user explicitly asks to intervene.

Other MCP operations:

- `supergpt_plan({ goal, cwd })` when the user explicitly asks to plan before execution.
- `supergpt_status({ workflowId })` for an on-demand local status snapshot.
- `supergpt_verify({ workflowId })` for trusted host verification when requested by the workflow.
- `supergpt_resume({ workflowId, answer, cwd })` after a required human answer or accepted host verification.
- `supergpt_stop({ workflowId })` when the user asks to stop.
- `supergpt_run` only when a caller explicitly needs a blocking convenience operation.

If the SuperGPT MCP is unavailable, report the installation/configuration problem instead of silently taking over a substantial task. The CLI remains a human-operated diagnostic/recovery interface, not an alternate agent workflow.

## Invariants

- Invocation workspace in -> the same workspace receives approved changes out.
- Front agents do not invent Task Cards or internal workflow state.
- Front agents do not independently inspect or re-review work that SuperGPT owns unless the user explicitly asks for a separate review.
- Progress observation is local and must not spend model calls asking whether the workflow is still running.
- Repository-local instructions may add project-specific build, test, style, and architecture rules, but must not redefine this global routing/launch contract.
- A new policy or entrypoint replaces the old one; do not keep parallel fallback policies or duplicate launch paths.
