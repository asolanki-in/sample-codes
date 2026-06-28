#!/usr/bin/env node
/**
 * CLI entrypoint for the mobile automation agent.
 *
 * Examples:
 *   mobile-agent run flows/signup.flow.yaml
 *   mobile-agent run --step "Tap on Continue" --step "Enter username as hello"
 *   mobile-agent run flows/signup.flow.yaml --platform ios --report reports/run.json
 */

import { Command, Option } from "commander";
import { loadConfig, type AppConfiguration } from "./config.js";
import { createLogger } from "./logger.js";
import { flowFromInlineSteps, loadFlowFromFile, loadReplayFlow } from "./runner/flowParser.js";
import { runFlow, runReplay } from "./runner/flowRunner.js";
import { runParallel } from "./runner/parallelRunner.js";
import { printReport, writeReport } from "./runner/report.js";
import type { Flow, Platform } from "./types.js";

interface RunOptions {
  step?: string[];
  platform?: Platform;
  device?: string;
  appPackage?: string;
  appActivity?: string;
  bundleId?: string;
  provider?: "anthropic" | "ollama";
  model?: string;
  maxIterations?: string;
  report?: string;
  record?: string;
  cache?: string;
  artifacts?: string;
  vision: boolean;
  keepSession?: boolean;
  continueOnFailure?: boolean;
  dryRun?: boolean;
}

interface ReplayOptions {
  platform?: Platform;
  device?: string;
  report?: string;
  artifacts?: string;
  keepSession?: boolean;
  continueOnFailure?: boolean;
}

interface ParallelOptions {
  step?: string[];
  device?: string[];
  platform?: Platform;
  appPackage?: string;
  appActivity?: string;
  bundleId?: string;
  provider?: "anthropic" | "ollama";
  model?: string;
  concurrency?: string;
  reportDir?: string;
  recordDir?: string;
  artifactsDir?: string;
  continueOnFailure?: boolean;
  keepSession?: boolean;
}

const program = new Command();

program
  .name("mobile-agent")
  .description(
    "Run end-to-end mobile UI flows from natural-language steps using an LLM (Ollama Cloud or Claude) + appium-mcp.",
  )
  .version("1.0.0");

program
  .command("run")
  .description("Run a flow from a file or inline --step instructions")
  .argument("[flowFile]", "path to a .yaml/.json/.txt flow file")
  .option("-s, --step <text...>", "inline step (repeatable); used when no flow file is given")
  .addOption(new Option("-p, --platform <platform>", "target platform").choices(["android", "ios"]))
  .option("-d, --device <name>", "device/emulator/simulator udid or name")
  .option("--app-package <pkg>", "Android app package")
  .option("--app-activity <activity>", "Android launch activity")
  .option("--bundle-id <id>", "iOS bundle id")
  .addOption(new Option("--provider <provider>", "LLM provider").choices(["anthropic", "ollama"]))
  .option("-m, --model <model>", "model override for the active provider")
  .option("--max-iterations <n>", "max model<->device round trips per step")
  .option("-r, --report <path>", "write a JSON report to this path")
  .option("--record <path>", "record a deterministic replay file of this run")
  .option("--cache <path>", "self-healing locator cache: replay cached steps (no LLM), heal misses, update the file")
  .option("--artifacts <dir>", "write per-step screenshots + report to this directory")
  .option("--no-vision", "disable sending screenshots to the model")
  .option("--keep-session", "do not delete the Appium session after the run")
  .option("--continue-on-failure", "keep running later steps after a required step fails")
  .option("--dry-run", "parse and print the flow without executing it")
  .action(async (flowFile: string | undefined, options: RunOptions) => {
    await runCommand(flowFile, options);
  });

program
  .command("replay")
  .description("Re-run a recorded flow deterministically (no LLM, no tokens)")
  .argument("<replayFile>", "path to a replay file produced by `run --record`")
  .addOption(new Option("-p, --platform <platform>", "target platform").choices(["android", "ios"]))
  .option("-d, --device <name>", "device/emulator/simulator udid or name")
  .option("-r, --report <path>", "write a JSON report to this path")
  .option("--artifacts <dir>", "write per-step screenshots + report to this directory")
  .option("--keep-session", "do not delete the Appium session after the run")
  .option("--continue-on-failure", "keep running later steps after a failure")
  .action(async (replayFile: string, options: ReplayOptions) => {
    await replayCommand(replayFile, options);
  });

program
  .command("parallel")
  .description("Run a flow on multiple devices concurrently")
  .argument("[flowFile]", "path to a .yaml/.json/.txt flow file")
  .option("-s, --step <text...>", "inline step (repeatable); used when no flow file is given")
  .option("-d, --device <name...>", "device names/udids to run on (repeatable or comma-separated)")
  .addOption(new Option("-p, --platform <platform>", "target platform").choices(["android", "ios"]))
  .option("--app-package <pkg>", "Android app package")
  .option("--app-activity <activity>", "Android launch activity")
  .option("--bundle-id <id>", "iOS bundle id")
  .addOption(new Option("--provider <provider>", "LLM provider").choices(["anthropic", "ollama"]))
  .option("-m, --model <model>", "model override for the active provider")
  .option("--concurrency <n>", "max devices running at once (default: all)")
  .option("--report-dir <dir>", "write per-device JSON reports here")
  .option("--record-dir <dir>", "write per-device replay recordings here")
  .option("--artifacts-dir <dir>", "write per-device screenshots + reports here")
  .option("--continue-on-failure", "within each device, keep going after a failed step")
  .option("--keep-session", "do not delete sessions after the run")
  .action(async (flowFile: string | undefined, options: ParallelOptions) => {
    await parallelCommand(flowFile, options);
  });

async function runCommand(flowFile: string | undefined, options: RunOptions): Promise<void> {
  let config: AppConfiguration;
  try {
    config = loadConfig();
  } catch (err) {
    // Config errors are user-facing; print cleanly without a stack trace.
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  // CLI flags override env config.
  applyOverrides(config, options);
  const logger = createLogger(config.logLevel, "mobile-agent");

  let flow: Flow;
  try {
    if (flowFile) {
      flow = await loadFlowFromFile(flowFile);
    } else if (options.step && options.step.length > 0) {
      flow = flowFromInlineSteps(options.step);
    } else {
      throw new Error("Provide a flow file or at least one --step.");
    }
  } catch (err) {
    logger.error(`Failed to load flow: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  // Flow-level platform/app fall back to config; CLI already applied above.
  flow.platform = flow.platform ?? config.device.platform;

  if (options.dryRun) {
    logger.info(`Flow "${flow.name}" (${flow.platform}) — ${flow.steps.length} steps:`);
    flow.steps.forEach((s, i) => logger.info(`  ${i + 1}. ${s.text}`));
    return;
  }

  try {
    const report = await runFlow(flow, config, logger, {
      keepSession: options.keepSession,
      stopOnFailure: !options.continueOnFailure,
      recordPath: options.record,
      cachePath: options.cache,
      artifactsDir: options.artifacts,
    });

    printReport(report, logger);
    if (options.report) {
      await writeReport(report, options.report);
      logger.info(`Report written to ${options.report}`);
    }

    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (err) {
    logger.error(`Run failed: ${(err as Error).message}`, err);
    process.exitCode = 1;
  }
}

async function replayCommand(replayFile: string, options: ReplayOptions): Promise<void> {
  let config: AppConfiguration;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.platform) config.device.platform = options.platform;
  if (options.device) config.device.deviceName = options.device;
  const logger = createLogger(config.logLevel, "mobile-agent");

  try {
    const replay = await loadReplayFlow(replayFile);
    logger.info(`Replaying "${replay.name}" (${replay.platform}, recorded by ${replay.model})`);

    const report = await runReplay(replay, config, logger, {
      keepSession: options.keepSession,
      stopOnFailure: !options.continueOnFailure,
      artifactsDir: options.artifacts,
    });

    printReport(report, logger);
    if (options.report) {
      await writeReport(report, options.report);
      logger.info(`Report written to ${options.report}`);
    }
    process.exitCode = report.status === "passed" ? 0 : 1;
  } catch (err) {
    logger.error(`Replay failed: ${(err as Error).message}`, err);
    process.exitCode = 1;
  }
}

async function parallelCommand(
  flowFile: string | undefined,
  options: ParallelOptions,
): Promise<void> {
  let config: AppConfiguration;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.platform) config.device.platform = options.platform;
  if (options.appPackage) config.device.appPackage = options.appPackage;
  if (options.appActivity) config.device.appActivity = options.appActivity;
  if (options.bundleId) config.device.bundleId = options.bundleId;
  if (options.provider) config.llm.provider = options.provider;
  if (options.model) {
    if (config.llm.provider === "ollama") config.llm.ollama.model = options.model;
    else config.llm.anthropic.model = options.model;
  }
  const logger = createLogger(config.logLevel, "mobile-agent");

  // Devices may be repeated and/or comma-separated.
  const devices = (options.device ?? [])
    .flatMap((d) => d.split(","))
    .map((d) => d.trim())
    .filter(Boolean);
  if (devices.length === 0) {
    logger.error("Provide at least one device with --device.");
    process.exitCode = 2;
    return;
  }

  let flow: Flow;
  try {
    if (flowFile) flow = await loadFlowFromFile(flowFile);
    else if (options.step && options.step.length > 0) flow = flowFromInlineSteps(options.step);
    else throw new Error("Provide a flow file or at least one --step.");
  } catch (err) {
    logger.error(`Failed to load flow: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  flow.platform = flow.platform ?? config.device.platform;

  const concurrency = options.concurrency ? Math.max(1, Number.parseInt(options.concurrency, 10)) : undefined;

  try {
    const results = await runParallel(flow, config, devices, logger, {
      concurrency,
      keepSession: options.keepSession,
      stopOnFailure: !options.continueOnFailure,
      reportDir: options.reportDir,
      recordDir: options.recordDir,
      artifactsDir: options.artifactsDir,
    });

    let failed = 0;
    const lines = ["", `Parallel run: ${flow.name} on ${results.length} device(s)`, "─".repeat(56)];
    for (const r of results) {
      if (r.error) {
        failed += 1;
        lines.push(`✗ ${r.device}  ERROR: ${r.error}`);
      } else if (r.report) {
        if (r.report.status !== "passed") failed += 1;
        lines.push(
          `${r.report.status === "passed" ? "✓" : "✗"} ${r.device}  ${r.report.passed}/${r.report.totalSteps} passed` +
            (r.report.failed ? `, ${r.report.failed} failed` : ""),
        );
      }
    }
    lines.push("─".repeat(56));
    lines.push(`${failed === 0 ? "ALL PASSED" : `${failed}/${results.length} device(s) FAILED`}`, "");
    logger.info(lines.join("\n"));

    process.exitCode = failed === 0 ? 0 : 1;
  } catch (err) {
    logger.error(`Parallel run failed: ${(err as Error).message}`, err);
    process.exitCode = 1;
  }
}

function applyOverrides(config: AppConfiguration, options: RunOptions): void {
  if (options.platform) config.device.platform = options.platform;
  if (options.device) config.device.deviceName = options.device;
  if (options.appPackage) config.device.appPackage = options.appPackage;
  if (options.appActivity) config.device.appActivity = options.appActivity;
  if (options.bundleId) config.device.bundleId = options.bundleId;
  if (options.provider) config.llm.provider = options.provider;
  if (options.model) {
    if (config.llm.provider === "ollama") config.llm.ollama.model = options.model;
    else config.llm.anthropic.model = options.model;
  }
  if (options.vision === false) config.agent.visionEnabled = false;
  if (options.maxIterations) {
    const n = Number.parseInt(options.maxIterations, 10);
    if (Number.isFinite(n) && n > 0) config.agent.maxStepIterations = n;
  }
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
