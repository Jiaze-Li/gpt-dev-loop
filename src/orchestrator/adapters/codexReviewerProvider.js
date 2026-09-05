// Codex Reviewer provider. Evaluates task execution against evidence
// in read-only sandbox mode and returns structured Review Result.

import { randomUUID } from "node:crypto";
import { assembleReviewerPrompt, parseReviewJson } from "./agyReviewerProvider.js";
import { callCodex } from "./codexSupervisorProvider.js";
import { AdapterError, ADAPTER_ERROR_CODES } from "../errors.js";

export function createCodexReviewerProvider({ call = callCodex, model = null, timeoutMs, executable, spawn, signal = null } = {}) {
  return {
    provider: "codex",
    model,
    async review(taskCard, executionReport, evidence, { attempt, checkpoint } = {}) {
      const { prompt } = assembleReviewerPrompt(taskCard, executionReport, evidence, { attempt, checkpoint });
      const result = await call({ prompt, model, timeoutMs, executable, spawn, signal });
      let obj;
      try {
        const trimmed = result.text.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
        obj = JSON.parse(trimmed);
      } catch {
        throw new AdapterError(ADAPTER_ERROR_CODES.REVIEWER_INVALID_OUTPUT, "Codex Reviewer did not return a JSON decision", {
          providerFailure: "PROVIDER_PROTOCOL_ERROR",
          model,
        });
      }
      const callId = `call-codex-rev-${randomUUID()}`;
      const reviewResult = {
        ...parseReviewJson(taskCard.task_id, obj, taskCard.repository_context ?? null),
        conversationId: null,
      };
      const usage = result.usage ? { ...result.usage, callId } : { callId };
      Object.defineProperties(reviewResult, {
        callId: { value: callId, enumerable: false },
        usage: { value: usage, enumerable: false },
        durationMs: { value: result.durationMs, enumerable: false },
      });
      return reviewResult;
    },
  };
}
