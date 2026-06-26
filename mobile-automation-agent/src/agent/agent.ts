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
  toToolResultContent,
} from "../llm/toolAdapter.js";
import { STEP_COMPLETE_TOOL, buildStepInstruction } from "./prompts.js";

/** How many recent screenshots to retain in history. */
const SCREENSHOTS_TO_KEEP = 2;

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

export interface AgentDeps {
  anthropic: Anthropic;
  mcp: AppiumMcpClient;
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

    // OBSERVE: seed the step with a fresh screenshot for visual grounding.
    const stepContent: ContentBlockParam[] = [
      { type: "text", text: buildStepInstruction(stepText, index, total) },
    ];
    if (this.deps.visionEnabled) {
      const shot = await this.captureScreenshot();
      if (shot) stepContent.push(shot);
    }
    this.messages.push({ role: "user", content: stepContent });

    let nudged = false;

    for (let iteration = 1; iteration <= this.deps.maxStepIterations; iteration++) {
      this.pruneScreenshots();

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
   * Replace all but the most recent screenshots with a text placeholder.
   * Screenshots dominate token usage; keeping only the latest couple preserves
   * the visual context that matters while bounding the window.
   */
  private pruneScreenshots(): void {
    const replacers: Array<() => void> = [];

    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue;
      const content = msg.content as ContentBlockParam[];
      content.forEach((block, i) => {
        if (block.type === "image") {
          replacers.push(() => {
            content[i] = { type: "text", text: "[earlier screenshot omitted]" };
          });
        } else if (block.type === "tool_result" && Array.isArray(block.content)) {
          const inner = block.content as Array<Anthropic.ContentBlockParam>;
          inner.forEach((sub, j) => {
            if (sub.type === "image") {
              replacers.push(() => {
                inner[j] = { type: "text", text: "[earlier screenshot omitted]" };
              });
            }
          });
        }
      });
    }

    const removeCount = Math.max(0, replacers.length - SCREENSHOTS_TO_KEEP);
    for (let i = 0; i < removeCount; i++) replacers[i]?.();
  }
}

function compact(obj: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return "{…}";
  }
}
