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

/** Name of the local tool that returns the compact UI snapshot. */
export const INSPECT_SCREEN_TOOL = "inspect_screen";

/**
 * Local (agent-side) tool that returns a compact, token-efficient list of the
 * actionable on-screen elements with precomputed locators. Strongly preferred
 * over raw `appium_get_page_source` for finding elements.
 */
export const inspectScreenTool: AnthropicTool = {
  name: INSPECT_SCREEN_TOOL,
  description:
    "Return a compact JSON list of the actionable elements currently on screen. " +
    "Each element has: ref, role, text, id, acc (accessibility id), val, state " +
    "(flags like clickable/checked/editable/disabled), c ([x,y] center for a " +
    "coordinate tap), and by (a ready-to-use {strategy, selector} for " +
    "appium_find_element). Prefer this over appium_get_page_source when locating " +
    "elements — it is far cheaper and the `by` locator is the recommended one.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const anchorProps = {
  type: "object",
  description:
    "Anchor element to position relative to (e.g. a label). Match it by text/id/accessibilityId.",
  properties: {
    text: { type: "string" },
    id: { type: "string" },
    accessibilityId: { type: "string" },
  },
} as const;

const elementQueryProps = {
  text: { type: "string", description: "Match by visible text / accessibility id / value (case-insensitive, substring OK)." },
  id: { type: "string", description: "Match by resource-id (Android) substring." },
  accessibilityId: { type: "string", description: "Match by exact accessibility id / content-desc / name." },
  index: { type: "number", description: "0-based index to pick when several elements match." },
  below: { ...anchorProps, description: "Restrict to elements positioned below this anchor (e.g. the input under a label)." },
  above: { ...anchorProps, description: "Restrict to elements positioned above this anchor." },
  leftOf: { ...anchorProps, description: "Restrict to elements positioned left of this anchor." },
  rightOf: { ...anchorProps, description: "Restrict to elements positioned right of this anchor." },
} as const;

/**
 * High-level, reliable interaction tools (Maestro-style). Each one waits for the
 * UI to settle, finds the element with tolerant matching and an implicit wait,
 * acts, verifies, retries on no-op, and returns a fresh settled snapshot. PREFER
 * these over the raw appium_* primitives.
 */
export const reliableActionTools: AnthropicTool[] = [
  {
    name: "tap",
    description:
      "Reliably tap an element. Waits for it to appear, taps it, confirms the UI changed and retries if not. " +
      "Identify the element by text/id/accessibilityId (or pass raw x,y coordinates).",
    input_schema: {
      type: "object",
      properties: {
        ...elementQueryProps,
        x: { type: "number", description: "Raw X coordinate (alternative to a selector)." },
        y: { type: "number", description: "Raw Y coordinate (use together with x)." },
      },
    },
  },
  {
    name: "input_text",
    description:
      "Type text. Optionally target a field via `into` (it will be focused and its value replaced); " +
      "otherwise types into the currently focused field.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to enter." },
        into: { type: "object", description: "Optional field selector.", properties: { ...elementQueryProps } },
        clear: { type: "boolean", description: "Reserved: replace existing contents." },
      },
      required: ["text"],
    },
  },
  {
    name: "assert_visible",
    description: "Wait (with implicit timeout) until an element is visible. Fails if it never appears.",
    input_schema: { type: "object", properties: { ...elementQueryProps, timeoutMs: { type: "number" } } },
  },
  {
    name: "scroll_until_visible",
    description: "Scroll in a direction until the element becomes visible.",
    input_schema: {
      type: "object",
      properties: {
        ...elementQueryProps,
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Default down." },
        maxScrolls: { type: "number", description: "Max scroll attempts (default 10)." },
      },
    },
  },
  {
    name: "toggle",
    description:
      "State-aware switch/checkbox toggle. Reads the current state and only taps when it differs from the desired state. " +
      "Omit `to` to flip; set to 'on'/'off' to ensure a state.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Label of the switch/checkbox." },
        to: { type: "string", enum: ["on", "off"], description: "Desired state; omit to flip." },
      },
      required: ["text"],
    },
  },
  {
    name: "back",
    description: "Navigate back (Android back button / iOS nav pop), then wait for the UI to settle.",
    input_schema: { type: "object", properties: {} },
  },
];

/** Names of the high-level reliable tools (handled locally, not via raw MCP). */
export const RELIABLE_ACTION_NAMES: ReadonlySet<string> = new Set(
  reliableActionTools.map((t) => t.name),
);

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
  tools.push(...reliableActionTools);
  tools.push(inspectScreenTool);
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
