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
import { MobileAgent } from "../agent/agent.js";
import { DeviceController, type ElementQuery } from "../agent/device.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { createSession, deleteSession } from "./session.js";
import type { Expectation, Flow, FlowReport, Platform, StepResult, StepSelector } from "../types.js";

export interface RunFlowOptions {
  keepSession?: boolean;
  /** If true, stop at the first non-optional failure (default true). */
  stopOnFailure?: boolean;
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
  return assembleReport(flow, platform, model, startedAt, stepResults);
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
