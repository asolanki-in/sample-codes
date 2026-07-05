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
import { A2ARemoteError, fetchAgentCard, getTask, sendMessage } from "../../shared/a2a-client.js";
import { audit, summarize } from "../../shared/audit.js";
import {
  a2aMessageSchema,
  rateLimit,
  scanForInjection,
  tasksGetParamsSchema,
  validateBody,
} from "../../shared/guardrails.js";
import { jsonRpcEndpoint, JsonRpcHandlerError } from "../../shared/jsonrpc-server.js";
import { chat, type ChatMessage } from "../../shared/llm.js";
import { TaskStore, dataFile } from "../../shared/task-store.js";
import {
  JsonRpcErrorCodes,
  messageText,
  taskOutputText,
  textMessage,
  type A2AMessage,
  type A2ATask,
  type AgentCard,
  type TaskProgress,
} from "../../shared/types.js";

const AGENT_NAME = "main-agent";
const PORT = Number(process.env.MAIN_PORT ?? 4000);
const PUBLIC_URL = process.env.MAIN_URL ?? `http://localhost:${PORT}`;
const EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://localhost:4001";
const VERIFIER_URL = process.env.VERIFIER_URL ?? "http://localhost:4002";
const MOBILE_URL = process.env.MOBILE_URL ?? "http://localhost:4003";
const BROWSER_URL = process.env.BROWSER_URL ?? "http://localhost:4004";

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

// File-backed store: the orchestrator's tasks (including which remote agent
// owns a long-running automation and its remote taskId) survive a restart —
// close the main agent, come back later, progress is still there.
const taskStore = new TaskStore(dataFile(AGENT_NAME));

// ---------------------------------------------------------------------------
// Startup: discover sub-agents via their agent cards (fetched once, cached)
// ---------------------------------------------------------------------------

let executorCard: AgentCard;
let verifierCard: AgentCard;

/** Long-running automation agents, keyed by the name callers use in POST /automation. */
const automationCards: Record<string, AgentCard | undefined> = {};
const AUTOMATION_AGENT_URLS: Record<string, string> = {
  mobile: MOBILE_URL,
  browser: BROWSER_URL,
};

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

/** Automation agents are optional: discover what's up, warn about the rest. */
async function discoverAutomationAgents(): Promise<void> {
  for (const [key, url] of Object.entries(AUTOMATION_AGENT_URLS)) {
    try {
      automationCards[key] = await fetchAgentCard(url);
      console.log(`[${AGENT_NAME}] discovered automation agent '${key}': ${automationCards[key]!.name} @ ${automationCards[key]!.url}`);
    } catch {
      console.warn(`[${AGENT_NAME}] automation agent '${key}' not reachable at ${url} — POST /automation for it will 503`);
    }
  }
}

// ---------------------------------------------------------------------------
// Guardrail #9: task-scope gate
//
// The orchestrator must ONLY take on work its sub-agents can actually do.
// Anything else ("write me a poem", "book a flight", "give legal advice") is
// REJECTED up front with an "I can only do X" message — the task never
// reaches the executor.
//
// This is code, not prompt text: the capability list is derived from the
// *cached agent cards* (so it tracks what the sub-agents actually advertise),
// the classifier's output is Zod-validated, and the gate FAILS CLOSED — if
// the classifier errors or returns garbage twice, the task is rejected.
// ---------------------------------------------------------------------------

const scopeVerdictSchema = z.object({
  in_scope: z.boolean(),
  reason: z.string().min(1).max(500),
});

const scopeVerdictJsonSchema = {
  type: "object",
  properties: {
    in_scope: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["in_scope", "reason"],
};

/** Human-readable capability list, built from the sub-agents' cached cards. */
function capabilitySummary(): string {
  return [executorCard, verifierCard]
    .map(
      (card) =>
        `- ${card.name}: ${card.skills.map((s) => `${s.name} (${s.description})`).join("; ")}`,
    )
    .join("\n");
}

/** The refusal text returned to the caller when a task is out of scope. */
function refusalMessage(reason: string): string {
  return (
    `I can only handle tasks my sub-agents support: gathering system/file/web information ` +
    `via the executor's tools (run_shell_command, read_file, web_lookup) and verifying its output. ` +
    `This request is outside that scope: ${reason}`
  );
}

async function checkTaskScope(
  taskId: string,
  userTask: string,
): Promise<{ inScope: boolean; reason: string }> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a strict scope gate for an orchestrator agent. The orchestrator can ONLY accomplish " +
        "a task by delegating to these downstream agent skills:\n" +
        capabilitySummary() +
        "\nDecide whether the task below can be fully accomplished using ONLY those skills. " +
        "Tasks needing creativity, opinions, purchases, real-world actions, or any capability not listed are out of scope. " +
        'Respond ONLY with JSON: {"in_scope": boolean, "reason": string}.',
    },
    { role: "user", content: `TASK:\n${userTask}` },
  ];

  // Same enforcement pattern as the verifier: Zod-validate, one correction retry.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await chat(AGENT_NAME, { messages, format: scopeVerdictJsonSchema });
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.message.content);
      } catch {
        parsed = undefined;
      }
      const verdict = scopeVerdictSchema.safeParse(parsed);
      if (verdict.success) {
        if (!verdict.data.in_scope) {
          audit(AGENT_NAME, {
            event: "guardrail",
            from: AGENT_NAME,
            to: AGENT_NAME,
            taskId,
            inputSummary: summarize(userTask),
            detail: { guardrail: "task-scope", inScope: false, reason: summarize(verdict.data.reason) },
          });
        }
        return { inScope: verdict.data.in_scope, reason: verdict.data.reason };
      }
      messages.push(result.message);
      messages.push({
        role: "user",
        content:
          'Your previous response was not valid JSON matching {"in_scope": boolean, "reason": string}. ' +
          "Respond again with ONLY that JSON object.",
      });
    } catch (err) {
      console.error(`[${AGENT_NAME}] scope classifier attempt ${attempt} failed:`, err);
    }
  }

  // Fail CLOSED: if we can't establish the task is in scope, we refuse it.
  audit(AGENT_NAME, {
    event: "guardrail",
    from: AGENT_NAME,
    to: AGENT_NAME,
    taskId,
    inputSummary: summarize(userTask),
    detail: { guardrail: "task-scope", inScope: false, reason: "scope classifier unavailable — failing closed" },
  });
  return { inScope: false, reason: "the scope check could not be completed, so the task is refused by default" };
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
  /** True when the scope gate refused the task before any delegation. */
  rejected?: boolean;
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

async function orchestrate(
  localTask: A2ATask,
  userTask: string,
  scan: { flagged: boolean; matches: string[] },
): Promise<OrchestrationResult> {
  taskStore.transition(localTask.id, "working");

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

  // Guardrail #2: scan the raw user task before it goes anywhere near an LLM.
  const scan = scanForInjection(AGENT_NAME, userTask, localTask.id);

  // Guardrail #9: scope gate — refuse anything the sub-agents can't do.
  // This runs BEFORE orchestration, so an out-of-scope task never reaches
  // the executor. The task goes submitted -> rejected, and the caller gets
  // an explicit "I can only do X" answer instead of a best-effort attempt.
  const scope = await checkTaskScope(localTask.id, userTask);
  if (!scope.inScope) {
    const result: OrchestrationResult = {
      answer: refusalMessage(scope.reason),
      verified: false,
      rejected: true,
      attempts: [],
      injectionFlagged: scan.flagged,
      injectionMatches: scan.matches,
    };
    taskStore.addArtifact(localTask.id, "final-result", JSON.stringify(result, null, 2));
    taskStore.transition(
      localTask.id,
      "rejected",
      textMessage("agent", result.answer, { taskId: localTask.id, contextId: localTask.contextId }),
    );
    return taskStore.get(localTask.id)!;
  }

  try {
    const result = await orchestrate(localTask, userTask, scan);
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

// Readiness probe: 200 once both sub-agent cards are discovered and cached.
app.get("/healthz", (_req, res) => {
  const ready = Boolean(executorCard && verifierCard);
  res.status(ready ? 200 : 503).json({ ready });
});

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
    const httpStatus =
      localTask.status.state === "completed" ? 200
      : localTask.status.state === "rejected" ? 422 // scope gate said no
      : 502;
    res.status(httpStatus).json({
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

// ---------------------------------------------------------------------------
// Long-running automation flow (mobile / browser agents)
//
//   POST /automation            {agent, task}  -> returns taskId immediately
//   GET  /automation/:id                       -> coarse progress (poll this)
//   POST /automation/:id/input  {input}        -> answer an input-required pause
//
// The sub-agent does the actual long-running work in its own process; the
// orchestrator only persists a pointer {agent, remoteTaskId} and mirrors the
// remote task's state on each poll. Because both sides persist to disk, the
// user can close the main agent, come back later, and continue polling.
// ---------------------------------------------------------------------------

interface AutomationRef {
  agent: string;
  remoteTaskId: string;
}

/** Mirror the remote task's state machine onto our local task. */
function syncLocalWithRemote(localId: string, remote: A2ATask): void {
  const local = taskStore.get(localId)!;
  taskStore.update(localId, (t) => {
    t.metadata = { ...t.metadata, progress: remote.metadata?.progress };
  });

  const localState = local.status.state;
  const remoteState = remote.status.state;
  if (localState === remoteState) return;

  if (remoteState === "input-required" && localState === "working") {
    taskStore.transition(localId, "input-required", remote.status.message);
  } else if (remoteState === "working" && localState === "input-required") {
    taskStore.transition(localId, "working");
  } else if (remoteState === "completed" || remoteState === "failed") {
    if (localState === "input-required") taskStore.transition(localId, "working");
    if (remoteState === "completed") taskStore.addArtifact(localId, "result", taskOutputText(remote));
    taskStore.transition(localId, remoteState, remote.status.message);
  }
}

/** Shape both polling and mutation endpoints return to the user. */
function automationView(localId: string): Record<string, unknown> {
  const local = taskStore.get(localId)!;
  const ref = local.metadata?.automation as AutomationRef;
  const progress = local.metadata?.progress as TaskProgress | undefined;
  return {
    taskId: local.id,
    agent: ref.agent,
    remoteTaskId: ref.remoteTaskId,
    state: local.status.state,
    progress,
    // When paused, tell the user exactly what the agent is waiting for.
    inputPrompt: local.status.state === "input-required" ? messageText(local.status.message!) : undefined,
    result: local.artifacts?.find((a) => a.name === "result")?.parts[0]?.text,
  };
}

const automationStartSchema = z.object({
  agent: z.enum(["mobile", "browser"]),
  task: z.string().min(1).max(8_000),
});

app.post(
  "/automation",
  rateLimit(AGENT_NAME, 60),
  validateBody(automationStartSchema, AGENT_NAME), // guardrail #1
  async (req, res) => {
    const { agent, task } = req.body as z.infer<typeof automationStartSchema>;

    // Deterministic scope check: the caller names the agent explicitly, so the
    // only question is whether that agent exists and is up — no LLM needed.
    const card = automationCards[agent];
    if (!card) {
      res.status(503).json({ error: `Automation agent '${agent}' is not available` });
      return;
    }

    const inbound = textMessage("user", task);
    const local = taskStore.create(inbound);
    scanForInjection(AGENT_NAME, task, local.id); // guardrail #2

    try {
      // Returns IMMEDIATELY: the remote task is "working", steps run remotely.
      const remote = await sendMessage(AGENT_NAME, card, task, { contextId: local.contextId });
      taskStore.transition(local.id, "working");
      taskStore.update(local.id, (t) => {
        t.metadata = {
          ...t.metadata,
          automation: { agent, remoteTaskId: remote.id } satisfies AutomationRef,
          progress: remote.metadata?.progress,
        };
      });
      res.status(202).json(automationView(local.id));
    } catch (err) {
      console.error(`[${AGENT_NAME}] failed to start automation:`, err);
      taskStore.transition(local.id, "failed",
        textMessage("agent", "Could not start the automation task", { taskId: local.id }));
      res.status(502).json({ taskId: local.id, state: "failed", error: "Could not start the automation task" });
    }
  },
);

app.get("/automation/:id", rateLimit(AGENT_NAME, 300), async (req, res) => {
  const local = taskStore.get(req.params.id);
  if (!local) {
    res.status(404).json({ error: `Unknown automation task: ${req.params.id}` });
    return;
  }
  const ref = local.metadata?.automation as AutomationRef | undefined;
  if (!ref) {
    res.status(400).json({ error: "Task is not an automation task" });
    return;
  }

  // Terminal locally -> serve the persisted snapshot, no remote call needed.
  if (local.status.state === "completed" || local.status.state === "failed") {
    res.json(automationView(local.id));
    return;
  }

  const card = automationCards[ref.agent];
  if (!card) {
    // Agent temporarily unreachable: still show the LAST KNOWN persisted progress.
    res.status(200).json({ ...automationView(local.id), warning: `Agent '${ref.agent}' unreachable; showing last known state` });
    return;
  }

  try {
    const remote = await getTask(AGENT_NAME, card, ref.remoteTaskId);
    syncLocalWithRemote(local.id, remote);
    res.json(automationView(local.id));
  } catch (err) {
    console.error(`[${AGENT_NAME}] poll failed for ${local.id}:`, err);
    res.status(200).json({ ...automationView(local.id), warning: "Poll failed; showing last known state" });
  }
});

const automationInputSchema = z.object({ input: z.string().min(1).max(2_000) });

app.post(
  "/automation/:id/input",
  rateLimit(AGENT_NAME, 60),
  validateBody(automationInputSchema, AGENT_NAME),
  async (req, res) => {
    const local = taskStore.get(req.params.id);
    const ref = local?.metadata?.automation as AutomationRef | undefined;
    if (!local || !ref) {
      res.status(404).json({ error: `Unknown automation task: ${req.params.id}` });
      return;
    }
    const card = automationCards[ref.agent];
    if (!card) {
      res.status(503).json({ error: `Automation agent '${ref.agent}' is not available` });
      return;
    }

    const { input } = req.body as z.infer<typeof automationInputSchema>;
    scanForInjection(AGENT_NAME, input, local.id); // user input is untrusted too

    try {
      // A2A continuation: same taskId -> the remote task resumes from its pause.
      const remote = await sendMessage(AGENT_NAME, card, input, {
        contextId: local.contextId,
        taskId: ref.remoteTaskId,
      });
      syncLocalWithRemote(local.id, remote);
      res.json(automationView(local.id));
    } catch (err) {
      if (err instanceof A2ARemoteError) {
        // e.g. task is not waiting for input (double-submit) -> clean 409
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      console.error(`[${AGENT_NAME}] input forwarding failed:`, err);
      res.status(502).json({ error: "Could not deliver input to the automation agent" });
    }
  },
);

app.listen(PORT, async () => {
  console.log(`[${AGENT_NAME}] listening on :${PORT} — card at ${PUBLIC_URL}/.well-known/agent-card.json`);
  await discoverAgents();
  await discoverAutomationAgents();
  console.log(`[${AGENT_NAME}] ready — POST /task (orchestration) or POST /automation (long-running)`);
});
