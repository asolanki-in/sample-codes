/**
 * Bridges the appium-mcp tool surface to Anthropic's tool-use API.
 *
 * - Converts MCP tool definitions into Anthropic `Tool` schemas (1:1 — as the
 *   appium-mcp server gains tools, the agent gains them for free).
 * - Adds a synthetic `report_step_result` tool the agent uses to declare a step
 *   finished.
 * - Converts normalised MCP tool results back into Anthropic tool_result
 *   content blocks (preserving screenshots as image blocks).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { McpToolDefinition, NormalisedToolResult } from "../mcp/appiumClient.js";
import { STEP_COMPLETE_TOOL } from "../agent/prompts.js";

export type AnthropicTool = Anthropic.Tool;
export type ToolResultContentBlock = Anthropic.ToolResultBlockParam["content"];

/** The synthetic tool the agent calls to end a step. */
export const reportStepResultTool: AnthropicTool = {
  name: STEP_COMPLETE_TOOL,
  description:
    "Call this exactly once to finish the current step. Use status 'success' when the step has been accomplished and verified, or 'failure' when it cannot be completed. Always provide a concise summary of what happened.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["success", "failure"],
        description: "Whether the current step succeeded or failed.",
      },
      summary: {
        type: "string",
        description: "One short sentence describing the outcome of the step.",
      },
      details: {
        type: "string",
        description:
          "Optional extra detail: what was tapped/entered, the date chosen, the toggle's final state, or why it failed.",
      },
    },
    required: ["status", "summary"],
  },
};

/** Convert MCP tool defs (+ the synthetic tool) into Anthropic tools. */
export function buildAnthropicTools(mcpTools: McpToolDefinition[]): AnthropicTool[] {
  const tools: AnthropicTool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: normaliseSchema(t.inputSchema),
  }));
  tools.push(reportStepResultTool);
  return tools;
}

/**
 * Anthropic requires the top-level input schema to be an object schema. Most
 * MCP servers already emit `{ type: "object", properties, required }`; we
 * defensively coerce anything that isn't.
 */
function normaliseSchema(schema: Record<string, unknown>): AnthropicTool["input_schema"] {
  if (schema && schema.type === "object" && typeof schema.properties === "object") {
    return schema as AnthropicTool["input_schema"];
  }
  return {
    type: "object",
    properties: (schema?.properties as Record<string, unknown>) ?? {},
    ...(Array.isArray(schema?.required) ? { required: schema.required as string[] } : {}),
  };
}

/**
 * Turn a normalised MCP tool result into Anthropic tool_result content.
 * Screenshots come back as image blocks so the model can "see" them.
 */
export function toToolResultContent(result: NormalisedToolResult): ToolResultContentBlock {
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];

  for (const block of result.blocks) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: truncate(block.text, 12_000) });
    } else {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: toMediaType(block.mimeType),
          data: block.data,
        },
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "(no content)" });
  }
  return blocks;
}

function toMediaType(mime: string): Anthropic.Base64ImageSource["media_type"] {
  switch (mime) {
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
    case "image/png":
      return mime;
    default:
      return "image/png";
  }
}

/** Page-source XML can be enormous; cap it so a single tool result can't blow the context window. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
