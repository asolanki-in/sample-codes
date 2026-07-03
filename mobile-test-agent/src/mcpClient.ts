/**
 * Thin client around the official `appium-mcp` server (stdio).
 *
 * We do NOT write a custom MCP server — this is an MCP *client* that
 * launches `npx appium-mcp@latest` and calls its tools. Tool names are
 * resolved through a logical-name registry (with candidate aliases and an
 * optional user toolmap), because appium-mcp tool names can drift between
 * releases; run `list-tools` to see what your server exposes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadToolmap, type Config } from "./config.js";

// logical name -> candidate tool names on the server (first hit wins)
const DEFAULT_TOOLMAP: Record<string, string[]> = {
  select_device: ["select_device", "appium_select_device"],
  session: ["appium_session_management", "create_session", "appium_create_session"],
  page_source: ["appium_get_page_source", "get_page_source", "appium_page_source"],
  screenshot: ["appium_screenshot", "take_screenshot"],
  find: ["appium_find_element", "find_element"],
  set_value: ["appium_set_value", "set_value", "appium_send_keys", "send_keys"],
  get_text: ["appium_get_text", "get_text"],
  gesture: ["appium_gesture", "gesture"],
  perform_actions: ["appium_perform_actions", "perform_actions"],
  keyboard: ["appium_mobile_keyboard", "appium_hide_keyboard", "hide_keyboard"],
  device: ["appium_mobile_device_control", "appium_device_control"],
  app_lifecycle: ["appium_app_lifecycle", "app_lifecycle", "appium_activate_app"],
  alert: ["appium_alert", "alert"],
  ai: ["appium_ai"],
  window_size: ["appium_get_window_size", "get_window_size"],
  orientation: ["appium_orientation"],
};

export class ToolCallError extends Error {}

type Args = Record<string, unknown>;

export class AppiumMcp {
  private client?: Client;
  toolNames: string[] = [];
  private toolmap: Record<string, string[]>;

  constructor(private cfg: Config) {
    this.toolmap = { ...DEFAULT_TOOLMAP };
    for (const [logical, cands] of Object.entries(loadToolmap(cfg))) {
      this.toolmap[logical] = [...cands, ...(this.toolmap[logical] ?? [])];
    }
  }

  // ---- lifecycle -----------------------------------------------------
  async start(): Promise<void> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.cfg.mcpEnv,
    };
    // NO_UI trims 500-5000+ tokens of HTML from every appium-mcp response
    env.NO_UI ??= "true";
    const transport = new StdioClientTransport({
      command: this.cfg.mcpCommand,
      args: this.cfg.mcpArgs,
      env,
    });
    this.client = new Client({ name: "mobile-test-agent", version: "0.1.0" });
    await this.client.connect(transport);
    const { tools } = await this.client.listTools();
    this.toolNames = tools.map((t) => t.name);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  // ---- generic calls ---------------------------------------------------
  toolFor(logical: string): string {
    for (const cand of this.toolmap[logical] ?? [logical]) {
      if (this.toolNames.includes(cand)) return cand;
    }
    throw new ToolCallError(
      `No server tool found for '${logical}'. Server exposes: ` +
      `${this.toolNames.join(", ")}. Add a mapping in your toolmap file ` +
      `(AGENT_TOOLMAP) to fix this.`,
    );
  }

  async call(logical: string, args: Args = {}): Promise<unknown> {
    return this.rawCall(this.toolFor(logical), args);
  }

  async rawCall(toolName: string, args: Args): Promise<unknown> {
    if (!this.client) throw new ToolCallError("call start() first");
    const result = await this.client.callTool({ name: toolName, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const payload = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
    if (result.isError) {
      throw new ToolCallError(`${toolName} failed: ${payload.slice(0, 800)}`);
    }
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }

  /** Try several argument shapes until one succeeds (schema drift guard). */
  async tryCall(logical: string, variants: Args[]): Promise<unknown> {
    let last: unknown;
    for (const args of variants) {
      try {
        return await this.call(logical, args);
      } catch (err) {
        if (!(err instanceof ToolCallError)) throw err;
        last = err;
      }
    }
    throw new ToolCallError(`all argument variants failed for ${logical}: ${last}`);
  }

  // ---- convenience wrappers ---------------------------------------------
  async pageSource(): Promise<string> {
    const out = await this.tryCall("page_source", [{}, { format: "xml" }]);
    if (out && typeof out === "object") {
      const rec = out as Record<string, unknown>;
      for (const key of ["source", "pageSource", "page_source", "xml", "result"]) {
        if (typeof rec[key] === "string") return rec[key] as string;
      }
      return JSON.stringify(out);
    }
    return String(out);
  }

  async w3cTap(x: number, y: number, holdMs = 80): Promise<void> {
    await this.call("perform_actions", {
      actions: pointerSeq([
        { type: "pointerMove", duration: 0, x, y },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: holdMs },
        { type: "pointerUp", button: 0 },
      ]),
    });
  }

  async w3cSwipe(
    x1: number, y1: number, x2: number, y2: number, durationMs = 500,
  ): Promise<void> {
    await this.call("perform_actions", {
      actions: pointerSeq([
        { type: "pointerMove", duration: 0, x: x1, y: y1 },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 100 },
        { type: "pointerMove", duration: durationMs, x: x2, y: y2 },
        { type: "pointerUp", button: 0 },
      ]),
    });
  }
}

const pointerSeq = (actions: Args[]): Args[] => [
  {
    type: "pointer",
    id: "finger1",
    parameters: { pointerType: "touch" },
    actions,
  },
];
