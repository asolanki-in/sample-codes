/**
 * Multi-device parallel execution.
 *
 * Each device run is fully isolated already (its own appium-mcp process + port,
 * its own session, DeviceController and LLM provider), so to run on N devices we
 * just clone the config per device — distinct `deviceName` (udid) and a distinct
 * appium-mcp port — and run them concurrently with a bounded pool.
 *
 * The practical ceiling is NOT this code (it's async/I/O-bound, so one Node
 * process drives many runs fine). It's external: how many devices/emulators the
 * host can run, and the LLM provider's rate/concurrency limits — each device is
 * an independent agent loop making many model calls. Use `--concurrency` to stay
 * within those.
 */

import type { AppConfiguration } from "../config.js";
import type { Logger } from "../logger.js";
import type { Flow, FlowReport } from "../types.js";
import { runFlow } from "./flowRunner.js";
import { writeReport } from "./report.js";

export interface ParallelOptions {
  /** Max devices running at once (default: all of them). */
  concurrency?: number;
  keepSession?: boolean;
  stopOnFailure?: boolean;
  /** Directory for per-device JSON reports. */
  reportDir?: string;
  /** Directory for per-device replay recordings. */
  recordDir?: string;
  /** Directory for per-device artifacts (screenshots + report). */
  artifactsDir?: string;
}

export interface DeviceRunResult {
  device: string;
  report: FlowReport | null;
  error?: string;
}

/**
 * Derive a per-device config: distinct device (udid) and a distinct appium-mcp
 * port (basePort + index) so autostarted servers don't collide.
 */
export function deriveDeviceConfig(
  base: AppConfiguration,
  deviceName: string,
  index: number,
): AppConfiguration {
  const cfg = structuredClone(base);
  cfg.device.deviceName = deviceName;
  const port = base.appiumMcp.port + index;
  cfg.appiumMcp.port = port;
  try {
    const u = new URL(base.appiumMcp.url);
    u.port = String(port);
    cfg.appiumMcp.url = u.toString();
  } catch {
    // leave url as-is if unparseable
  }
  return cfg;
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Run the same flow on several devices concurrently. */
export async function runParallel(
  flow: Flow,
  baseConfig: AppConfiguration,
  deviceNames: string[],
  logger: Logger,
  options: ParallelOptions = {},
): Promise<DeviceRunResult[]> {
  const concurrency = options.concurrency ?? deviceNames.length;
  logger.info(
    `Running "${flow.name}" on ${deviceNames.length} device(s) (concurrency ${concurrency}): ${deviceNames.join(", ")}`,
  );

  return runWithConcurrency(deviceNames, concurrency, async (name, index) => {
    const cfg = deriveDeviceConfig(baseConfig, name, index);
    const dlog = logger.child(name);
    const slug = safeName(name);
    try {
      const report = await runFlow(flow, cfg, dlog, {
        keepSession: options.keepSession,
        stopOnFailure: options.stopOnFailure,
        recordPath: options.recordDir ? `${options.recordDir}/${slug}.replay.json` : undefined,
        artifactsDir: options.artifactsDir ? `${options.artifactsDir}/${slug}` : undefined,
      });
      if (options.reportDir) {
        await writeReport(report, `${options.reportDir}/${slug}.report.json`);
      }
      return { device: name, report };
    } catch (err) {
      const message = (err as Error).message;
      dlog.error(`device run failed: ${message}`);
      return { device: name, report: null, error: message };
    }
  });
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
