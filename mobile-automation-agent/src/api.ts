/**
 * Public package API.
 *
 * Import this to embed the agent in a larger application:
 *
 *   import { runFlow, RunEmitter, loadConfig } from "mobile-automation-agent";
 *
 *   const emitter = new RunEmitter();
 *   emitter.onEvent("step:end", (e) => host.record(e));      // status + screenshot + analysis
 *   emitter.onEvent("run:complete", (e) => host.report(e.report)); // pass/fail + metrics
 *
 *   const report = await runFlow(flow, loadConfig(), logger, {
 *     runId, emitter, vars, inlineScreenshots: true,
 *   });
 */

export { runFlow, runReplay, type RunFlowOptions } from "./runner/flowRunner.js";
export {
  runParallel,
  deriveDeviceConfig,
  runWithConcurrency,
  type ParallelOptions,
  type DeviceRunResult,
} from "./runner/parallelRunner.js";
export {
  loadFlowFromFile,
  flowFromInlineSteps,
  loadReplayFlow,
  substituteVars,
} from "./runner/flowParser.js";
export { computeMetrics, analyzeFailure } from "./runner/metrics.js";
export { loadConfig, type AppConfiguration, type LlmProviderKind } from "./config.js";
export { createLogger, Logger, type LogLevel } from "./logger.js";

export {
  RunEmitter,
  type RunEventMap,
  type RunStartEvent,
  type StepStartEvent,
  type ActionEvent,
  type StepEndEvent,
  type RunCompleteEvent,
  type RunErrorEvent,
} from "./events.js";

export type {
  Flow,
  FlowStep,
  FlowReport,
  StepResult,
  StepStatus,
  ToolCallRecord,
  ReplayFlow,
  ReplayStep,
  ReplayAction,
  Expectation,
  StepSelector,
  DeviceInfo,
  FailureAnalysis,
  RunMetrics,
  Platform,
  AppConfig,
} from "./types.js";
