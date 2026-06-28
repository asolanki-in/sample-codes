/**
 * Run metrics and failure analysis.
 *
 * Metrics are designed to be summed across many runs so you can answer questions
 * like "what's our element-finding success rate over the last 200 runs?".
 */

import type { FailureAnalysis, RunMetrics, StepResult } from "../types.js";

/** Reliable actions that locate an element (so they count toward find rate). */
const LOCATING_ACTIONS = new Set([
  "tap",
  "input_text",
  "assert_visible",
  "scroll_until_visible",
  "toggle",
]);

/** Aggregate per-run metrics from the step results. */
export function computeMetrics(steps: StepResult[]): RunMetrics {
  let actions = 0;
  let actionsOk = 0;
  let lookupAttempts = 0;
  let lookupFound = 0;
  let verifyAttempts = 0;
  let verifyPassed = 0;
  let cacheHits = 0;

  for (const step of steps) {
    if (step.cached) cacheHits += 1;
    for (const tc of step.toolCalls) {
      actions += 1;
      if (tc.ok) actionsOk += 1;
      if (tc.located !== undefined && LOCATING_ACTIONS.has(tc.tool)) {
        lookupAttempts += 1;
        if (tc.located) lookupFound += 1;
      }
      if (tc.verified !== undefined) {
        verifyAttempts += 1;
        if (tc.verified) verifyPassed += 1;
      }
    }
  }

  return {
    steps: {
      total: steps.length,
      passed: steps.filter((s) => s.status === "success").length,
      failed: steps.filter((s) => s.status === "failure").length,
      skipped: steps.filter((s) => s.status === "skipped").length,
    },
    actions: { total: actions, ok: actionsOk },
    elementLookups: {
      attempts: lookupAttempts,
      found: lookupFound,
      successRate: lookupAttempts === 0 ? 1 : round(lookupFound / lookupAttempts),
    },
    verifications: {
      attempts: verifyAttempts,
      passed: verifyPassed,
      passRate: verifyAttempts === 0 ? 1 : round(verifyPassed / verifyAttempts),
    },
    cacheHits,
  };
}

/** Classify why a step failed, with an actionable hint. */
export function analyzeFailure(step: StepResult): FailureAnalysis {
  const s = step.summary.toLowerCase();
  const lastError = [...step.toolCalls].reverse().find((t) => !t.ok);
  const lastTool = lastError?.tool ?? step.toolCalls.at(-1)?.tool;

  if (s.includes("stuck repeating")) {
    return {
      category: "stuck-repeating",
      message: step.summary,
      lastTool,
      hint: "Element is likely ambiguous or absent — target it with `index`, a relative anchor (below/above), or scroll it into view.",
    };
  }
  if (s.includes("iteration budget") || s.includes("budget")) {
    return {
      category: "budget-exceeded",
      message: step.summary,
      lastTool,
      hint: "Raise the step's maxIterations / --max-iterations, or split it into smaller steps.",
    };
  }
  if (s.includes("assertion failed")) {
    return { category: "assertion-failed", message: step.summary, lastTool, hint: "The expected post-condition was not met; check the `expect` selector or the prior step." };
  }
  if (s.includes("no element matched") || s.includes("not visible") || s.includes("no input matched")) {
    return {
      category: "element-not-found",
      message: step.summary,
      lastTool,
      hint: "Confirm the visible label, scroll the element into view, or use a relative anchor / index.",
    };
  }
  if (s.includes("verification")) {
    return { category: "verification-failed", message: step.summary, lastTool, hint: "The typed value didn't read back; the field may be masked or the wrong field was targeted." };
  }
  if (s.includes("stopped without completing")) {
    return { category: "agent-stopped", message: step.summary, lastTool, hint: "The model ended the step without finishing; consider a clearer instruction or a stronger model." };
  }
  if (lastError?.error) {
    return { category: "tool-error", message: lastError.error, lastTool, hint: "A device/appium call errored; check the session and selector." };
  }
  return { category: "unknown", message: step.summary, lastTool };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
