/**
 * SUB-AGENT B — Verifier (port 4002)
 *
 * No tools. Takes { task, output } as JSON in the message text, makes ONE LLM
 * call constrained to JSON, and returns a structured verdict:
 *
 *   { pass: boolean, reason: string, confidence: number }
 *
 * Guardrail #5 (output schema enforcement): the LLM response is parsed with
 * Zod. If parsing fails, retry ONCE with a "respond only in valid JSON"
 * correction message; if it still fails, the task is marked failed — we never
 * guess a verdict.
 */
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { audit, summarize } from "../../shared/audit.js";
import {
  a2aMessageSchema,
  rateLimit,
  scanForInjection,
  tasksGetParamsSchema,
} from "../../shared/guardrails.js";
import { jsonRpcEndpoint, JsonRpcHandlerError } from "../../shared/jsonrpc-server.js";
import { chat, type ChatMessage } from "../../shared/llm.js";
import { TaskStore } from "../../shared/task-store.js";
import {
  JsonRpcErrorCodes,
  messageText,
  textMessage,
  type A2AMessage,
  type A2ATask,
  type AgentCard,
} from "../../shared/types.js";

const AGENT_NAME = "verifier-agent";
const PORT = Number(process.env.VERIFIER_PORT ?? 4002);
const PUBLIC_URL = process.env.VERIFIER_URL ?? `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Verdict schema — the ONLY shape we accept from the LLM.
// ---------------------------------------------------------------------------

const verdictSchema = z.object({
  pass: z.boolean(),
  reason: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
export type Verdict = z.infer<typeof verdictSchema>;

/** Same schema as JSON Schema, passed to the LLM as a structured-output constraint. */
const verdictJsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["pass", "reason", "confidence"],
};

/** What the orchestrator sends us inside the A2A message text. */
const verifyRequestSchema = z.object({
  task: z.string().min(1).max(10_000),
  output: z.string().min(1).max(20_000),
});

const SYSTEM_PROMPT = [
  "You are a strict verification agent.",
  "You are given an original task and the output another agent produced for it.",
  "Judge whether the output actually satisfies the task: is it on-topic, complete, and plausible?",
  'Respond ONLY with a JSON object: {"pass": boolean, "reason": string, "confidence": number between 0 and 1}.',
  "No prose, no markdown, no code fences — just the JSON object.",
].join(" ");

// ---------------------------------------------------------------------------
// The verification call (single LLM call + one schema-correction retry)
// ---------------------------------------------------------------------------

async function verify(taskId: string, originalTask: string, output: string): Promise<Verdict> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `ORIGINAL TASK:\n${originalTask}\n\nAGENT OUTPUT TO VERIFY:\n${output}`,
    },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await chat(AGENT_NAME, { messages, format: verdictJsonSchema });

    // Guardrail #5: Zod-validate the LLM's "JSON" before trusting it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.message.content);
    } catch {
      parsed = undefined;
    }
    const verdict = verdictSchema.safeParse(parsed);
    if (verdict.success) return verdict.data;

    audit(AGENT_NAME, {
      event: "guardrail",
      from: AGENT_NAME,
      to: AGENT_NAME,
      taskId,
      inputSummary: summarize(result.message.content),
      detail: { guardrail: "output-schema", attempt, willRetry: attempt === 1 },
    });

    if (attempt === 1) {
      // One correction round: feed the bad output back with an explicit fix-it instruction.
      messages.push(result.message);
      messages.push({
        role: "user",
        content:
          'Your previous response was not valid JSON matching {"pass": boolean, "reason": string, "confidence": number}. ' +
          "Respond again with ONLY that JSON object and nothing else.",
      });
    }
  }
  throw new Error("Verifier LLM failed to produce schema-valid JSON after retry");
}

// ---------------------------------------------------------------------------
// A2A server wiring
// ---------------------------------------------------------------------------

const agentCard: AgentCard = {
  protocolVersion: "1.0",
  name: AGENT_NAME,
  description:
    "Verifier sub-agent. Given an original task and an executor's output, returns a structured pass/fail verdict with reason and confidence.",
  url: PUBLIC_URL,
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "verify-output",
      name: "Verify task output",
      description:
        'Input: JSON {"task": string, "output": string}. Output: JSON {"pass": boolean, "reason": string, "confidence": number}.',
      tags: ["verification", "llm-judge", "structured-output"],
    },
  ],
  securitySchemes: {},
  security: [],
};

const taskStore = new TaskStore();
const messageSendParams = z.object({ message: a2aMessageSchema });

async function handleMessageSend(params: unknown): Promise<A2ATask> {
  const parsed = messageSendParams.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid message/send params");
  }
  const message = parsed.data.message as A2AMessage;
  const text = messageText(message);

  const task = taskStore.create(message);

  // Guardrail #2: injection scan on inbound text (the executor's output could carry an attack).
  const scan = scanForInjection(AGENT_NAME, text, task.id);
  if (scan.flagged) {
    console.warn(`[${AGENT_NAME}] prompt-injection patterns in task ${task.id}: ${scan.matches.join(", ")}`);
  }

  // The payload itself must be JSON {task, output} — validated before any LLM call.
  let payload: z.infer<typeof verifyRequestSchema>;
  try {
    payload = verifyRequestSchema.parse(JSON.parse(text));
  } catch {
    taskStore.transition(
      task.id,
      "failed",
      textMessage("agent", 'Invalid payload: expected JSON {"task": string, "output": string}', {
        taskId: task.id,
        contextId: task.contextId,
      }),
    );
    return taskStore.get(task.id)!;
  }

  taskStore.transition(task.id, "working");
  try {
    const verdict = await verify(task.id, payload.task, payload.output);
    taskStore.addArtifact(task.id, "verdict", JSON.stringify(verdict));
    taskStore.transition(task.id, "completed");
  } catch (err) {
    console.error(`[${AGENT_NAME}] verification failed:`, err);
    taskStore.transition(
      task.id,
      "failed",
      textMessage("agent", "Verification failed: could not obtain a schema-valid verdict", {
        taskId: task.id,
        contextId: task.contextId,
      }),
    );
  }
  return taskStore.get(task.id)!;
}

async function handleTasksGet(params: unknown): Promise<A2ATask> {
  const parsed = tasksGetParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid tasks/get params");
  }
  const task = taskStore.get(parsed.data.id);
  if (!task) {
    throw new JsonRpcHandlerError(JsonRpcErrorCodes.TASK_NOT_FOUND, `Task not found: ${parsed.data.id}`);
  }
  return task;
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard));

app.post(
  "/",
  rateLimit(AGENT_NAME, 10),
  jsonRpcEndpoint(AGENT_NAME, {
    "message/send": handleMessageSend,
    "tasks/get": handleTasksGet,
  }),
);

app.listen(PORT, () => {
  console.log(`[${AGENT_NAME}] listening on :${PORT} — card at ${PUBLIC_URL}/.well-known/agent-card.json`);
});
