/**
 * Shared types for the A2A (Agent2Agent) protocol, hand-written from the spec.
 * Only the subset needed for this PoC is modelled: text messages, tasks with a
 * state machine, agent cards, and the JSON-RPC 2.0 envelope.
 *
 * Spec reference: https://a2a-protocol.org  (message/send, tasks/get, AgentCard)
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;

/** Standard JSON-RPC error codes plus the A2A-specific ones we use. */
export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A-specific errors (from the A2A spec's reserved range)
  TASK_NOT_FOUND: -32001,
  RATE_LIMITED: -32005,
} as const;

// ---------------------------------------------------------------------------
// A2A Message / Task objects
// ---------------------------------------------------------------------------

/** This PoC only exchanges text parts (inputModes/outputModes = ["text/plain"]). */
export interface TextPart {
  kind: "text";
  text: string;
}

export interface A2AMessage {
  kind: "message";
  /** "user" = the caller (another agent counts as a user), "agent" = the responder. */
  role: "user" | "agent";
  parts: TextPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  /** Free-form metadata; we use it to carry guardrail flags without polluting the text. */
  metadata?: Record<string, unknown>;
}

/**
 * Task state machine:
 *
 *   submitted ──> working ──> completed
 *                    │  └───> failed
 *                    └──────> input-required   (terminal for this PoC too)
 */
export type TaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "input-required";

export interface TaskStatus {
  state: TaskState;
  /** Optional agent message explaining the state (e.g. failure reason). */
  message?: A2AMessage;
  timestamp: string; // ISO-8601
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: TextPart[];
}

export interface A2ATask {
  kind: "task";
  id: string;
  /** Groups related tasks across agents; the orchestrator propagates one contextId. */
  contextId: string;
  status: TaskStatus;
  /** The actual output(s) of the task. */
  artifacts?: Artifact[];
  /** Message history for this task (inputs received). */
  history?: A2AMessage[];
}

// ---------------------------------------------------------------------------
// Agent Card (served at /.well-known/agent-card.json)
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCard {
  protocolVersion: "1.0";
  name: string;
  description: string;
  /** Base URL other agents should send JSON-RPC requests to. */
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  /**
   * Auth requirements. This PoC runs on a trusted docker network, so no scheme
   * is required — an empty security array means "no auth needed" per the spec.
   */
  securitySchemes: Record<string, unknown>;
  security: unknown[];
}

// ---------------------------------------------------------------------------
// Small helpers used by every agent
// ---------------------------------------------------------------------------

export function textMessage(
  role: "user" | "agent",
  text: string,
  extra: Partial<Pick<A2AMessage, "taskId" | "contextId" | "metadata">> = {},
): A2AMessage {
  return {
    kind: "message",
    role,
    parts: [{ kind: "text", text }],
    messageId: crypto.randomUUID(),
    ...extra,
  };
}

/** Concatenate all text parts of a message (we only use text parts). */
export function messageText(msg: A2AMessage): string {
  return msg.parts.map((p) => p.text).join("\n");
}

/** Pull the primary text output out of a completed task (first artifact, else status message). */
export function taskOutputText(task: A2ATask): string {
  const artifactText = task.artifacts?.[0]?.parts.map((p) => p.text).join("\n");
  if (artifactText) return artifactText;
  if (task.status.message) return messageText(task.status.message);
  return "";
}
