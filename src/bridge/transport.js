// Picks which askGpt(prompt, config) implementation to use, based on
// config.browserMode. Consumers: gptReviewerAdapter.js (Reviewer Adapter's
// default transport), cli.js (`gpt-loop ask`), and mcp/server.js (the
// `ask_gpt` tool) — the orchestrator core never imports this file
// (ADAPTER_INTERFACE.md §4).

import { askGpt as askGptPlaywright } from './chatgptWeb.js';
import { askGpt as askGptExtension } from './chatgptExtension.js';

export function resolveAskGpt(config) {
  return config.browserMode === 'extension' ? askGptExtension : askGptPlaywright;
}
