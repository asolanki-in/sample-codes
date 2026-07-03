#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 *   mobile-test-agent run flows/login.yaml --platform android
 *   mobile-test-agent dry-run flows/login.yaml
 *   mobile-test-agent list-tools
 */
import { parseArgs } from "node:util";
import { loadFlow, MobileTestAgent, run } from "./agent.js";
import { defaultConfig, type Config, type Platform } from "./config.js";
import { parseStep } from "./parser.js";

function buildConfig(values: Record<string, unknown>): Config {
  const cfg = defaultConfig();
  if (values.platform) cfg.platform = values.platform as Platform;
  if (values.caps) cfg.capabilitiesFile = String(values.caps);
  if (values.model) cfg.model = String(values.model);
  if (values.report) cfg.reportFile = String(values.report);
  if (values["no-llm"]) cfg.enableLlm = false;
  if (values.vision) cfg.enableVisionFallback = true;
  if (values["continue-on-failure"]) cfg.continueOnFailure = true;
  if (values.toolmap) cfg.toolmapFile = String(values.toolmap);
  return cfg;
}

function dryRun(flowPath: string, cfg: Config): number {
  for (const step of loadFlow(flowPath)) {
    if (!step.trim() || step.trim().startsWith("#")) continue;
    const command = parseStep(step, cfg.dayFirstDates);
    if (!command) {
      console.log(`  LLM-needed    ${step}`);
    } else {
      let desc = command.kind as string;
      if (command.target) desc += ` target=${JSON.stringify(command.target)}`;
      if (command.value) desc += ` value=${JSON.stringify(command.value)}`;
      if (command.toggleState) desc += ` state=${command.toggleState}`;
      console.log(`  deterministic ${JSON.stringify(step)} -> ${desc}`);
    }
  }
  return 0;
}

async function listTools(cfg: Config): Promise<void> {
  cfg.createSession = false;
  const agent = new MobileTestAgent(cfg);
  await agent.start();
  try {
    for (const name of agent.mcp.toolNames) console.log(name);
  } finally {
    await agent.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      platform: { type: "string" },
      caps: { type: "string" },
      model: { type: "string" },
      report: { type: "string" },
      toolmap: { type: "string" },
      "no-llm": { type: "boolean" },
      vision: { type: "boolean" },
      "continue-on-failure": { type: "boolean" },
    },
  });
  const [command, flowPath] = positionals;
  const cfg = buildConfig(values);

  switch (command) {
    case "dry-run":
      if (!flowPath) throw new Error("usage: dry-run <flow file>");
      process.exit(dryRun(flowPath, cfg));
      break;
    case "list-tools":
      await listTools(cfg);
      break;
    case "run": {
      if (!flowPath) throw new Error("usage: run <flow file> [options]");
      const report = await run(cfg, flowPath);
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.passed ? 0 : 1);
      break;
    }
    default:
      console.error(
        "usage: mobile-test-agent <run|dry-run|list-tools> [flow] [options]\n" +
        "  --platform android|ios   --caps caps.json   --model <ollama model>\n" +
        "  --report report.json     --no-llm           --vision\n" +
        "  --continue-on-failure    --toolmap toolmap.yaml",
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
