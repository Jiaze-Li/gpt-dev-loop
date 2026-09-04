// Claude Supervisor provider. Tool-free decision transport that takes
// semantic Supervisor context and returns validated decision protocol.
//
// This transport is also reused by Claude Planner/Reviewer adapters. Those
// roles are decision-only: only the Executor is allowed to mutate repository
// state. Keep the CLI in plan/read-only permission mode and own its full process
// group so cancellation cannot leave a descendant running after stop returns.

import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { assembleSupervisorPrompt, parseSupervisorJson } from "./agySupervisorProvider.js";
import { AdapterError, ADAPTER_ERROR_CODES, ProviderCancelledError } from "../errors.js";
import { PROCESS_GROUP_SPAWN_OPTS, terminateProcessTree } from "../processTree.js";

function classify(stderr = "", stdout = "") {
  const combined = `${stderr} ${stdout}`;
  if (/quota|rate.?limit|usage limit|too many requests|overloaded/i.test(combined)) return "PROVIDER_QUOTA_EXHAUSTED";
  if (/auth|login|credential|unauthori[sz]ed|api key/i.test(combined)) return "PROVIDER_AUTH_FAILED";
  return "PROVIDER_UNAVAILABLE";
}

export async function callClaude({
  prompt,
  model = "opus",
  timeoutMs = 180000,
  executable = "claude",
  spawn = nodeSpawn,
  env = process.env,
  cwd = process.cwd(),
  signal = null,
} = {}) {
  if (signal?.aborted) throw new ProviderCancelledError("Claude Supervisor call cancelled before launch", { model: model ?? null });
  const args = [
    "-p",
    "--output-format",
    "json",
    // Planner / Supervisor / Reviewer are decision-only. `acceptEdits` here
    // would let prompt-injected or mistaken non-Executor roles bypass the
    // isolated-worktree contract and mutate their cwd directly.
    "--permission-mode",
    "plan",
    ...(model ? ["--model", model] : []),
  ];
  const started = Date.now();
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        ...PROCESS_GROUP_SPAWN_OPTS,
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let treeTermination = null;

    const tearDownTree = () => {
      if (!treeTermination) treeTermination = terminateProcessTree(child);
      return treeTermination;
    };

    const finish = async (value, { awaitTree = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (awaitTree && treeTermination) await treeTermination.done;
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { tearDownTree(); } catch {}
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      try { tearDownTree(); } catch {}
    };
    if (signal?.aborted) onAbort();
    else if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      void finish({ error, aborted, timedOut }, { awaitTree: aborted || timedOut });
    });
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));
    child.on("close", (exitCode) => {
      void finish({
        exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        aborted,
        timedOut,
      }, { awaitTree: aborted || timedOut });
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
  const durationMs = Date.now() - started;
  if (result.aborted || signal?.aborted) {
    throw new ProviderCancelledError("Claude Supervisor call cancelled", { durationMs, model: model ?? null });
  }
  if (result.timedOut) {
    throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_TIMEOUT, "Claude Supervisor timed out", {
      providerFailure: "PROVIDER_TIMEOUT",
      durationMs,
      model: model ?? null,
    });
  }
  if (result.error || result.exitCode !== 0) {
    const stderr = result.stderr || "";
    const stdout = result.stdout || "";
    const failureCode = classify(stderr, stdout);
    throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_UNAVAILABLE, `Claude transport unavailable: ${stderr || stdout || result.error?.message}`, {
      providerFailure: failureCode,
      durationMs,
      model: model ?? null,
      exitCode: result.exitCode ?? null,
      stderr,
    });
  }

  let text = null;
  let usage = null;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed && typeof parsed === "object") {
      text = typeof parsed.result === "string" ? parsed.result : result.stdout;
      if (parsed.usage && typeof parsed.usage === "object") {
        usage = {
          input_tokens: parsed.usage.input_tokens ?? 0,
          output_tokens: parsed.usage.output_tokens ?? 0,
          cache_read_tokens: parsed.usage.cache_read_input_tokens ?? 0,
          cache_creation_tokens: parsed.usage.cache_creation_input_tokens ?? 0,
          total_tokens: (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
        };
      }
    }
  } catch {
    text = result.stdout;
  }

  if (!text) {
    throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, "Claude Supervisor returned no output", {
      providerFailure: "PROVIDER_PROTOCOL_ERROR",
      durationMs,
      model: model ?? null,
    });
  }

  return { text, usage, durationMs };
}

export function createClaudeSupervisorProvider({ call = callClaude, model = "opus", timeoutMs, executable, spawn, signal = null } = {}) {
  return {
    provider: "claude",
    model,
    async decide(context = {}, { effort } = {}) {
      const { prompt } = assembleSupervisorPrompt(context);
      const result = await call({ prompt, model, timeoutMs, executable, spawn, effort, signal });
      const callId = `call-claude-sup-${randomUUID()}`;
      const usage = result.usage ? { ...result.usage, callId } : { callId };
      let raw;
      // The provider DID respond (usage known) even when its reply fails
      // decoding/shape validation — attach usage so the reservation settles
      // SETTLED_KNOWN, not UNRESOLVED (see modelSpendReservation.js §6).
      try {
        const trimmed = result.text.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
        raw = JSON.parse(trimmed);
      } catch {
        throw new AdapterError(ADAPTER_ERROR_CODES.SUPERVISOR_INVALID_OUTPUT, "Claude Supervisor did not return a JSON decision", {
          providerFailure: "PROVIDER_PROTOCOL_ERROR",
          model,
          usage,
        });
      }
      let parsedDecision;
      try {
        parsedDecision = parseSupervisorJson(raw);
      } catch (err) {
        if (err instanceof AdapterError && !err.details?.usage) err.details = { ...(err.details ?? {}), usage };
        throw err;
      }
      const decision = { ...parsedDecision, conversationId: null };
      Object.defineProperties(decision, {
        callId: { value: callId, enumerable: false },
        usage: { value: usage, enumerable: false },
        durationMs: { value: result.durationMs, enumerable: false },
        effortResolved: { value: result.effortResolved ?? null, enumerable: false },
      });
      return decision;
    },
  };
}
