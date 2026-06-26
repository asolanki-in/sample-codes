/**
 * Thin, resilient wrapper around the appium-mcp server.
 *
 * We do NOT re-implement Appium. appium-mcp already exposes every primitive we
 * need (find element, gesture, set value, screenshot, page source, app
 * lifecycle, alerts, ...) over the MCP stdio transport. This wrapper:
 *   - spawns and connects to that server,
 *   - normalises tool results into a shape the agent + LLM adapter can consume,
 *   - centralises error handling and logging.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Logger } from "../logger.js";

/** A normalised piece of tool output. */
export type ToolResultBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface NormalisedToolResult {
  isError: boolean;
  blocks: ToolResultBlock[];
  /** All text blocks concatenated, for quick logging / inspection. */
  text: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AppiumMcpClientOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  logger: Logger;
}

export class AppiumMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly logger: Logger;
  private readonly options: AppiumMcpClientOptions;

  constructor(options: AppiumMcpClientOptions) {
    this.options = options;
    this.logger = options.logger.child("mcp");
  }

  /** Spawn and connect to the appium-mcp server. */
  async connect(): Promise<void> {
    if (this.client) return;

    this.logger.info(
      `Starting appium-mcp: ${this.options.command} ${this.options.args.join(" ")}`,
    );

    // Merge our passthrough env on top of the parent process env so the child
    // inherits PATH (needed to resolve `npx`), ANDROID_HOME, etc.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") childEnv[k] = v;
    }
    Object.assign(childEnv, this.options.env);

    this.transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: childEnv,
      stderr: "pipe",
    });

    // Surface the server's own logs at debug level for troubleshooting.
    this.transport.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trimEnd();
      if (line) this.logger.debug(`[appium-mcp] ${line}`);
    });

    this.client = new Client(
      { name: "mobile-automation-agent", version: "1.0.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    this.logger.info("Connected to appium-mcp");
  }

  /** Discover the tools the server exposes. */
  async listTools(): Promise<McpToolDefinition[]> {
    const client = this.requireClient();
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));
  }

  /** Invoke a tool and normalise its result. Never throws on tool errors. */
  async callTool(name: string, args: Record<string, unknown>): Promise<NormalisedToolResult> {
    const client = this.requireClient();
    try {
      const raw = await client.callTool({ name, arguments: args });
      return normaliseResult(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tool ${name} threw: ${message}`);
      return { isError: true, blocks: [{ type: "text", text: message }], text: message };
    }
  }

  /** Disconnect and terminate the server process. Safe to call repeatedly. */
  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch (err) {
      this.logger.debug("Error closing MCP client", err);
    } finally {
      this.client = null;
      this.transport = null;
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("AppiumMcpClient is not connected. Call connect() first.");
    }
    return this.client;
  }
}

/** Convert a raw MCP CallToolResult into our normalised shape. */
function normaliseResult(raw: unknown): NormalisedToolResult {
  const result = raw as {
    isError?: boolean;
    content?: Array<Record<string, unknown>>;
  };
  const blocks: ToolResultBlock[] = [];
  const texts: string[] = [];

  for (const item of result.content ?? []) {
    const type = item.type as string | undefined;
    if (type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      texts.push(item.text);
    } else if (type === "image" && typeof item.data === "string") {
      blocks.push({
        type: "image",
        data: item.data,
        mimeType: (item.mimeType as string) ?? "image/png",
      });
      texts.push("[image]");
    } else if (typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      texts.push(item.text);
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "(tool returned no content)" });
  }

  return {
    isError: result.isError === true,
    blocks,
    text: texts.join("\n"),
  };
}
