/**
 * Builds the provider-neutral tool set the agent exposes to the model:
 *   - the appium-mcp tools (discovered dynamically),
 *   - high-level reliable actions (tap / input_text / ...),
 *   - inspect_screen (compact UI snapshot),
 *   - report_step_result (finish the step).
 *
 * Also converts an appium-mcp tool result into neutral message parts.
 */

import type { McpToolDefinition, NormalisedToolResult } from "../mcp/appiumClient.js";
import type { Part, ToolDef } from "./types.js";
import { STEP_COMPLETE_TOOL } from "../agent/prompts.js";

/** Name of the local tool that returns the compact UI snapshot. */
export const INSPECT_SCREEN_TOOL = "inspect_screen";

export const inspectScreenTool: ToolDef = {
  name: INSPECT_SCREEN_TOOL,
  description:
    "Return a compact JSON list of the actionable elements currently on screen. " +
    "Each element has: ref, role, text, id, acc (accessibility id), val, state " +
    "(flags like clickable/checked/editable/disabled), c ([x,y] center for a " +
    "coordinate tap), and by (a ready-to-use {strategy, selector} for " +
    "appium_find_element). Prefer this over appium_get_page_source when locating " +
    "elements — it is far cheaper and the `by` locator is the recommended one.",
  schema: { type: "object", properties: {} },
};

const anchorProps = {
  type: "object",
  description: "Anchor element to position relative to (e.g. a label). Match by text/id/accessibilityId.",
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
 * High-level, reliable interaction tools (Maestro-style). Each waits for the UI
 * to settle, finds the element with tolerant matching + an implicit wait, acts,
 * verifies, retries on no-op, and returns a fresh settled snapshot. PREFER these
 * over the raw appium_* primitives.
 */
export const reliableActionTools: ToolDef[] = [
  {
    name: "tap",
    description:
      "Reliably tap an element. Waits for it to appear, taps it, confirms the UI changed and retries if not. " +
      "Identify the element by text/id/accessibilityId (or pass raw x,y coordinates).",
    schema: {
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
      "otherwise types into the currently focused field. `into` may use a label even if the field itself is unlabeled.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to enter." },
        into: { type: "object", description: "Optional field selector (text/id/accessibilityId or relative anchor).", properties: { ...elementQueryProps } },
        clear: { type: "boolean", description: "Reserved: replace existing contents." },
      },
      required: ["text"],
    },
  },
  {
    name: "assert_visible",
    description: "Wait (with implicit timeout) until an element is visible. Fails if it never appears.",
    schema: { type: "object", properties: { ...elementQueryProps, timeoutMs: { type: "number" } } },
  },
  {
    name: "scroll_until_visible",
    description: "Scroll in a direction until the element becomes visible.",
    schema: {
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
    schema: {
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
    schema: { type: "object", properties: {} },
  },
];

/** Names of the high-level reliable tools (handled locally, not via raw MCP). */
export const RELIABLE_ACTION_NAMES: ReadonlySet<string> = new Set(
  reliableActionTools.map((t) => t.name),
);

/** The synthetic tool the agent calls to end a step. */
export const reportStepResultTool: ToolDef = {
  name: STEP_COMPLETE_TOOL,
  description:
    "Call this exactly once to finish the current step. Use status 'success' when the step has been " +
    "accomplished and verified, or 'failure' when it cannot be completed. Always provide a concise summary.",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "failure"], description: "Whether the step succeeded or failed." },
      summary: { type: "string", description: "One short sentence describing the outcome." },
      details: { type: "string", description: "Optional extra detail (what was tapped/entered, date chosen, toggle state, or why it failed)." },
    },
    required: ["status", "summary"],
  },
};

/** Build the full neutral tool set from discovered MCP tools + local tools. */
export function buildToolDefs(mcpTools: McpToolDefinition[]): ToolDef[] {
  const tools: ToolDef[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: normaliseSchema(t.inputSchema),
  }));
  tools.push(...reliableActionTools);
  tools.push(inspectScreenTool);
  tools.push(reportStepResultTool);
  return tools;
}

function normaliseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && schema.type === "object" && typeof schema.properties === "object") {
    return schema;
  }
  return {
    type: "object",
    properties: (schema?.properties as Record<string, unknown>) ?? {},
    ...(Array.isArray(schema?.required) ? { required: schema.required as string[] } : {}),
  };
}

/** Convert a normalised MCP tool result into neutral message parts. */
export function toToolResultParts(result: NormalisedToolResult): Part[] {
  const parts: Part[] = [];
  for (const block of result.blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: truncate(block.text, 12_000) });
    } else {
      parts.push({ type: "image", data: block.data, mime: block.mimeType });
    }
  }
  if (parts.length === 0) parts.push({ type: "text", text: "(no content)" });
  return parts;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
