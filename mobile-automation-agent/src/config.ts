/**
 * Environment configuration, validated with zod so misconfiguration fails fast
 * with a clear message instead of surfacing as a confusing runtime error later.
 */

import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { LogLevel } from "./logger.js";
import type { Platform } from "./types.js";

loadDotenv({ quiet: true });

/** Parse a JSON array of strings, falling back to a single-token array. */
function parseArgsArray(raw: string | undefined, fallback: string[]): string[] {
  if (!raw || raw.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
  } catch {
    // not JSON - treat as whitespace separated tokens
  }
  return raw.split(/\s+/).filter(Boolean);
}

/** Ensure an endpoint path starts with exactly one leading slash. */
function normaliseEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed === "") return "/sse";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Parse a JSON object of HTTP headers, ignoring anything malformed. */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
      return Object.keys(out).length > 0 ? out : undefined;
    }
  } catch {
    // ignore malformed header JSON
  }
  return undefined;
}

const boolFromString = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  // ---- appium-mcp transport ----
  // We talk to appium-mcp over streamable HTTP (httpStream) by default.
  MCP_TRANSPORT: z.enum(["httpStream", "stdio"]).default("httpStream"),
  // Full URL of a running httpStream server (overrides host/port if set).
  MCP_HTTP_URL: z.string().url().optional(),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(8080),
  // appium-mcp serves the streamable HTTP endpoint at /sse.
  MCP_HTTP_ENDPOINT: z.string().default("/sse"),
  // Optional JSON object of extra HTTP headers (e.g. auth).
  MCP_HTTP_HEADERS: z.string().optional(),
  // Spawn the appium-mcp server locally instead of connecting to an existing one.
  MCP_AUTOSTART: boolFromString.default(true),
  MCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  APPIUM_MCP_COMMAND: z.string().default("npx"),
  APPIUM_MCP_ARGS: z.string().optional(),

  REMOTE_SERVER_URL: z.string().url().optional(),

  PLATFORM: z.enum(["android", "ios"]).default("android"),
  DEVICE_NAME: z.string().optional(),

  APP_PACKAGE: z.string().optional(),
  APP_ACTIVITY: z.string().optional(),
  BUNDLE_ID: z.string().optional(),
  APP_PATH: z.string().optional(),
  ANDROID_HOME: z.string().optional(),

  MAX_STEP_ITERATIONS: z.coerce.number().int().positive().default(14),
  VISION_ENABLED: boolFromString.default(true),
  SCREENSHOTS_DIR: z.string().default("./screenshots"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfiguration {
  anthropic: {
    apiKey: string;
    model: string;
    maxTokens: number;
  };
  appiumMcp: {
    transport: "httpStream" | "stdio";
    /** Resolved streamable-HTTP URL (httpStream transport only). */
    url: string;
    /** HTTP port the server listens on (used for autostart + URL). */
    port: number;
    /** Optional extra HTTP headers for the httpStream connection. */
    headers?: Record<string, string>;
    /** Spawn the appium-mcp server locally before connecting. */
    autostart: boolean;
    /** How long to wait for the server to accept connections. */
    connectTimeoutMs: number;
    /** Command + base args used to launch appium-mcp. */
    command: string;
    args: string[];
    /** Extra env passed through to the appium-mcp child process. */
    env: Record<string, string>;
    remoteServerUrl?: string;
  };
  device: {
    platform: Platform;
    deviceName?: string;
    appPackage?: string;
    appActivity?: string;
    bundleId?: string;
    appPath?: string;
  };
  agent: {
    maxStepIterations: number;
    visionEnabled: boolean;
  };
  logLevel: LogLevel;
}

/** Load and validate configuration from the environment. Throws on error. */
export function loadConfig(): AppConfiguration {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;

  const passthroughEnv: Record<string, string> = {};
  if (env.ANDROID_HOME) passthroughEnv.ANDROID_HOME = env.ANDROID_HOME;
  if (env.SCREENSHOTS_DIR) passthroughEnv.SCREENSHOTS_DIR = env.SCREENSHOTS_DIR;
  // NO_UI dramatically reduces latency/token cost of appium-mcp responses.
  passthroughEnv.NO_UI = process.env.NO_UI ?? "true";

  return {
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
      maxTokens: env.ANTHROPIC_MAX_TOKENS,
    },
    appiumMcp: {
      transport: env.MCP_TRANSPORT,
      url:
        env.MCP_HTTP_URL ??
        `http://${env.MCP_HTTP_HOST}:${env.MCP_HTTP_PORT}${normaliseEndpoint(env.MCP_HTTP_ENDPOINT)}`,
      port: env.MCP_HTTP_PORT,
      headers: parseHeaders(env.MCP_HTTP_HEADERS),
      autostart: env.MCP_AUTOSTART,
      connectTimeoutMs: env.MCP_CONNECT_TIMEOUT_MS,
      command: env.APPIUM_MCP_COMMAND,
      args: parseArgsArray(env.APPIUM_MCP_ARGS, ["appium-mcp@latest"]),
      env: passthroughEnv,
      remoteServerUrl: env.REMOTE_SERVER_URL,
    },
    device: {
      platform: env.PLATFORM,
      deviceName: env.DEVICE_NAME,
      appPackage: env.APP_PACKAGE,
      appActivity: env.APP_ACTIVITY,
      bundleId: env.BUNDLE_ID,
      appPath: env.APP_PATH,
    },
    agent: {
      maxStepIterations: env.MAX_STEP_ITERATIONS,
      visionEnabled: env.VISION_ENABLED,
    },
    logLevel: env.LOG_LEVEL,
  };
}
