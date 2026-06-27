/**
 * End-to-end flow orchestration.
 *
 * Lifecycle: connect MCP -> discover tools -> create session -> run each step
 * with the agent (honouring retries + optional) -> assemble report -> tear
 * down. Setup/teardown are deterministic; only the steps go through the LLM.
 */

import type { AppConfiguration } from "../config.js";
import type { Logger } from "../logger.js";
import { AppiumMcpClient } from "../mcp/appiumClient.js";
import { buildToolDefs } from "../llm/toolAdapter.js";
import { createProvider } from "../llm/provider.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MobileAgent } from "../agent/agent.js";
import { DeviceController, dispatchAction, type ElementQuery } from "../agent/device.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { createSession, deleteSession } from "./session.js";
import type {
  Expectation,
  Flow,
  FlowReport,
  Platform,
  ReplayAction,
  ReplayFlow,
  ReplayStep,
  StepResult,
  StepSelector,
} from "../types.js";

export interface RunFlowOptions {
  keepSession?: boolean;
  /** If true, stop at the first non-optional failure (default true). */
  stopOnFailure?: boolean;
  /** Write a deterministic replay file capturing the resolved actions. */
  recordPath?: string;
  /** Directory to write per-step screenshots + the report (evidence). */
  artifactsDir?: string;
}

export async function runFlow(
  flow: Flow,
  config: AppConfiguration,
  logger: Logger,
  options: RunFlowOptions = {},
): Promise<FlowReport> {
  const stopOnFailure = options.stopOnFailure ?? true;
  const startedAt = new Date();

  const mcp = new AppiumMcpClient({
    transport: config.appiumMcp.transport,
    url: config.appiumMcp.url,
    port: config.appiumMcp.port,
    headers: config.appiumMcp.headers,
    autostart: config.appiumMcp.autostart,
    connectTimeoutMs: config.appiumMcp.connectTimeoutMs,
    command: config.appiumMcp.command,
    args: config.appiumMcp.args,
    env: config.appiumMcp.env,
    logger,
  });

  const stepResults: StepResult[] = [];
  let platform: Platform = flow.platform ?? config.device.platform;

  try {
    await mcp.connect();

    const mcpTools = await mcp.listTools();
    logger.info(`Discovered ${mcpTools.length} appium-mcp tools`);
    const tools = buildToolDefs(mcpTools);

    const provider = createProvider(config);
    logger.info(`LLM provider: ${provider.name} (${provider.model})`);

    const session = await createSession(mcp, config, flow, logger);
    platform = session.platform;

    const device = new DeviceController(
      mcp,
      {
        platform,
        settleTimeoutMs: config.agent.settleTimeoutMs,
        findTimeoutMs: config.agent.findTimeoutMs,
      },
      logger,
    );

    const agent = new MobileAgent({
      provider,
      mcp,
      device,
      tools,
      systemPrompt: buildSystemPrompt({ platform, appHint: appHint(flow, config) }),
      maxStepIterations: config.agent.maxStepIterations,
      visionEnabled: config.agent.visionEnabled,
      logger,
    });

    const total = flow.steps.length;
    let aborted = false;

    for (let i = 0; i < total; i++) {
      const step = flow.steps[i]!;
      const index = i + 1;

      if (aborted) {
        stepResults.push(skipped(step.id, step.text));
        continue;
      }

      logger.info(`▶ Step ${index}/${total}: ${step.text}`);
      const result = await runStepWithRetries(agent, step.text, index, total, step.retries);
      const stepResult: StepResult = {
        id: step.id,
        text: step.text,
        status: result.outcome.status,
        summary: result.outcome.summary,
        details: result.outcome.details,
        iterations: result.outcome.iterations,
        attempts: result.attempts,
        toolCalls: result.outcome.toolCalls,
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      };
      // VERIFY: if the author declared post-conditions, check them
      // deterministically — this overrides the agent's own self-report.
      if (stepResult.status === "success" && step.expect) {
        const verdict = await verifyExpectations(device, step.expect, logger);
        if (!verdict.ok) {
          stepResult.status = "failure";
          stepResult.summary = `Assertion failed: ${verdict.message}`;
          logger.warn(`Step ${index} assertion failed: ${verdict.message}`);
        } else {
          stepResult.summary += ` | verified: ${verdict.message}`;
        }
      }

      stepResults.push(stepResult);

      if (options.artifactsDir) {
        await saveScreenshot(mcp, options.artifactsDir, `step-${index}-${stepResult.status}.png`, logger);
      }

      if (stepResult.status === "failure" && !step.optional && stopOnFailure) {
        logger.error(`Aborting flow: required step "${step.text}" failed.`);
        aborted = true;
      }
    }

    if (!options.keepSession) {
      await deleteSession(mcp, logger);
    }
  } finally {
    await mcp.close();
  }

  const model =
    config.llm.provider === "ollama" ? config.llm.ollama.model : config.llm.anthropic.model;
  const report = assembleReport(flow, platform, model, startedAt, stepResults);

  // Emit a deterministic replay recording and/or evidence artifacts.
  if (options.recordPath) {
    await writeReplayFlow(buildReplayFlow(flow, platform, model, stepResults), options.recordPath, logger);
  }
  if (options.artifactsDir) {
    await writeJson(`${options.artifactsDir}/report.json`, report);
    await writeReplayFlow(buildReplayFlow(flow, platform, model, stepResults), `${options.artifactsDir}/replay.json`, logger);
  }

  return report;
}

/**
 * Re-run an AI-authored recording deterministically — no LLM, no tokens.
 * Each recorded action re-resolves its target (reliable actions) or replays the
 * raw call, then settles and verifies; author assertions are re-checked.
 */
export async function runReplay(
  replay: ReplayFlow,
  config: AppConfiguration,
  logger: Logger,
  options: RunFlowOptions = {},
): Promise<FlowReport> {
  const stopOnFailure = options.stopOnFailure ?? true;
  const startedAt = new Date();

  const mcp = new AppiumMcpClient({
    transport: config.appiumMcp.transport,
    url: config.appiumMcp.url,
    port: config.appiumMcp.port,
    headers: config.appiumMcp.headers,
    autostart: config.appiumMcp.autostart,
    connectTimeoutMs: config.appiumMcp.connectTimeoutMs,
    command: config.appiumMcp.command,
    args: config.appiumMcp.args,
    env: config.appiumMcp.env,
    logger,
  });

  const stepResults: StepResult[] = [];
  const platform: Platform = replay.platform;
  // Synthesise a Flow so we can reuse deterministic session creation.
  const sessionFlow: Flow = {
    name: replay.name,
    platform: replay.platform,
    device: replay.device,
    app: replay.app,
    capabilities: replay.capabilities,
    steps: [],
  };

  try {
    await mcp.connect();
    await createSession(mcp, config, sessionFlow, logger);
    const device = new DeviceController(
      mcp,
      { platform, settleTimeoutMs: config.agent.settleTimeoutMs, findTimeoutMs: config.agent.findTimeoutMs },
      logger,
    );

    const total = replay.steps.length;
    let aborted = false;

    for (let i = 0; i < total; i++) {
      const step = replay.steps[i]!;
      const index = i + 1;
      const start = Date.now();
      const startedIso = new Date(start).toISOString();

      if (aborted) {
        stepResults.push(skipped(step.id, step.text));
        continue;
      }

      logger.info(`▶ Replay ${index}/${total}: ${step.text}`);
      let status: StepResult["status"] = "success";
      let summary = "Replayed";

      if (!step.replayable && step.actions.length === 0 && !step.expect) {
        status = "skipped";
        summary = "Step was not recorded as replayable (used non-deterministic actions).";
        logger.warn(`Replay ${index} skipped: ${summary}`);
      } else {
        // Anti-cascade: stop the step's actions at the first failure.
        for (const action of step.actions) {
          const ok = await runReplayAction(device, mcp, action);
          if (!ok.ok) {
            status = "failure";
            summary = `Action ${action.tool} failed: ${ok.message}`;
            break;
          }
        }
        if (status === "success" && step.expect) {
          const verdict = await verifyExpectations(device, step.expect, logger);
          if (!verdict.ok) {
            status = "failure";
            summary = `Assertion failed: ${verdict.message}`;
          } else {
            summary += ` | verified: ${verdict.message}`;
          }
        }
      }

      const end = Date.now();
      stepResults.push({
        id: step.id,
        text: step.text,
        status,
        summary,
        iterations: 0,
        attempts: 1,
        toolCalls: [],
        durationMs: end - start,
        startedAt: startedIso,
        finishedAt: new Date(end).toISOString(),
      });

      if (options.artifactsDir) {
        await saveScreenshot(mcp, options.artifactsDir, `step-${index}-${status}.png`, logger);
      }
      if (status === "failure" && stopOnFailure) {
        logger.error(`Aborting replay: step "${step.text}" failed.`);
        aborted = true;
      }
    }

    if (!options.keepSession) await deleteSession(mcp, logger);
  } finally {
    await mcp.close();
  }

  const report = assembleReport(sessionFlow, platform, `replay:${replay.model}`, startedAt, stepResults);
  if (options.artifactsDir) await writeJson(`${options.artifactsDir}/report.json`, report);
  return report;
}

/** Execute a single recorded action during replay. */
async function runReplayAction(
  device: DeviceController,
  mcp: AppiumMcpClient,
  action: ReplayAction,
): Promise<{ ok: boolean; message: string }> {
  if (action.kind === "reliable") {
    const res = await dispatchAction(device, action.tool, action.input);
    return { ok: res.ok, message: res.message };
  }
  const res = await mcp.callTool(action.tool, action.input);
  return { ok: !res.isError, message: res.text.slice(0, 200) };
}

function buildReplayFlow(
  flow: Flow,
  platform: Platform,
  model: string,
  stepResults: StepResult[],
): ReplayFlow {
  const steps: ReplayStep[] = flow.steps.map((s, i) => {
    const r = stepResults[i];
    const actions: ReplayAction[] = (r?.toolCalls ?? [])
      .map((tc) => tc.replay)
      .filter((a): a is ReplayAction => Boolean(a));
    return {
      id: s.id,
      text: s.text,
      actions,
      ...(s.expect ? { expect: s.expect } : {}),
      replayable: r?.status === "success" && (actions.length > 0 || Boolean(s.expect)),
    };
  });
  return {
    name: flow.name,
    platform,
    device: flow.device,
    app: flow.app,
    capabilities: flow.capabilities,
    recordedAt: new Date().toISOString(),
    model,
    steps,
  };
}

async function writeReplayFlow(replay: ReplayFlow, path: string, logger: Logger): Promise<void> {
  await writeJson(path, replay);
  const n = replay.steps.filter((s) => s.replayable).length;
  logger.info(`Recorded replay → ${path} (${n}/${replay.steps.length} steps replayable)`);
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

/** Capture a screenshot from the device and save it as PNG (best-effort). */
async function saveScreenshot(
  mcp: AppiumMcpClient,
  dir: string,
  name: string,
  logger: Logger,
): Promise<void> {
  try {
    const res = await mcp.callTool("appium_screenshot", { maxWidth: 1080 });
    const image = res.blocks.find((b) => b.type === "image");
    if (!image || image.type !== "image") return;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${name}`, Buffer.from(image.data, "base64"));
  } catch (err) {
    logger.debug(`screenshot artifact failed: ${(err as Error).message}`);
  }
}

interface StepRunResult {
  outcome: Awaited<ReturnType<MobileAgent["runStep"]>>;
  attempts: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

async function runStepWithRetries(
  agent: MobileAgent,
  text: string,
  index: number,
  total: number,
  retries: number,
): Promise<StepRunResult> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  let outcome = await agent.runStep(text, index, total);
  let attempts = 1;

  while (outcome.status === "failure" && attempts <= retries) {
    attempts += 1;
    outcome = await agent.runStep(`Retry (attempt ${attempts}): ${text}`, index, total);
  }

  const end = Date.now();
  return {
    outcome,
    attempts,
    durationMs: end - start,
    startedAt,
    finishedAt: new Date(end).toISOString(),
  };
}

/** Deterministically check author-declared post-conditions for a step. */
async function verifyExpectations(
  device: DeviceController,
  expect: Expectation,
  logger: Logger,
): Promise<{ ok: boolean; message: string }> {
  const checks: string[] = [];

  for (const sel of toArray(expect.visible)) {
    logger.debug(`assert visible: ${describeSelector(sel)}`);
    if (!(await device.isVisible(toQuery(sel)))) {
      return { ok: false, message: `expected visible ${describeSelector(sel)}` };
    }
    checks.push(`visible ${describeSelector(sel)}`);
  }

  for (const sel of toArray(expect.notVisible)) {
    logger.debug(`assert NOT visible: ${describeSelector(sel)}`);
    // Short timeout: we're confirming absence, no need to wait the full window.
    if (await device.isVisible(toQuery(sel), 1500)) {
      return { ok: false, message: `expected NOT visible ${describeSelector(sel)}` };
    }
    checks.push(`not-visible ${describeSelector(sel)}`);
  }

  return { ok: true, message: checks.join(", ") || "no checks" };
}

function toArray(sel: StepSelector | StepSelector[] | undefined): StepSelector[] {
  if (sel === undefined) return [];
  return Array.isArray(sel) ? sel : [sel];
}

function toQuery(sel: StepSelector): ElementQuery {
  return typeof sel === "string" ? { text: sel } : sel;
}

function describeSelector(sel: StepSelector): string {
  if (typeof sel === "string") return `"${sel}"`;
  return JSON.stringify(sel);
}

function appHint(flow: Flow, config: AppConfiguration): string | undefined {
  const pkg = flow.app?.appPackage ?? config.device.appPackage;
  const bundle = flow.app?.bundleId ?? config.device.bundleId;
  return pkg ?? bundle ?? undefined;
}

function skipped(id: string, text: string): StepResult {
  const now = new Date().toISOString();
  return {
    id,
    text,
    status: "skipped",
    summary: "Skipped because a previous required step failed.",
    iterations: 0,
    attempts: 0,
    toolCalls: [],
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
  };
}

function assembleReport(
  flow: Flow,
  platform: Platform,
  model: string,
  startedAt: Date,
  steps: StepResult[],
): FlowReport {
  const finishedAt = new Date();
  const passed = steps.filter((s) => s.status === "success").length;
  const failed = steps.filter((s) => s.status === "failure").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;

  return {
    flow: flow.name,
    platform,
    model,
    status: failed === 0 ? "passed" : "failed",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totalSteps: steps.length,
    passed,
    failed,
    skipped: skippedCount,
    steps,
  };
}
