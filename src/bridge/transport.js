// Picks which askGpt(prompt, config) implementation backs the Reviewer
// Adapter's default transport, based on config.browserMode. The only
// consumer is gptReviewerAdapter.js's createGptReviewerAdapter — the
// orchestrator core never imports this file (ADAPTER_INTERFACE.md §4).

import { askGpt as askGptPlaywright } from './chatgptWeb.js';
import { askGpt as askGptExtension } from './chatgptExtension.js';

export function resolveAskGpt(config) {
  return config.browserMode === 'extension' ? askGptExtension : askGptPlaywright;
}
