/**
 * Run reporting: a human-readable console summary plus an optional JSON file
 * suitable for CI artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../logger.js";
import type { FlowReport, StepResult } from "../types.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const useColor = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

function paint(color: string, text: string): string {
  return useColor ? `${color}${text}${RESET}` : text;
}

function icon(status: StepResult["status"]): string {
  switch (status) {
    case "success":
      return paint(GREEN, "✓");
    case "failure":
      return paint(RED, "✗");
    case "skipped":
      return paint(YELLOW, "−");
  }
}

/** Print a readable summary of the run to stderr. */
export function printReport(report: FlowReport, logger: Logger): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Flow: ${report.flow}  (${report.platform}, ${report.model})`);
  lines.push("─".repeat(56));
  for (const step of report.steps) {
    lines.push(
      `${icon(step.status)} ${step.id}  ${step.text}` +
        paint(DIM, `  [${step.iterations} it, ${step.toolCalls.length} calls, ${ms(step.durationMs)}]`),
    );
    if (step.status !== "success") {
      lines.push(`    ${paint(DIM, step.summary)}`);
    }
  }
  lines.push("─".repeat(56));
  const verdict =
    report.status === "passed"
      ? paint(GREEN, "PASSED")
      : paint(RED, "FAILED");
  lines.push(
    `${verdict}  ${report.passed}/${report.totalSteps} passed` +
      (report.failed ? `, ${report.failed} failed` : "") +
      (report.skipped ? `, ${report.skipped} skipped` : "") +
      `  in ${ms(report.durationMs)}`,
  );
  lines.push("");
  logger.info(lines.join("\n"));
}

/** Persist the report as JSON for CI / debugging. */
export async function writeReport(report: FlowReport, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

function ms(value: number): string {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}
