/**
 * SUB-AGENT A — Executor (port 4001)
 *
 * Owns the tools and runs a hand-rolled ReAct loop:
 *   call LLM with tools -> model emits tool_calls -> validate against
 *   allowlist -> execute -> feed results back -> repeat until the model
 *   answers in plain text, or a guardrail (max 5 iterations / 20k tokens) fires.
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
import { TaskStore, dataFile } from "../../shared/task-store.js";
import {
  JsonRpcErrorCodes,
  messageText,
  textMessage,
  type A2AMessage,
  type A2ATask,
  type AgentCard,
} from "../../shared/types.js";
import { toolDefinitions, toolRegistry, TOOL_ALLOWLIST } from "./tools.js";

const AGENT_NAME = "executor-agent";
const PORT = Number(process.env.EXECUTOR_PORT ?? 4001);
const PUBLIC_URL = process.env.EXECUTOR_URL ?? `http://localhost:${PORT}`;

// Guardrail #4: hard caps on the ReAct loop.
const MAX_ITERATIONS = 5;
const MAX_TOKENS_PER_TASK = 20_000;

const SYSTEM_PROMPT = [
  "You are an execution agent. Solve the user's task using the provided tools.",
  "Call tools when you need information; when you have enough, reply with a final plain-text answer.",
  "Be concise and factual. Base your answer only on tool results and the task text.",
].join(" ");

const agentCard: AgentCard = {
  protocolVersion: "1.0",
  name: AGENT_NAME,
  description:
    "Executor sub-agent. Performs tasks using a small registry of tools (run_shell_command, read_file, web_lookup) via an internal ReAct loop.",
  url: PUBLIC_URL,
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "execute-task",
      name: "Execute task with tools",
      description:
        "Runs a natural-language task using shell/file/web tools (mocked) and returns a text result.",
      tags: ["execution", "react", "tools"],
    },
  ],
  securitySchemes: {},
  security: [], // no auth on the PoC's trusted docker network
};

const taskStore = new TaskStore(dataFile(AGENT_NAME));

// ---------------------------------------------------------------------------
// The ReAct loop
// ---------------------------------------------------------------------------

async function runReActLoop(task: A2ATask, taskText: string): Promise<void> {
  taskStore.transition(task.id, "working");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: taskText },
  ];
  let totalTokens = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const result = await chat(AGENT_NAME, { messages, tools: toolDefinitions });
    totalTokens += result.promptTokens + result.completionTokens;

    // Guardrail #4b: total token budget per task.
    if (totalTokens > MAX_TOKENS_PER_TASK) {
      audit(AGENT_NAME, {
        event: "guardrail",
        from: AGENT_NAME,
        to: AGENT_NAME,
        taskId: task.id,
        detail: { guardrail: "max-tokens", totalTokens, limit: MAX_TOKENS_PER_TASK },
      });
      taskStore.transition(
        task.id,
        "failed",
        textMessage("agent", `Aborted: token budget exceeded (${totalTokens} > ${MAX_TOKENS_PER_TASK})`, {
          taskId: task.id,
          contextId: task.contextId,
        }),
      );
      return;
    }

    const assistantMsg = result.message;
    messages.push(assistantMsg);

    // No tool calls -> the model is done; its content is the final answer.
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      taskStore.addArtifact(task.id, "result", assistantMsg.content.trim());
      taskStore.transition(task.id, "completed");
      return;
    }

    // Execute each requested tool call — allowlist first, args validation second.
    for (const call of assistantMsg.tool_calls) {
      const name = call.function.name;
      let output: string;

      if (!TOOL_ALLOWLIST.has(name)) {
        // Guardrail #3: never execute a tool the registry doesn't declare.
        audit(AGENT_NAME, {
          event: "guardrail",
          from: AGENT_NAME,
          to: AGENT_NAME,
          taskId: task.id,
          detail: { guardrail: "tool-allowlist", rejectedTool: name },
        });
        output = `Error: tool '${name}' is not in the allowlist. Available tools: ${[...TOOL_ALLOWLIST].join(", ")}`;
      } else {
        const tool = toolRegistry[name];
        const args = tool.argsSchema.safeParse(call.function.arguments ?? {});
        if (!args.success) {
          output = `Error: invalid arguments for '${name}': ${args.error.issues.map((i) => i.message).join("; ")}`;
        } else {
          output = tool.execute(args.data as Record<string, unknown>);
        }
        audit(AGENT_NAME, {
          event: "tool-call",
          from: AGENT_NAME,
          to: name,
          taskId: task.id,
          inputSummary: summarize(JSON.stringify(call.function.arguments ?? {})),
          outputSummary: summarize(output),
          detail: { iteration },
        });
      }

      // Feed the tool result back to the model.
      messages.push({ role: "tool", tool_name: name, content: output });
    }
  }

  // Guardrail #4a: iteration cap reached without a final answer.
  audit(AGENT_NAME, {
    event: "guardrail",
    from: AGENT_NAME,
    to: AGENT_NAME,
    taskId: task.id,
    detail: { guardrail: "max-iterations", limit: MAX_ITERATIONS },
  });
  taskStore.transition(
    task.id,
    "failed",
    textMessage("agent", `Aborted: exceeded ${MAX_ITERATIONS} ReAct iterations without a final answer`, {
      taskId: task.id,
      contextId: task.contextId,
    }),
  );
}

// ---------------------------------------------------------------------------
// A2A server wiring
// ---------------------------------------------------------------------------

const messageSendParams = z.object({ message: a2aMessageSchema });

async function handleMessageSend(params: unknown): Promise<A2ATask> {
  const parsed = messageSendParams.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid message/send params");
  }
  const message = parsed.data.message as A2AMessage;
  const taskText = messageText(message);

  const task = taskStore.create(message);

  // Guardrail #2: scan inbound text before it reaches the LLM. Flag, don't strip.
  const scan = scanForInjection(AGENT_NAME, taskText, task.id);
  if (scan.flagged) {
    console.warn(`[${AGENT_NAME}] prompt-injection patterns in task ${task.id}: ${scan.matches.join(", ")}`);
  }

  try {
    await runReActLoop(task, taskText);
  } catch (err) {
    console.error(`[${AGENT_NAME}] ReAct loop error:`, err);
    // Only transition if the loop died before reaching a terminal state.
    const state = taskStore.get(task.id)!.status.state;
    if (state === "submitted" || state === "working") {
      taskStore.transition(
        task.id,
        "failed",
        textMessage("agent", "Execution failed due to an internal error", {
          taskId: task.id,
          contextId: task.contextId,
        }),
      );
    }
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
  rateLimit(AGENT_NAME, 10), // guardrail #8: 10 req/min token bucket
  jsonRpcEndpoint(AGENT_NAME, {
    "message/send": handleMessageSend,
    "tasks/get": handleTasksGet,
  }),
);

app.listen(PORT, () => {
  console.log(`[${AGENT_NAME}] listening on :${PORT} — card at ${PUBLIC_URL}/.well-known/agent-card.json`);
});
