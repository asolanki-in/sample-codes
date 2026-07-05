/**
 * Task store — one per agent process.
 *
 * Implements the A2A task state machine:
 *   submitted -> working -> completed | failed | input-required
 *   input-required -> working              (user provided the requested input)
 *   submitted -> rejected                  (scope gate refused the task)
 *
 * Illegal transitions throw, so a bug can't quietly move a task backwards.
 *
 * PERSISTENCE: pass a file path to the constructor and every mutation is
 * flushed to disk (write-to-tmp + atomic rename), and existing tasks are
 * loaded on boot. That's what lets a user close the main agent, come back
 * later, and still see progress — and lets an automation agent resume a
 * long-running task from its last completed step after a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { A2AMessage, A2ATask, Artifact, TaskState } from "./types.js";

const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  submitted: ["working", "failed", "rejected"],
  working: ["completed", "failed", "input-required"],
  "input-required": ["working", "failed"], // resumes when the user replies with input
  completed: [],
  failed: [],
  rejected: [], // refused by the scope gate — no work was ever started
};

/** Conventional location for an agent's persisted tasks: $DATA_DIR/<agent>.tasks.json */
export function dataFile(agentName: string): string {
  return path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), `${agentName}.tasks.json`);
}

export class TaskStore {
  private readonly tasks = new Map<string, A2ATask>();

  constructor(private readonly persistPath?: string) {
    if (persistPath && fs.existsSync(persistPath)) {
      try {
        const stored = JSON.parse(fs.readFileSync(persistPath, "utf8")) as A2ATask[];
        for (const task of stored) this.tasks.set(task.id, task);
        console.log(`[task-store] loaded ${stored.length} task(s) from ${persistPath}`);
      } catch (err) {
        console.error(`[task-store] could not load ${persistPath}, starting empty:`, err);
      }
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.tasks.values()], null, 2));
      fs.renameSync(tmp, this.persistPath); // atomic: readers never see a half-written file
    } catch (err) {
      console.error(`[task-store] persist failed:`, err);
    }
  }

  /** Create a task in "submitted" state from the inbound message. */
  create(message: A2AMessage, contextId?: string): A2ATask {
    const task: A2ATask = {
      kind: "task",
      id: uuidv4(),
      contextId: contextId ?? message.contextId ?? uuidv4(),
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: [message],
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  all(): A2ATask[] {
    return [...this.tasks.values()];
  }

  transition(id: string, state: TaskState, statusMessage?: A2AMessage): A2ATask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (!LEGAL_TRANSITIONS[task.status.state].includes(state)) {
      throw new Error(`Illegal task transition ${task.status.state} -> ${state} (task ${id})`);
    }
    task.status = { state, message: statusMessage, timestamp: new Date().toISOString() };
    this.persist();
    return task;
  }

  /** Apply an arbitrary mutation (progress updates, metadata) and persist it. */
  update(id: string, mutate: (task: A2ATask) => void): A2ATask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    mutate(task);
    this.persist();
    return task;
  }

  addArtifact(id: string, name: string, text: string): Artifact {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const artifact: Artifact = { artifactId: uuidv4(), name, parts: [{ kind: "text", text }] };
    task.artifacts = [...(task.artifacts ?? []), artifact];
    this.persist();
    return artifact;
  }
}
