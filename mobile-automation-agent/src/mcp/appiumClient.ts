/**
 * Thin, resilient wrapper around the appium-mcp server.
 *
 * We do NOT re-implement Appium. appium-mcp already exposes every primitive we
 * need (find element, gesture, set value, screenshot, page source, app
 * lifecycle, alerts, ...) over MCP. This wrapper:
 *   - connects over the configured transport (streamable HTTP by default, or
 *     stdio),
 *   - optionally spawns the appium-mcp server process for you,
 *   - normalises tool results into a shape the agent + LLM adapter can consume,
 *   - centralises error handling, retries and logging.
 *
 * Transport notes:
 *   - httpStream: appium-mcp is started with `--httpStream --port=<port>` and
 *     serves the streamable-HTTP endpoint at `/sse`. We connect with
 *     StreamableHTTPClientTransport. The server can be local (autostart) or
 *     already running elsewhere (set MCP_HTTP_URL / MCP_AUTOSTART=false).
 *   - stdio: appium-mcp is spawned as a child and we speak over its stdio.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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
  transport: "httpStream" | "stdio";
  /** Resolved streamable-HTTP URL (httpStream only). */
  url: string;
  /** Port the server listens on (httpStream autostart). */
  port: number;
  /** Extra HTTP headers for the httpStream connection. */
  headers?: Record<string, string>;
  /** Spawn the appium-mcp server locally before connecting. */
  autostart: boolean;
  /** How long to keep retrying the initial connection. */
  connectTimeoutMs: number;
  /** Command + base args used to launch appium-mcp. */
  command: string;
  args: string[];
  /** Extra env passed through to the appium-mcp child process. */
  env: Record<string, string>;
  logger: Logger;
}

export class AppiumMcpClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private child: ChildProcess | null = null;
  private readonly logger: Logger;
  private readonly options: AppiumMcpClientOptions;

  constructor(options: AppiumMcpClientOptions) {
    this.options = options;
    this.logger = options.logger.child("mcp");
  }

  /** Connect to the appium-mcp server (spawning it first if configured). */
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.options.transport === "stdio") {
      await this.connectStdio();
    } else {
      await this.connectHttp();
    }
    this.logger.info(`Connected to appium-mcp (${this.options.transport})`);
  }

  private async connectStdio(): Promise<void> {
    this.logger.info(
      `Starting appium-mcp (stdio): ${this.options.command} ${this.options.args.join(" ")}`,
    );
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: this.buildChildEnv(),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => this.pipeServerLog(chunk));

    const client = this.newClient();
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  private async connectHttp(): Promise<void> {
    if (this.options.autostart) {
      this.spawnHttpServer();
    } else {
      this.logger.info(`Connecting to external appium-mcp at ${this.options.url}`);
    }

    const url = new URL(this.options.url);
    const requestInit = this.options.headers ? { headers: this.options.headers } : undefined;
    const deadline = Date.now() + this.options.connectTimeoutMs;
    let attempt = 0;
    let lastError: unknown;

    while (Date.now() < deadline) {
      attempt += 1;
      // A fresh transport per attempt: a failed connect leaves it unusable.
      const transport = new StreamableHTTPClientTransport(url, { requestInit });
      const client = this.newClient();
      try {
        await client.connect(transport);
        this.client = client;
        this.transport = transport;
        return;
      } catch (err) {
        lastError = err;
        await transport.close().catch(() => undefined);
        if (this.child && this.child.exitCode !== null) {
          throw new Error(
            `appium-mcp server exited (code ${this.child.exitCode}) before it was reachable.`,
          );
        }
        this.logger.debug(`connect attempt ${attempt} failed, retrying…`);
        await delay(700);
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Could not connect to appium-mcp at ${this.options.url} within ` +
        `${this.options.connectTimeoutMs}ms: ${reason}`,
    );
  }

  /** Spawn `appium-mcp --httpStream --port=<port>` as a child process. */
  private spawnHttpServer(): void {
    const args = [...this.options.args, "--httpStream", `--port=${this.options.port}`];
    this.logger.info(`Starting appium-mcp (httpStream): ${this.options.command} ${args.join(" ")}`);

    const child = spawn(this.options.command, args, {
      env: this.buildChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => this.pipeServerLog(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.pipeServerLog(chunk));
    child.on("exit", (code, signal) => {
      this.logger.debug(`appium-mcp server exited (code=${code}, signal=${signal})`);
    });
    child.on("error", (err) => {
      this.logger.error(`Failed to spawn appium-mcp: ${err.message}`);
    });
    this.child = child;
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

  /** Disconnect, then terminate the server process if we started it. */
  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch (err) {
      this.logger.debug("Error closing MCP client", err);
    }
    try {
      await this.transport?.close();
    } catch (err) {
      this.logger.debug("Error closing transport", err);
    }
    this.client = null;
    this.transport = null;

    if (this.child && this.child.exitCode === null) {
      this.logger.debug("Stopping appium-mcp server process");
      this.child.kill("SIGTERM");
      // Escalate if it doesn't exit promptly.
      const child = this.child;
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    }
    this.child = null;
  }

  private newClient(): Client {
    return new Client(
      { name: "mobile-automation-agent", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  private buildChildEnv(): Record<string, string> {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") childEnv[k] = v;
    }
    Object.assign(childEnv, this.options.env);
    return childEnv;
  }

  private pipeServerLog(chunk: Buffer): void {
    const line = chunk.toString("utf8").trimEnd();
    if (line) this.logger.debug(`[appium-mcp] ${line}`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
