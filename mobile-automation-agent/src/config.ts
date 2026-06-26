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

const boolFromString = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

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
