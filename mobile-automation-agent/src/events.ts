/**
 * Run event stream.
 *
 * The orchestrator emits structured events so this package can be embedded in a
 * larger application: a host listens for per-step success/failure/skip (with a
 * screenshot and, on failure, an analysis) and the final report. All payloads
 * are plain JSON-serialisable objects.
 */

import { EventEmitter } from "node:events";
import type {
  DeviceInfo,
  FailureAnalysis,
  FlowReport,
  StepStatus,
  ToolCallRecord,
} from "./types.js";

export interface RunStartEvent {
  runId: string;
  flow: string;
  device: DeviceInfo;
  totalSteps: number;
  startedAt: string;
  vars?: Record<string, string>;
}

export interface StepStartEvent {
  runId: string;
  stepId: string;
  index: number;
  total: number;
  text: string;
}

/** Emitted for each tool/action the agent performs (fine-grained telemetry). */
export interface ActionEvent {
  runId: string;
  stepId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  /** For element-locating actions: whether the target was found. */
  located?: boolean;
  /** For input actions: whether the value was verified. */
  verified?: boolean;
}

export interface StepEndEvent {
  runId: string;
  stepId: string;
  index: number;
  total: number;
  text: string;
  status: StepStatus;
  summary: string;
  iterations: number;
  durationMs: number;
  cached: boolean;
  toolCalls: ToolCallRecord[];
  /** Base64 PNG of the screen at step end, when capture is enabled. */
  screenshot?: string;
  /** Present when status is "failure". */
  analysis?: FailureAnalysis;
}

export interface RunCompleteEvent {
  runId: string;
  report: FlowReport;
}

export interface RunErrorEvent {
  runId: string;
  error: string;
}

/** Map of event name -> payload type. */
export interface RunEventMap {
  "run:start": RunStartEvent;
  "step:start": StepStartEvent;
  action: ActionEvent;
  "step:end": StepEndEvent;
  "run:complete": RunCompleteEvent;
  "run:error": RunErrorEvent;
}

/**
 * Typed EventEmitter for run events. Use `onEvent`/`emitEvent` for type safety;
 * the standard EventEmitter methods still work for advanced use.
 */
export class RunEmitter extends EventEmitter {
  emitEvent<K extends keyof RunEventMap>(event: K, payload: RunEventMap[K]): boolean {
    return this.emit(event, payload);
  }

  onEvent<K extends keyof RunEventMap>(
    event: K,
    listener: (payload: RunEventMap[K]) => void,
  ): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }

  onceEvent<K extends keyof RunEventMap>(
    event: K,
    listener: (payload: RunEventMap[K]) => void,
  ): this {
    return this.once(event, listener as (...args: unknown[]) => void);
  }
}
