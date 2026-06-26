/**
 * Deterministic device/session scaffolding.
 *
 * Session creation is too important to leave to the LLM: we build Appium
 * capabilities from config + flow and create the session directly through
 * appium-mcp. The agent is then only responsible for the fuzzy UI navigation.
 */

import type { AppConfiguration } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppiumMcpClient } from "../mcp/appiumClient.js";
import type { Flow, Platform } from "../types.js";

export interface ResolvedSession {
  platform: Platform;
}

/** Merge env config + flow overrides into a W3C capabilities object. */
function buildCapabilities(
  config: AppConfiguration,
  flow: Flow,
): { platform: Platform; capabilities: Record<string, unknown> } {
  const platform = flow.platform ?? config.device.platform;
  const automationName = platform === "ios" ? "XCUITest" : "UiAutomator2";

  const caps: Record<string, unknown> = {
    platformName: platform === "ios" ? "iOS" : "Android",
    "appium:automationName": automationName,
    "appium:newCommandTimeout": 300,
  };

  const deviceName = flow.device ?? config.device.deviceName;
  if (deviceName) caps["appium:deviceName"] = deviceName;

  const appPath = flow.app?.appPath ?? config.device.appPath;
  if (appPath) caps["appium:app"] = appPath;

  if (platform === "android") {
    const pkg = flow.app?.appPackage ?? config.device.appPackage;
    const act = flow.app?.appActivity ?? config.device.appActivity;
    if (pkg) caps["appium:appPackage"] = pkg;
    if (act) caps["appium:appActivity"] = act;
  } else {
    const bundleId = flow.app?.bundleId ?? config.device.bundleId;
    if (bundleId) caps["appium:bundleId"] = bundleId;
  }

  // Flow-level raw capabilities win over everything (escape hatch).
  Object.assign(caps, flow.capabilities ?? {});

  return { platform, capabilities: caps };
}

/** Create an Appium session. Throws with a clear message on failure. */
export async function createSession(
  mcp: AppiumMcpClient,
  config: AppConfiguration,
  flow: Flow,
  logger: Logger,
): Promise<ResolvedSession> {
  const { platform, capabilities } = buildCapabilities(config, flow);
  logger.info(`Creating ${platform} session`, capabilities);

  const args: Record<string, unknown> = {
    action: "create",
    platform: platform === "ios" ? "iOS" : "Android",
    capabilities,
  };
  if (config.appiumMcp.remoteServerUrl) {
    args.remoteServerUrl = config.appiumMcp.remoteServerUrl;
  }

  const result = await mcp.callTool("appium_session_management", args);
  if (result.isError) {
    throw new Error(`Failed to create Appium session: ${result.text}`);
  }
  logger.info("Session created");
  return { platform };
}

/** Best-effort session teardown; never throws. */
export async function deleteSession(mcp: AppiumMcpClient, logger: Logger): Promise<void> {
  try {
    const result = await mcp.callTool("appium_session_management", { action: "delete" });
    if (result.isError) {
      logger.debug(`Session delete reported: ${result.text.slice(0, 160)}`);
    } else {
      logger.info("Session deleted");
    }
  } catch (err) {
    logger.debug("Session delete threw", err);
  }
}
