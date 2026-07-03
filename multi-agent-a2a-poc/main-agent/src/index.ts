/**
 * MAIN AGENT — Orchestrator (port 4000)
 *
 * Has NO tools of its own. It is an A2A *client* of the two sub-agents:
 *
 *   POST /task  ──>  Executor (message/send: do the task)
 *                └─> Verifier (message/send: {task, output} -> verdict)
 *                └─> if verdict.pass === false: retry Executor ONCE with the
 *                    verifier's reason appended as extra context, re-verify
 *                └─> aggregate + return the final answer
 *
 * At startup it fetches each sub-agent's /.well-known/agent-card.json once,
 * caches the cards, and uses the `url` they declare for all message/send calls.
 *
 * It is also an A2A *server*: the same orchestration is reachable via
 * JSON-RPC message/send, and its tasks can be polled with tasks/get.
 */
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { fetchAgentCard, sendMessage } from "../../shared/a2a-client.js";
import { audit, summarize } from "../../shared/audit.js";
import {
  a2aMessageSchema,
  rateLimit,
  scanForInjection,
  tasksGetParamsSchema,
  validateBody,
} from "../../shared/guardrails.js";
import { jsonRpcEndpoint, JsonRpcHandlerError } from "../../shared/jsonrpc-server.js";
import { TaskStore } from "../../shared/task-store.js";
import {
  JsonRpcErrorCodes,
  messageText,
  taskOutputText,
  textMessage,
  type A2AMessage,
  type A2ATask,
  type AgentCard,
} from "../../shared/types.js";

const AGENT_NAME = "main-agent";
const PORT = Number(process.env.MAIN_PORT ?? 4000);
const PUBLIC_URL = process.env.MAIN_URL ?? `http://localhost:${PORT}`;
const EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://localhost:4001";
const VERIFIER_URL = process.env.VERIFIER_URL ?? "http://localhost:4002";

const agentCard: AgentCard = {
  protocolVersion: "1.0",
  name: AGENT_NAME,
  description:
    "Orchestrator agent. Accepts a user task, delegates execution to the executor-agent and verification to the verifier-agent over A2A, and aggregates the final answer. Has no tools of its own.",
  url: PUBLIC_URL,
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "orchestrate-task",
      name: "Orchestrate task",
      description: "Delegates a task to executor + verifier sub-agents and returns a verified answer.",
      tags: ["orchestration", "delegation", "a2a-client"],
    },
  ],
  securitySchemes: {},
  security: [],
};

const taskStore = new TaskStore();

// ---------------------------------------------------------------------------
// Startup: discover sub-agents via their agent cards (fetched once, cached)
// ---------------------------------------------------------------------------

let executorCard: AgentCard;
let verifierCard: AgentCard;

async function discoverAgents(): Promise<void> {
  // Sub-agent containers may still be booting; retry discovery a few times.
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      [executorCard, verifierCard] = await Promise.all([
        fetchAgentCard(EXECUTOR_URL),
        fetchAgentCard(VERIFIER_URL),
      ]);
      console.log(
        `[${AGENT_NAME}] discovered agents: ${executorCard.name} @ ${executorCard.url}, ` +
          `${verifierCard.name} @ ${verifierCard.url}`,
      );
      return;
    } catch (err) {
      console.warn(`[${AGENT_NAME}] agent discovery attempt ${attempt}/10 failed: ${err}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Could not discover sub-agents — are executor/verifier running?");
}

// ---------------------------------------------------------------------------
// Orchestration flow
// ---------------------------------------------------------------------------

interface Verdict {
  pass: boolean;
  reason: string;
  confidence: number;
}

interface Attempt {
  attempt: number;
  executorTaskId: string;
  executorState: string;
  output: string;
  verifierTaskId?: string;
  verdict?: Verdict;
}

interface OrchestrationResult {
  answer: string;
  verified: boolean;
  attempts: Attempt[];
  injectionFlagged: boolean;
  injectionMatches: string[];
}

async function delegateAndVerify(contextId: string, taskText: string, attemptNo: number): Promise<Attempt> {
  // ---- Step 1: Executor does the work -------------------------------------
  const executorTask = await sendMessage(AGENT_NAME, executorCard, taskText, { contextId });
  const output = taskOutputText(executorTask);
  const attempt: Attempt = {
    attempt: attemptNo,
    executorTaskId: executorTask.id,
    executorState: executorTask.status.state,
    output,
  };
  if (executorTask.status.state !== "completed") return attempt; // executor failed; no point verifying

  // ---- Step 2: Verifier judges the output ---------------------------------
  const verifierTask = await sendMessage(
    AGENT_NAME,
    verifierCard,
    JSON.stringify({ task: taskText, output }),
    { contextId },
  );
  attempt.verifierTaskId = verifierTask.id;
  if (verifierTask.status.state === "completed") {
    attempt.verdict = JSON.parse(taskOutputText(verifierTask)) as Verdict;
  }
  return attempt;
}

async function orchestrate(localTask: A2ATask, userTask: string): Promise<OrchestrationResult> {
  taskStore.transition(localTask.id, "working");

  // Guardrail #2: scan the raw user task before it goes anywhere near an LLM.
  const scan = scanForInjection(AGENT_NAME, userTask, localTask.id);

  const attempts: Attempt[] = [];

  // Attempt 1: plain delegation.
  const first = await delegateAndVerify(localTask.contextId, userTask, 1);
  attempts.push(first);

  let finalAttempt = first;

  // If the verifier said "fail", retry the executor ONCE with the reason as extra context.
  if (first.verdict && !first.verdict.pass) {
    audit(AGENT_NAME, {
      event: "orchestration",
      from: AGENT_NAME,
      to: executorCard.name,
      taskId: localTask.id,
      detail: { action: "retry-after-failed-verification", reason: summarize(first.verdict.reason) },
    });
    const retryText =
      `${userTask}\n\n` +
      `NOTE: A previous attempt at this task was rejected by a verifier for this reason: ` +
      `"${first.verdict.reason}". Address that issue in your answer.`;
    const second = await delegateAndVerify(localTask.contextId, retryText, 2);
    attempts.push(second);
    finalAttempt = second;
  }

  const verified = finalAttempt.verdict?.pass === true;
  const answer =
    finalAttempt.executorState === "completed"
      ? finalAttempt.output
      : `Task execution failed (executor state: ${finalAttempt.executorState})`;

  return {
    answer,
    verified,
    attempts,
    injectionFlagged: scan.flagged,
    injectionMatches: scan.matches,
  };
}

/** Shared by POST /task and JSON-RPC message/send. */
async function runTask(inbound: A2AMessage): Promise<A2ATask> {
  const userTask = messageText(inbound);
  const localTask = taskStore.create(inbound);

  try {
    const result = await orchestrate(localTask, userTask);
    taskStore.addArtifact(localTask.id, "final-result", JSON.stringify(result, null, 2));
    if (result.answer && (result.verified || result.attempts.at(-1)?.executorState === "completed")) {
      taskStore.transition(localTask.id, "completed");
    } else {
      taskStore.transition(
        localTask.id,
        "failed",
        textMessage("agent", "Sub-agents could not produce a usable result", {
          taskId: localTask.id,
          contextId: localTask.contextId,
        }),
      );
    }
  } catch (err) {
    console.error(`[${AGENT_NAME}] orchestration error:`, err);
    const state = taskStore.get(localTask.id)!.status.state;
    if (state === "submitted" || state === "working") {
      taskStore.transition(
        localTask.id,
        "failed",
        textMessage("agent", "Orchestration failed due to an internal error", {
          taskId: localTask.id,
          contextId: localTask.contextId,
        }),
      );
    }
  }
  return taskStore.get(localTask.id)!;
}

// ---------------------------------------------------------------------------
// HTTP wiring
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard));

// The human-facing entry point.
const userTaskSchema = z.object({
  task: z.string().min(1).max(8_000),
});

app.post(
  "/task",
  rateLimit(AGENT_NAME, 10), // guardrail #8
  validateBody(userTaskSchema, AGENT_NAME), // guardrail #1
  async (req, res) => {
    const { task } = req.body as z.infer<typeof userTaskSchema>;
    const inbound = textMessage("user", task);
    const localTask = await runTask(inbound);

    // Unwrap the aggregated result for a friendly HTTP response.
    const raw = localTask.artifacts?.find((a) => a.name === "final-result")?.parts[0]?.text;
    const result = raw ? JSON.parse(raw) : undefined;
    res.status(localTask.status.state === "completed" ? 200 : 502).json({
      taskId: localTask.id,
      contextId: localTask.contextId,
      state: localTask.status.state,
      ...result,
    });
  },
);

// The agent-facing A2A endpoint (same orchestration, JSON-RPC envelope).
const messageSendParams = z.object({ message: a2aMessageSchema });

app.post(
  "/",
  rateLimit(AGENT_NAME, 10),
  jsonRpcEndpoint(AGENT_NAME, {
    "message/send": async (params) => {
      const parsed = messageSendParams.safeParse(params);
      if (!parsed.success) {
        throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid message/send params");
      }
      return runTask(parsed.data.message as A2AMessage);
    },
    "tasks/get": async (params) => {
      const parsed = tasksGetParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid tasks/get params");
      }
      const task = taskStore.get(parsed.data.id);
      if (!task) {
        throw new JsonRpcHandlerError(JsonRpcErrorCodes.TASK_NOT_FOUND, `Task not found: ${parsed.data.id}`);
      }
      return task;
    },
  }),
);

app.listen(PORT, async () => {
  console.log(`[${AGENT_NAME}] listening on :${PORT} — card at ${PUBLIC_URL}/.well-known/agent-card.json`);
  await discoverAgents();
  console.log(`[${AGENT_NAME}] ready — POST /task to start an orchestration`);
});
