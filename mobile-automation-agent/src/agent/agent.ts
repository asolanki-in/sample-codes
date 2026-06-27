/**
 * The agent loop.
 *
 * For each natural-language step the agent runs a bounded OBSERVE -> PLAN ->
 * ACT -> VERIFY -> FINISH cycle, calling appium-mcp tools through Claude's
 * tool-use API until it calls `report_step_result`.
 *
 * Conversation history is shared across steps so the agent remembers what it
 * already did, but screenshots are pruned to the most recent few to keep the
 * context window (and cost/latency) bounded.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import type { AppiumMcpClient } from "../mcp/appiumClient.js";
import type { ToolCallRecord } from "../types.js";
import {
  type AnthropicTool,
  INSPECT_SCREEN_TOOL,
  RELIABLE_ACTION_NAMES,
  toToolResultContent,
} from "../llm/toolAdapter.js";
import { SNAPSHOT_MARKER } from "../mcp/uiSnapshot.js";
import type { DeviceController, ElementQuery } from "./device.js";
import { STEP_COMPLETE_TOOL, buildStepInstruction } from "./prompts.js";

/** How many recent screenshots to retain in history. */
const SCREENSHOTS_TO_KEEP = 2;
/** How many recent UI snapshots to retain in history. */
const SNAPSHOTS_TO_KEEP = 2;

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

export interface AgentDeps {
  anthropic: Anthropic;
  mcp: AppiumMcpClient;
  device: DeviceController;
  tools: AnthropicTool[];
  systemPrompt: string;
  model: string;
  maxTokens: number;
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
  private readonly messages: MessageParam[] = [];
  private readonly log: Logger;

  constructor(private readonly deps: AgentDeps) {
    this.log = deps.logger.child("agent");
  }

  /** Drive the model until the given step is finished. */
  async runStep(stepText: string, index: number, total: number): Promise<RunStepOutcome> {
    const toolCalls: ToolCallRecord[] = [];

    // OBSERVE: seed the step with a fresh compact UI snapshot (for precise
    // selectors) and, when enabled, a screenshot (for visual grounding).
    const stepContent: ContentBlockParam[] = [
      { type: "text", text: buildStepInstruction(stepText, index, total) },
    ];
    const snapshot = await this.captureSnapshot();
    if (snapshot) stepContent.push({ type: "text", text: snapshot });
    if (this.deps.visionEnabled) {
      const shot = await this.captureScreenshot();
      if (shot) stepContent.push(shot);
    }
    this.messages.push({ role: "user", content: stepContent });

    let nudged = false;

    for (let iteration = 1; iteration <= this.deps.maxStepIterations; iteration++) {
      this.pruneObservations();

      const response = await this.deps.anthropic.messages.create({
        model: this.deps.model,
        max_tokens: this.deps.maxTokens,
        system: this.deps.systemPrompt,
        tools: this.deps.tools,
        messages: this.messages,
      });

      this.messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const assistantText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (assistantText) this.log.debug(`think: ${assistantText}`);

      if (toolUses.length === 0) {
        // The model replied with text but took no action.
        if (!nudged) {
          nudged = true;
          this.messages.push({
            role: "user",
            content: [
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
          details: assistantText || undefined,
          iterations: iteration,
          toolCalls,
        };
      }
      nudged = false;

      const toolResults: ContentBlockParam[] = [];
      let finished: RunStepOutcome | null = null;

      for (const use of toolUses) {
        if (use.name === STEP_COMPLETE_TOOL) {
          const input = (use.input ?? {}) as {
            status?: string;
            summary?: string;
            details?: string;
          };
          finished = {
            status: input.status === "failure" ? "failure" : "success",
            summary: input.summary ?? "(no summary)",
            details: input.details,
            iterations: iteration,
            toolCalls,
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: [{ type: "text", text: "Acknowledged." }],
          });
          continue;
        }

        if (use.name === INSPECT_SCREEN_TOOL) {
          const started = Date.now();
          const snapshot = (await this.captureSnapshot()) ?? "UI_SNAPSHOT (unavailable)";
          toolCalls.push({
            tool: INSPECT_SCREEN_TOOL,
            input: {},
            ok: true,
            durationMs: Date.now() - started,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: [{ type: "text", text: snapshot }],
          });
          continue;
        }

        if (RELIABLE_ACTION_NAMES.has(use.name)) {
          const record = await this.executeReliableAction(use);
          toolCalls.push(record.record);
          toolResults.push(record.block);
          continue;
        }

        const record = await this.executeTool(use);
        toolCalls.push(record.record);
        toolResults.push(record.block);
      }

      this.messages.push({ role: "user", content: toolResults });

      if (finished) {
        this.log.info(
          `step ${index}/${total} ${finished.status.toUpperCase()}: ${finished.summary}`,
        );
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

  /** Execute one appium-mcp tool call and produce a tool_result block + record. */
  private async executeTool(
    use: Anthropic.ToolUseBlock,
  ): Promise<{ record: ToolCallRecord; block: ContentBlockParam }> {
    const args = (use.input ?? {}) as Record<string, unknown>;
    this.log.info(`tool ${use.name} ${compact(args)}`);

    const started = Date.now();
    const result = await this.deps.mcp.callTool(use.name, args);
    const durationMs = Date.now() - started;

    if (result.isError) {
      this.log.warn(`tool ${use.name} error: ${result.text.slice(0, 200)}`);
    }

    const record: ToolCallRecord = {
      tool: use.name,
      input: args,
      ok: !result.isError,
      durationMs,
      ...(result.isError ? { error: result.text.slice(0, 500) } : {}),
    };

    const block: ContentBlockParam = {
      type: "tool_result",
      tool_use_id: use.id,
      is_error: result.isError,
      content: toToolResultContent(result),
    };

    return { record, block };
  }

  /** Execute a high-level reliable action through the DeviceController. */
  private async executeReliableAction(
    use: Anthropic.ToolUseBlock,
  ): Promise<{ record: ToolCallRecord; block: ContentBlockParam }> {
    const args = (use.input ?? {}) as Record<string, unknown>;
    this.log.info(`action ${use.name} ${compact(args)}`);

    const started = Date.now();
    const result = await this.runAction(use.name, args);
    const durationMs = Date.now() - started;

    if (!result.ok) this.log.warn(`action ${use.name}: ${result.message}`);

    const record: ToolCallRecord = {
      tool: use.name,
      input: args,
      ok: result.ok,
      durationMs,
      ...(result.ok ? {} : { error: result.message }),
    };

    // Feed the outcome plus a fresh settled snapshot back to the model.
    const text = `${result.ok ? "OK" : "FAILED"}: ${result.message}\n${result.snapshot}`;
    const block: ContentBlockParam = {
      type: "tool_result",
      tool_use_id: use.id,
      is_error: !result.ok,
      content: [{ type: "text", text }],
    };

    return { record, block };
  }

  /** Dispatch a reliable-action tool name to the DeviceController. */
  private runAction(name: string, args: Record<string, unknown>) {
    const device = this.deps.device;
    const q = args as ElementQuery & {
      x?: number;
      y?: number;
      text?: string;
      to?: "on" | "off";
      into?: ElementQuery;
      clear?: boolean;
      timeoutMs?: number;
      direction?: "up" | "down" | "left" | "right";
      maxScrolls?: number;
    };
    switch (name) {
      case "tap":
        return device.tap(q);
      case "input_text":
        return device.inputText({ text: q.text ?? "", into: q.into, clear: q.clear });
      case "assert_visible":
        return device.assertVisible(q, q.timeoutMs);
      case "scroll_until_visible":
        return device.scrollUntilVisible(q);
      case "toggle":
        return device.toggle({ text: q.text ?? "", to: q.to });
      case "back":
        return device.back();
      default:
        return Promise.resolve({
          ok: false,
          message: `Unknown action ${name}`,
          snapshot: "",
        });
    }
  }

  /**
   * Settle the UI and return the compact snapshot text, or null if unavailable
   * (e.g. no active session yet).
   */
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

  /** Grab a screenshot as an Anthropic image block, or null on failure. */
  private async captureScreenshot(): Promise<ContentBlockParam | null> {
    const result = await this.deps.mcp.callTool("appium_screenshot", {});
    if (result.isError) {
      this.log.debug(`screenshot failed: ${result.text.slice(0, 120)}`);
      return null;
    }
    const image = result.blocks.find((b) => b.type === "image");
    if (!image || image.type !== "image") return null;
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: image.data },
    };
  }

  /**
   * Bound the context window by keeping only the most recent screenshots and UI
   * snapshots. Both dominate token usage; older ones are replaced with a short
   * placeholder so the conversation stays coherent without growing unboundedly.
   */
  private pruneObservations(): void {
    const screenshots: Array<() => void> = [];
    const snapshots: Array<() => void> = [];

    const consider = (
      arr: Array<Anthropic.ContentBlockParam>,
      index: number,
      block: Anthropic.ContentBlockParam,
    ): void => {
      if (block.type === "image") {
        screenshots.push(() => {
          arr[index] = { type: "text", text: "[earlier screenshot omitted]" };
        });
      } else if (block.type === "text" && block.text.startsWith(SNAPSHOT_MARKER)) {
        snapshots.push(() => {
          arr[index] = { type: "text", text: "[earlier UI snapshot omitted]" };
        });
      }
    };

    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue;
      const content = msg.content as ContentBlockParam[];
      content.forEach((block, i) => {
        consider(content, i, block);
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          const inner = block.content as Array<Anthropic.ContentBlockParam>;
          inner.forEach((sub, j) => consider(inner, j, sub));
        }
      });
    }

    prune(screenshots, SCREENSHOTS_TO_KEEP);
    prune(snapshots, SNAPSHOTS_TO_KEEP);
  }
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
