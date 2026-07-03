/**
 * In-memory task store — one per agent process.
 *
 * Implements the A2A task state machine:
 *   submitted -> working -> completed | failed | input-required
 *
 * Illegal transitions throw, so a bug can't quietly move a task backwards.
 */
import { v4 as uuidv4 } from "uuid";
import type { A2AMessage, A2ATask, Artifact, TaskState } from "./types.js";

const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  submitted: ["working", "failed"],
  working: ["completed", "failed", "input-required"],
  completed: [],
  failed: [],
  "input-required": [], // terminal for this PoC (no multi-turn continuation)
};

export class TaskStore {
  private readonly tasks = new Map<string, A2ATask>();

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
    return task;
  }

  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  transition(id: string, state: TaskState, statusMessage?: A2AMessage): A2ATask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (!LEGAL_TRANSITIONS[task.status.state].includes(state)) {
      throw new Error(`Illegal task transition ${task.status.state} -> ${state} (task ${id})`);
    }
    task.status = { state, message: statusMessage, timestamp: new Date().toISOString() };
    return task;
  }

  addArtifact(id: string, name: string, text: string): Artifact {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const artifact: Artifact = { artifactId: uuidv4(), name, parts: [{ kind: "text", text }] };
    task.artifacts = [...(task.artifacts ?? []), artifact];
    return artifact;
  }
}
