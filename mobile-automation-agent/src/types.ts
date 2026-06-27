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
}

export interface FlowReport {
  flow: string;
  platform: Platform;
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
}
