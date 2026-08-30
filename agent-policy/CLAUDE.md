# Claude-specific integration

Follow the shared SuperGPT front-agent policy above.

- Prefer the `supergpt_*` MCP tools when they are available in Claude Code.
- For autonomous execution, use `supergpt_start` and observe with `supergpt_watch` rather than repeatedly reasoning about status.
- If the MCP tools are not available but shell execution is available, invoke the installed SuperGPT CLI at `{{SUPERGPT_CLI}}` from the user's current workspace rather than silently taking over a substantial task yourself.
- Claude-specific project instructions may describe the target repository, but global SuperGPT delegation policy belongs here, not in individual repositories.
