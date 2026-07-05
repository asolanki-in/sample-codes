/**
 * A2A client helper — how one agent talks to another. No SDK, just fetch.
 *
 * Responsibilities:
 *   - fetch + cache the remote agent-card.json (discovery)
 *   - send JSON-RPC "message/send" / "tasks/get" requests
 *   - guardrail #6: 15s timeout with a single retry on every inter-agent call
 *   - guardrail #7: audit-log every call (from, to, taskId, latency, summaries)
 */
import type { A2AMessage, A2ATask, AgentCard, JsonRpcResponse } from "./types.js";
import { textMessage } from "./types.js";
import { audit, summarize } from "./audit.js";

const A2A_TIMEOUT_MS = 15_000;
const A2A_MAX_ATTEMPTS = 2; // 1 try + 1 retry

/** Fetch a remote agent's card. The orchestrator calls this once at startup and caches it. */
export async function fetchAgentCard(baseUrl: string): Promise<AgentCard> {
  const url = `${baseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(A2A_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Failed to fetch agent card from ${url}: HTTP ${res.status}`);
  return (await res.json()) as AgentCard;
}

/** Low-level JSON-RPC call with timeout + one retry. */
async function rpcCall<T>(
  selfName: string,
  card: AgentCard,
  method: string,
  params: unknown,
  taskId?: string,
): Promise<T> {
  const request = { jsonrpc: "2.0" as const, id: crypto.randomUUID(), method, params };
  let lastError: unknown;

  for (let attempt = 1; attempt <= A2A_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(card.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(A2A_TIMEOUT_MS), // guardrail: 15s per attempt
      });
      const json = (await res.json()) as JsonRpcResponse<T>;

      if ("error" in json) {
        // A structured JSON-RPC error is a *response*, not a transport failure — don't retry.
        throw new A2ARemoteError(json.error.code, json.error.message);
      }

      audit(selfName, {
        event: "a2a-call",
        from: selfName,
        to: card.name,
        taskId,
        latencyMs: Date.now() - started,
        inputSummary: summarize(JSON.stringify(params)),
        outputSummary: summarize(JSON.stringify(json.result)),
        detail: { method, attempt },
      });
      return json.result;
    } catch (err) {
      lastError = err;
      audit(selfName, {
        event: "a2a-call",
        from: selfName,
        to: card.name,
        taskId,
        latencyMs: Date.now() - started,
        inputSummary: summarize(JSON.stringify(params)),
        outputSummary: `ERROR: ${summarize(String(err))}`,
        detail: { method, attempt, willRetry: attempt < A2A_MAX_ATTEMPTS && !(err instanceof A2ARemoteError) },
      });
      if (err instanceof A2ARemoteError) throw err; // remote said no — retrying won't help
    }
  }
  throw new Error(`A2A call ${method} to ${card.name} failed after ${A2A_MAX_ATTEMPTS} attempts: ${lastError}`);
}

/** The remote agent returned a JSON-RPC error object. */
export class A2ARemoteError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "A2ARemoteError";
  }
}

/**
 * Send a text message to a remote agent ("message/send").
 *
 * Executor/verifier block until the task is terminal, so the returned task is
 * completed/failed. The automation agents return immediately (state
 * "working") and are polled with tasks/get.
 *
 * Pass opts.taskId to CONTINUE an existing remote task — that's how user
 * input reaches a task sitting in "input-required" (A2A continuation).
 */
export async function sendMessage(
  selfName: string,
  card: AgentCard,
  text: string,
  opts: { contextId?: string; taskId?: string; metadata?: Record<string, unknown> } = {},
): Promise<A2ATask> {
  const message: A2AMessage = textMessage("user", text, {
    contextId: opts.contextId,
    taskId: opts.taskId,
    metadata: opts.metadata,
  });
  return rpcCall<A2ATask>(selfName, card, "message/send", { message }, opts.taskId);
}

/** Poll a task on a remote agent by id ("tasks/get"). */
export async function getTask(selfName: string, card: AgentCard, taskId: string): Promise<A2ATask> {
  return rpcCall<A2ATask>(selfName, card, "tasks/get", { id: taskId }, taskId);
}
