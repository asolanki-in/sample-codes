/**
 * The agent loop.
 *
 * For each natural-language step the agent runs a bounded OBSERVE -> PLAN ->
 * ACT -> VERIFY -> FINISH cycle, calling tools through a provider-neutral LLM
 * (Anthropic or Ollama Cloud) until it calls `report_step_result`.
 *
 * Conversation history is shared across steps so the agent remembers what it
 * already did, but screenshots and UI snapshots are pruned to the most recent
 * few to keep the context window (and cost/latency) bounded.
 */

import type { Logger } from "../logger.js";
import type { AppiumMcpClient } from "../mcp/appiumClient.js";
import { SNAPSHOT_MARKER } from "../mcp/uiSnapshot.js";
import type { ToolCallRecord } from "../types.js";
import {
  INSPECT_SCREEN_TOOL,
  RELIABLE_ACTION_NAMES,
  toToolResultParts,
} from "../llm/toolAdapter.js";
import type {
  ChatMessage,
  ImagePart,
  LlmProvider,
  Part,
  ToolCall,
  ToolDef,
  ToolMessage,
} from "../llm/types.js";
import { dispatchAction, type DeviceController } from "./device.js";
import { STEP_COMPLETE_TOOL, buildStepInstruction } from "./prompts.js";

/** How many recent screenshots to retain in history. */
const SCREENSHOTS_TO_KEEP = 2;
/** How many recent UI snapshots to retain in history. */
const SNAPSHOTS_TO_KEEP = 2;

export interface AgentDeps {
  provider: LlmProvider;
  mcp: AppiumMcpClient;
  device: DeviceController;
  tools: ToolDef[];
  systemPrompt: string;
  maxStepIterations: number;
  visionEnabled: boolean;
  logger: Logger;
}

export interface RunStepOutcome {
  status: "success" | "failure";
  summary: string;
  details?: string;
  iterations: number;
  toolCalls: ToolCallRecord[];
}

export class MobileAgent {
  private readonly messages: ChatMessage[] = [];
  private readonly log: Logger;
  private readonly useVision: boolean;

  constructor(private readonly deps: AgentDeps) {
    this.log = deps.logger.child("agent");
    this.useVision = deps.visionEnabled && deps.provider.supportsImages;
  }

  /** Drive the model until the given step is finished. */
  async runStep(stepText: string, index: number, total: number): Promise<RunStepOutcome> {
    const toolCalls: ToolCallRecord[] = [];

    // OBSERVE: seed the step with a fresh settled snapshot (+ screenshot when
    // the provider supports vision).
    const parts: Part[] = [{ type: "text", text: buildStepInstruction(stepText, index, total) }];
    const snapshot = await this.captureSnapshot();
    if (snapshot) parts.push({ type: "text", text: snapshot });
    if (this.useVision) {
      const shot = await this.captureScreenshot();
      if (shot) parts.push(shot);
    }
    this.messages.push({ role: "user", parts });

    let nudged = false;

    for (let iteration = 1; iteration <= this.deps.maxStepIterations; iteration++) {
      this.pruneObservations();

      const result = await this.deps.provider.chat({
        system: this.deps.systemPrompt,
        tools: this.deps.tools,
        messages: this.messages,
      });

      this.messages.push({ role: "assistant", text: result.text, toolCalls: result.toolCalls });
      if (result.text) this.log.debug(`think: ${result.text}`);

      if (result.toolCalls.length === 0) {
        if (!nudged) {
          nudged = true;
          this.messages.push({
            role: "user",
            parts: [
              {
                type: "text",
                text: `Continue executing the step using tools. When it is finished, call ${STEP_COMPLETE_TOOL}.`,
              },
            ],
          });
          continue;
        }
        return {
          status: "failure",
          summary: "Agent stopped without completing the step.",
          details: result.text,
          iterations: iteration,
          toolCalls,
        };
      }
      nudged = false;

      const toolMessages: ToolMessage[] = [];
      let finished: RunStepOutcome | null = null;
      // When the model batches several tool calls in one turn, abort the rest as
      // soon as one fails: later calls would run against now-stale device state
      // and cascade errors (mobile-use's sequential-executor behaviour). We still
      // emit a tool result for every call id (required by the API).
      let aborting = false;

      for (const call of result.toolCalls) {
        if (aborting) {
          toolMessages.push(
            toolMsg(call, [{ type: "text", text: "Skipped: an earlier tool call in this turn failed. Re-observe the screen and retry." }], true),
          );
          continue;
        }

        if (call.name === STEP_COMPLETE_TOOL) {
          const input = call.input as { status?: string; summary?: string; details?: string };
          finished = {
            status: input.status === "failure" ? "failure" : "success",
            summary: input.summary ?? "(no summary)",
            details: input.details,
            iterations: iteration,
            toolCalls,
          };
          toolMessages.push(toolMsg(call, [{ type: "text", text: "Acknowledged." }]));
          continue;
        }

        if (call.name === INSPECT_SCREEN_TOOL) {
          const started = Date.now();
          const snap = (await this.captureSnapshot()) ?? "UI_SNAPSHOT (unavailable)";
          toolCalls.push({ tool: INSPECT_SCREEN_TOOL, input: {}, ok: true, durationMs: Date.now() - started });
          toolMessages.push(toolMsg(call, [{ type: "text", text: snap }]));
          continue;
        }

        const { record, parts: rparts, isError } = RELIABLE_ACTION_NAMES.has(call.name)
          ? await this.executeReliableAction(call)
          : await this.executeTool(call);
        toolCalls.push(record);
        toolMessages.push(toolMsg(call, rparts, isError));
        if (isError) aborting = true;
      }

      this.messages.push(...toolMessages);

      if (finished) {
        this.log.info(`step ${index}/${total} ${finished.status.toUpperCase()}: ${finished.summary}`);
        return finished;
      }
    }

    return {
      status: "failure",
      summary: `Step exceeded the ${this.deps.maxStepIterations}-iteration budget.`,
      iterations: this.deps.maxStepIterations,
      toolCalls,
    };
  }

  /** Execute one appium-mcp tool call. */
  private async executeTool(
    call: ToolCall,
  ): Promise<{ record: ToolCallRecord; parts: Part[]; isError: boolean }> {
    this.log.info(`tool ${call.name} ${compact(call.input)}`);
    const started = Date.now();
    const result = await this.deps.mcp.callTool(call.name, call.input);
    const durationMs = Date.now() - started;

    if (result.isError) this.log.warn(`tool ${call.name} error: ${result.text.slice(0, 200)}`);

    const record: ToolCallRecord = {
      tool: call.name,
      input: call.input,
      ok: !result.isError,
      durationMs,
      ...(result.isError ? { error: result.text.slice(0, 500) } : {}),
      // Capture raw mutations for replay (skip observations + uuid-bound calls
      // whose ids won't survive into a new session).
      ...(isReplayableMcp(call.name, call.input)
        ? { replay: { kind: "mcp" as const, tool: call.name, input: call.input } }
        : {}),
    };
    return { record, parts: toToolResultParts(result), isError: result.isError };
  }

  /** Execute a high-level reliable action through the DeviceController. */
  private async executeReliableAction(
    call: ToolCall,
  ): Promise<{ record: ToolCallRecord; parts: Part[]; isError: boolean }> {
    this.log.info(`action ${call.name} ${compact(call.input)}`);
    const started = Date.now();
    const result = await this.runAction(call.name, call.input);
    const durationMs = Date.now() - started;

    if (!result.ok) this.log.warn(`action ${call.name}: ${result.message}`);

    const record: ToolCallRecord = {
      tool: call.name,
      input: call.input,
      ok: result.ok,
      durationMs,
      ...(result.ok ? {} : { error: result.message }),
      // Reliable actions are always deterministically replayable.
      ...(result.ok ? { replay: { kind: "reliable" as const, tool: call.name, input: call.input } } : {}),
    };
    const text = `${result.ok ? "OK" : "FAILED"}: ${result.message}\n${result.snapshot}`;
    return { record, parts: [{ type: "text", text }], isError: !result.ok };
  }

  /** Dispatch a reliable-action tool name to the DeviceController. */
  private runAction(name: string, args: Record<string, unknown>) {
    return dispatchAction(this.deps.device, name, args);
  }

  /** Settle the UI and return the compact snapshot text, or null if unavailable. */
  private async captureSnapshot(): Promise<string | null> {
    try {
      const { snapshot, text } = await this.deps.device.snapshot();
      if (snapshot.count === 0 && !snapshot.size) return null;
      this.log.debug(`snapshot: ${snapshot.count} elements${snapshot.truncated ? " (capped)" : ""}`);
      return text;
    } catch (err) {
      this.log.debug("snapshot build failed", err);
      return null;
    }
  }

  /** Grab a screenshot as an image part, or null on failure. */
  private async captureScreenshot(): Promise<ImagePart | null> {
    const result = await this.deps.mcp.callTool("appium_screenshot", {});
    if (result.isError) {
      this.log.debug(`screenshot failed: ${result.text.slice(0, 120)}`);
      return null;
    }
    const image = result.blocks.find((b) => b.type === "image");
    if (!image || image.type !== "image") return null;
    return { type: "image", data: image.data, mime: "image/png" };
  }

  /**
   * Bound the context window by keeping only the most recent screenshots and UI
   * snapshots; older ones become short placeholders.
   */
  private pruneObservations(): void {
    const screenshots: Array<() => void> = [];
    const snapshots: Array<() => void> = [];

    const scan = (parts: Part[]): void => {
      parts.forEach((part, i) => {
        if (part.type === "image") {
          screenshots.push(() => {
            parts[i] = { type: "text", text: "[earlier screenshot omitted]" };
          });
        } else if (part.type === "text" && part.text.startsWith(SNAPSHOT_MARKER)) {
          snapshots.push(() => {
            parts[i] = { type: "text", text: "[earlier UI snapshot omitted]" };
          });
        }
      });
    };

    for (const m of this.messages) {
      if (m.role === "user" || m.role === "tool") scan(m.parts);
    }

    prune(screenshots, SCREENSHOTS_TO_KEEP);
    prune(snapshots, SNAPSHOTS_TO_KEEP);
  }
}

function toolMsg(call: ToolCall, parts: Part[], isError = false): ToolMessage {
  return { role: "tool", toolCallId: call.id, name: call.name, parts, isError };
}

/** Raw appium-mcp calls we can safely replay: mutations without an element UUID. */
const NON_REPLAYABLE_MCP = new Set([
  "appium_get_page_source",
  "appium_screenshot",
  "appium_get_text",
  "appium_find_element",
  "appium_get_window_size",
  "appium_session_management",
  "appium_mobile_device_info",
  "select_device",
  "generate_locators",
]);

function isReplayableMcp(name: string, input: Record<string, unknown>): boolean {
  if (!name.startsWith("appium_")) return false;
  if (NON_REPLAYABLE_MCP.has(name)) return false;
  // UUIDs are session-scoped and won't resolve on replay.
  if (typeof input.elementUUID === "string") return false;
  return true;
}

function prune(replacers: Array<() => void>, keep: number): void {
  const removeCount = Math.max(0, replacers.length - keep);
  for (let i = 0; i < removeCount; i++) replacers[i]?.();
}

function compact(obj: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return "{…}";
  }
}
