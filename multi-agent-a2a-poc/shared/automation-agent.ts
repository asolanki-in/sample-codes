/**
 * Factory for a LONG-RUNNING automation agent (mobile / browser).
 *
 * These agents mock device/browser automation: a task is N sequential "UI
 * steps", each taking STEP_MS. The A2A behavior is what matters:
 *
 *  - message/send returns IMMEDIATELY with the task in "working" state; the
 *    steps run in the background. Callers poll with tasks/get.
 *  - Coarse progress lives in task.metadata.progress: phase ("started",
 *    "in-progress", "waiting-for-input", ...) + stepsCompleted/totalSteps.
 *    Only milestones — not a transcript.
 *  - At a configured step the agent needs the user (OTP, 2FA approval...):
 *    it transitions to "input-required" and STOPS. A message/send carrying
 *    the same taskId delivers the input and resumes the run (A2A continuation).
 *  - Every step is persisted (file-backed TaskStore). If the agent process
 *    restarts, unfinished tasks resume from their last completed step, and
 *    tasks waiting for input keep waiting. The caller never loses progress.
 */
import express from "express";
import { z } from "zod";
import { audit } from "./audit.js";
import { a2aMessageSchema, rateLimit, scanForInjection, tasksGetParamsSchema } from "./guardrails.js";
import { jsonRpcEndpoint, JsonRpcHandlerError } from "./jsonrpc-server.js";
import { TaskStore, dataFile } from "./task-store.js";
import {
  JsonRpcErrorCodes,
  messageText,
  textMessage,
  type A2AMessage,
  type A2ATask,
  type AgentCard,
  type TaskProgress,
} from "./types.js";

export interface AutomationAgentConfig {
  name: string; // e.g. "mobile-agent"
  description: string;
  port: number;
  publicUrl: string;
  skill: { id: string; name: string; description: string; tags: string[] };
  /** How many mock UI steps a task takes. */
  totalSteps: number;
  /** Step at which the run pauses for user input (0 = never). */
  inputRequiredAtStep: number;
  /** What we ask the user for (shown in the input-required status message). */
  inputPrompt: string;
  /** Human description of step n, e.g. "Tapping 'Add to cart'". */
  stepNote: (step: number, total: number) => string;
  /** Final artifact text once all steps are done. */
  resultText: (taskText: string, userInputs: string[]) => string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startAutomationAgent(cfg: AutomationAgentConfig): void {
  // STEP_MS is env-tunable so the smoke test can run fast (real default: 1s/step).
  const STEP_MS = Number(process.env.STEP_MS ?? 1000);

  const store = new TaskStore(dataFile(cfg.name));
  const running = new Set<string>(); // taskIds with an active step-runner in THIS process

  const agentCard: AgentCard = {
    protocolVersion: "1.0",
    name: cfg.name,
    description: cfg.description,
    url: cfg.publicUrl,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [cfg.skill],
    securitySchemes: {},
    security: [],
  };

  // -------------------------------------------------------------------------
  // Progress helpers
  // -------------------------------------------------------------------------

  function setProgress(taskId: string, patch: Partial<TaskProgress>): void {
    store.update(taskId, (t) => {
      const prev = (t.metadata?.progress ?? {
        phase: "started",
        stepsCompleted: 0,
        totalSteps: cfg.totalSteps,
        note: "Task accepted",
      }) as TaskProgress;
      t.metadata = {
        ...t.metadata,
        progress: { ...prev, ...patch, updatedAt: new Date().toISOString() },
      };
    });
  }

  function progressOf(task: A2ATask): TaskProgress {
    return (task.metadata?.progress ?? {
      phase: "started",
      stepsCompleted: 0,
      totalSteps: cfg.totalSteps,
      note: "Task accepted",
      updatedAt: new Date().toISOString(),
    }) as TaskProgress;
  }

  function userInputsOf(task: A2ATask): string[] {
    return (task.metadata?.userInputs ?? []) as string[];
  }

  // -------------------------------------------------------------------------
  // The background step-runner (the "automation")
  // -------------------------------------------------------------------------

  async function runSteps(taskId: string): Promise<void> {
    if (running.has(taskId)) return; // never double-run the same task
    running.add(taskId);
    try {
      while (true) {
        const task = store.get(taskId);
        if (!task || task.status.state !== "working") return; // paused (input-required) or gone

        const step = progressOf(task).stepsCompleted;

        if (step >= cfg.totalSteps) break; // all steps done

        // Pause point: need the user before we can continue?
        if (cfg.inputRequiredAtStep > 0 && step === cfg.inputRequiredAtStep && userInputsOf(task).length === 0) {
          setProgress(taskId, { phase: "waiting-for-input", note: cfg.inputPrompt });
          store.transition(
            taskId,
            "input-required",
            textMessage("agent", cfg.inputPrompt, { taskId, contextId: task.contextId }),
          );
          audit(cfg.name, {
            event: "automation",
            from: cfg.name,
            to: cfg.name,
            taskId,
            detail: { milestone: "input-required", afterStep: step, prompt: cfg.inputPrompt },
          });
          return; // runner stops; a continuation message/send resumes it
        }

        await sleep(STEP_MS); // one mock UI action
        const done = step + 1;
        setProgress(taskId, {
          phase: "in-progress",
          stepsCompleted: done,
          note: cfg.stepNote(done, cfg.totalSteps),
        });
      }

      // Completed: attach the result artifact and finish.
      const task = store.get(taskId)!;
      store.addArtifact(taskId, "result", cfg.resultText(messageText(task.history![0]), userInputsOf(task)));
      setProgress(taskId, { phase: "completed", note: `All ${cfg.totalSteps} steps completed` });
      store.transition(taskId, "completed");
      audit(cfg.name, {
        event: "automation",
        from: cfg.name,
        to: cfg.name,
        taskId,
        detail: { milestone: "completed", totalSteps: cfg.totalSteps },
      });
    } catch (err) {
      console.error(`[${cfg.name}] step-runner error for task ${taskId}:`, err);
      const state = store.get(taskId)?.status.state;
      if (state === "working" || state === "input-required") {
        setProgress(taskId, { phase: "failed", note: "Automation aborted by an internal error" });
        store.transition(taskId, "failed");
      }
    } finally {
      running.delete(taskId);
    }
  }

  // -------------------------------------------------------------------------
  // A2A handlers
  // -------------------------------------------------------------------------

  const messageSendParams = z.object({ message: a2aMessageSchema });

  async function handleMessageSend(params: unknown): Promise<A2ATask> {
    const parsed = messageSendParams.safeParse(params);
    if (!parsed.success) {
      throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid message/send params");
    }
    const message = parsed.data.message as A2AMessage;
    const text = messageText(message);
    scanForInjection(cfg.name, text, message.taskId); // guardrail #2: flag, don't strip

    // ---- CONTINUATION: message carries a taskId -> this is user input ------
    if (message.taskId) {
      const task = store.get(message.taskId);
      if (!task) {
        throw new JsonRpcHandlerError(JsonRpcErrorCodes.TASK_NOT_FOUND, `Task not found: ${message.taskId}`);
      }
      if (task.status.state !== "input-required") {
        throw new JsonRpcHandlerError(
          JsonRpcErrorCodes.UNSUPPORTED_OPERATION,
          `Task ${task.id} is not waiting for input (state: ${task.status.state})`,
        );
      }
      store.update(task.id, (t) => {
        t.metadata = { ...t.metadata, userInputs: [...userInputsOf(t), text] };
        t.history = [...(t.history ?? []), message];
      });
      store.transition(task.id, "working");
      setProgress(task.id, { phase: "in-progress", note: "Input received — resuming automation" });
      audit(cfg.name, {
        event: "automation",
        from: cfg.name,
        to: cfg.name,
        taskId: task.id,
        detail: { milestone: "input-received" },
      });
      void runSteps(task.id); // resume in the background
      return store.get(task.id)!;
    }

    // ---- NEW TASK: start the run and return immediately ---------------------
    const task = store.create(message);
    store.transition(task.id, "working");
    setProgress(task.id, { phase: "started", stepsCompleted: 0, note: "Task accepted, automation starting" });
    audit(cfg.name, {
      event: "automation",
      from: cfg.name,
      to: cfg.name,
      taskId: task.id,
      detail: { milestone: "started", totalSteps: cfg.totalSteps },
    });
    void runSteps(task.id); // fire-and-forget; caller polls tasks/get
    return store.get(task.id)!;
  }

  async function handleTasksGet(params: unknown): Promise<A2ATask> {
    const parsed = tasksGetParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new JsonRpcHandlerError(JsonRpcErrorCodes.INVALID_PARAMS, "Invalid tasks/get params");
    }
    const task = store.get(parsed.data.id);
    if (!task) {
      throw new JsonRpcHandlerError(JsonRpcErrorCodes.TASK_NOT_FOUND, `Task not found: ${parsed.data.id}`);
    }
    return task;
  }

  // -------------------------------------------------------------------------
  // Boot: HTTP wiring + crash recovery
  // -------------------------------------------------------------------------

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard));

  // Long-running tasks get POLLED, so the bucket is much bigger than the
  // executor/verifier's 10/min — the guardrail still exists, sized for polling.
  app.post(
    "/",
    rateLimit(cfg.name, 300),
    jsonRpcEndpoint(cfg.name, {
      "message/send": handleMessageSend,
      "tasks/get": handleTasksGet,
    }),
  );

  app.listen(cfg.port, () => {
    console.log(`[${cfg.name}] listening on :${cfg.port} — card at ${cfg.publicUrl}/.well-known/agent-card.json`);

    // CRASH RECOVERY: tasks persisted as "working" were mid-run when the
    // process died — resume them from their last completed step. Tasks in
    // "input-required" just keep waiting for their continuation message.
    for (const task of store.all()) {
      if (task.status.state === "working") {
        console.log(`[${cfg.name}] resuming task ${task.id} from step ${progressOf(task).stepsCompleted}`);
        void runSteps(task.id);
      }
    }
  });
}
