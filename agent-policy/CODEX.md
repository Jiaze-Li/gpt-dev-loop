# Codex-specific integration

Follow the shared SuperGPT front-agent policy above.

- Prefer the `supergpt_*` MCP tools when they are available in Codex.
- For autonomous execution, use `supergpt_start` and observe with `supergpt_watch`; do not re-implement work that SuperGPT owns.
- If the MCP tools are not available but shell execution is available, invoke the installed SuperGPT CLI at `{{SUPERGPT_CLI}}` from the user's current workspace rather than silently taking over a substantial task yourself.
- Repository `AGENTS.md` files should contain project-specific instructions. Global SuperGPT delegation policy belongs in the user-level policy installed by SuperGPT.
