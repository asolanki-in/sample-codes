/**
 * Shared domain types for the mobile automation agent.
 */

export type Platform = "android" | "ios";

/** A way to point at an element for an assertion (string = match by text). */
export type StepSelector = string | { text?: string; id?: string; accessibilityId?: string };

/**
 * Author-declared, deterministic post-conditions for a step. These are checked
 * by the runner AFTER the agent finishes — independent of the agent's own
 * success/failure self-report — and are authoritative.
 */
export interface Expectation {
  /** These element(s) must be visible after the step. */
  visible?: StepSelector | StepSelector[];
  /** These element(s) must NOT be visible after the step. */
  notVisible?: StepSelector | StepSelector[];
}

/** A single natural-language instruction the agent must accomplish. */
export interface FlowStep {
  /** Stable identifier, auto-assigned if omitted (step-1, step-2, ...). */
  id: string;
  /** The natural-language instruction, e.g. "Tap on Continue". */
  text: string;
  /** If true, a failure of this step does not abort the flow. */
  optional: boolean;
  /** How many times to retry the whole step on failure (default 0). */
  retries: number;
  /** Optional deterministic post-conditions verified by the runner. */
  expect?: Expectation;
}

/** App-under-test coordinates. */
export interface AppConfig {
  /** Android package name. */
  appPackage?: string;
  /** Android launch activity. */
  appActivity?: string;
  /** iOS bundle id. */
  bundleId?: string;
  /** Local path to an .apk/.app/.ipa to install before the run. */
  appPath?: string;
}

/** A complete end-to-end flow definition. */
export interface Flow {
  name: string;
  platform?: Platform;
  device?: string;
  app?: AppConfig;
  /** Extra raw Appium capabilities merged into the session request. */
  capabilities?: Record<string, unknown>;
  steps: FlowStep[];
}

export type StepStatus = "success" | "failure" | "skipped";

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** For actions that locate an element: whether the target was found. */
  located?: boolean;
  /** For input actions: whether the typed value was verified on screen. */
  verified?: boolean;
  /** Present when this call can be replayed deterministically without an LLM. */
  replay?: ReplayAction;
}

export interface DeviceInfo {
  platform: Platform;
  deviceName?: string;
}

/** Structured diagnosis attached to a failed step. */
export interface FailureAnalysis {
  category:
    | "element-not-found"
    | "verification-failed"
    | "stuck-repeating"
    | "budget-exceeded"
    | "assertion-failed"
    | "tool-error"
    | "agent-stopped"
    | "unknown";
  message: string;
  /** The last tool/action involved in the failure, if any. */
  lastTool?: string;
  /** A short, actionable suggestion. */
  hint?: string;
}

/** Aggregate run metrics — designed to be summed across many runs. */
export interface RunMetrics {
  steps: { total: number; passed: number; failed: number; skipped: number };
  actions: { total: number; ok: number };
  /** Element-finding: attempts = actions that needed to locate an element. */
  elementLookups: { attempts: number; found: number; successRate: number };
  /** Input value verification. */
  verifications: { attempts: number; passed: number; passRate: number };
  /** Steps served from the self-healing cache (no LLM). */
  cacheHits: number;
}

/** A single deterministic action that can be re-executed during replay. */
export interface ReplayAction {
  /** "reliable" = a DeviceController action; "mcp" = a raw appium-mcp tool call. */
  kind: "reliable" | "mcp";
  tool: string;
  input: Record<string, unknown>;
}

export interface ReplayStep {
  id: string;
  text: string;
  actions: ReplayAction[];
  expect?: Expectation;
  /** False when the step did something we couldn't capture deterministically. */
  replayable: boolean;
}

/** An AI-authored run captured for deterministic, LLM-free replay. */
export interface ReplayFlow {
  name: string;
  platform: Platform;
  device?: string;
  app?: AppConfig;
  capabilities?: Record<string, unknown>;
  recordedAt: string;
  /** The model that authored the recording (for provenance). */
  model: string;
  steps: ReplayStep[];
}

export interface StepResult {
  id: string;
  text: string;
  status: StepStatus;
  summary: string;
  details?: string;
  iterations: number;
  attempts: number;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** Diagnosis when status is "failure". */
  analysis?: FailureAnalysis;
  /** Path to the per-step screenshot, when written to disk. */
  screenshotPath?: string;
  /** Base64 PNG of the step's end state, when inline screenshots are requested. */
  screenshot?: string;
  /** True when the step was served from the cache without the LLM. */
  cached?: boolean;
}

export interface FlowReport {
  runId: string;
  flow: string;
  platform: Platform;
  device?: string;
  model: string;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSteps: number;
  passed: number;
  failed: number;
  skipped: number;
  steps: StepResult[];
  metrics: RunMetrics;
}
