/**
 * Central configuration for the mobile test agent.
 *
 * Everything is overridable via environment variables or CLI flags so the
 * agent can run unchanged against local Ollama, Ollama Cloud, different
 * appium-mcp versions, Android or iOS.
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";

export type Platform = "android" | "ios";

export interface Config {
  // --- LLM (Ollama Cloud) ---
  ollamaHost: string;
  ollamaApiKey: string;
  model: string;
  llmTimeoutMs: number;

  // --- appium-mcp server launch ---
  mcpCommand: string;
  mcpArgs: string[];
  mcpEnv: Record<string, string>;

  // --- device / session ---
  platform: Platform;
  capabilitiesFile?: string;
  createSession: boolean;

  // --- reliability tuning (Maestro-style) ---
  stepTimeoutMs: number;          // max wall time per step incl. retries
  maxAttempts: number;            // find→act→verify attempts per step
  stablePollIntervalMs: number;   // UI-idle polling cadence
  stableTimeoutMs: number;        // max wait for UI to settle
  waitForElementTimeoutMs: number;
  scrollMaxSwipes: number;        // scroll-to-find budget per direction

  // --- matching thresholds ---
  matchAcceptScore: number;       // deterministic accept threshold
  matchAcceptMargin: number;      // required gap over the runner-up
  matchStrongScore: number;       // accept regardless of margin

  // --- token frugality ---
  snapshotMaxChars: number;       // cap on UI listing sent to the LLM
  enableLlm: boolean;             // false => fully deterministic mode
  enableVisionFallback: boolean;  // appium_ai (needs vision creds)

  // --- misc ---
  dayFirstDates: boolean;         // "01 02 1990" => 1 Feb 1990
  continueOnFailure: boolean;
  reportFile?: string;
  toolmapFile?: string;
}

export function defaultConfig(): Config {
  const env = process.env;
  return {
    ollamaHost: env.OLLAMA_HOST ?? "https://ollama.com",
    ollamaApiKey: env.OLLAMA_API_KEY ?? "",
    model: env.AGENT_MODEL ?? "gpt-oss:120b",
    llmTimeoutMs: Number(env.AGENT_LLM_TIMEOUT_MS ?? 120_000),

    mcpCommand: env.APPIUM_MCP_COMMAND ?? "npx",
    mcpArgs: (env.APPIUM_MCP_ARGS ?? "-y appium-mcp@latest").split(/\s+/),
    mcpEnv: {},

    platform: (env.AGENT_PLATFORM as Platform) ?? "android",
    capabilitiesFile: env.AGENT_CAPS_FILE,
    createSession: true,

    stepTimeoutMs: 30_000,
    maxAttempts: 3,
    stablePollIntervalMs: 400,
    stableTimeoutMs: 10_000,
    waitForElementTimeoutMs: 12_000,
    scrollMaxSwipes: 8,

    matchAcceptScore: 0.72,
    matchAcceptMargin: 0.08,
    matchStrongScore: 0.9,

    snapshotMaxChars: 6000,
    enableLlm: true,
    enableVisionFallback: false,

    dayFirstDates: true,
    continueOnFailure: false,
    reportFile: undefined,
    toolmapFile: env.AGENT_TOOLMAP,
  };
}

export function loadCapabilities(cfg: Config): Record<string, unknown> {
  if (cfg.capabilitiesFile) {
    return JSON.parse(readFileSync(cfg.capabilitiesFile, "utf8"));
  }
  if (cfg.platform === "ios") {
    return { platformName: "iOS", "appium:automationName": "XCUITest" };
  }
  return { platformName: "Android", "appium:automationName": "UiAutomator2" };
}

/**
 * Optional logical-name -> [candidate tool names] overrides.
 * appium-mcp tool names can drift between versions; this lets users
 * re-map without touching code. See toolmap.example.yaml.
 */
export function loadToolmap(cfg: Config): Record<string, string[]> {
  if (!cfg.toolmapFile) return {};
  const data = YAML.parse(readFileSync(cfg.toolmapFile, "utf8")) ?? {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = Array.isArray(v) ? (v as string[]) : [String(v)];
  }
  return out;
}
