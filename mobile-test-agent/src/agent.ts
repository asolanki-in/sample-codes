/**
 * Orchestrator: the find → act → verify loop.
 *
 * Escalation ladder per step (cheapest first — this is the token budget):
 *
 *   parse:   grammar (0 tokens) ────────────► LLM parse (~150 tokens, rare)
 *   find:    fuzzy matcher (0 tokens) ─► scroll-to-find (0) ─► LLM pick
 *            (~300 tokens, rare) ─► appium_ai vision (optional)
 *   act:     deterministic executors (0 tokens)
 *   verify:  postcondition on fresh snapshot (0 tokens)
 *   recover: wait-for-idle → re-find → alternate action path → retry (×N)
 *
 * A typical flow therefore costs *zero* LLM tokens; the LLM only pays for
 * genuinely ambiguous screens, which is how this stays far below
 * plan-every-step agents (DroidRun averages ~3,225 tokens per task).
 */
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import {
  ActionError, DeviceFacade, scrollToFind, selectOption, setDate,
  setToggle, sleep,
} from "./actions.js";
import { loadCapabilities, type Config } from "./config.js";
import {
  COMMAND_SCHEMA, DISAMBIG_SCHEMA, LLMUnavailableError, OllamaLLM,
  type TokenUsage,
} from "./llm.js";
import { confident, resolveTarget, type MatchResult } from "./matcher.js";
import { AppiumMcp, ToolCallError } from "./mcpClient.js";
import {
  parseDateValue, parseStep, MONTH_NAMES,
  type Command, type CommandKind,
} from "./parser.js";
import { brief, scrollContainers, type Snapshot, type UIElement } from "./snapshot.js";
import * as V from "./verify.js";

export type StepStatus = "PASSED" | "PASSED_UNVERIFIED" | "FAILED" | "SKIPPED";

export interface StepResult {
  step: string;
  status: StepStatus;
  attempts: number;
  detail: string;
  durationMs: number;
  llmUsed: boolean;
}

export interface RunReport {
  passed: boolean;
  steps: StepResult[];
  tokenUsage: TokenUsage;
}

export class MobileTestAgent {
  readonly mcp: AppiumMcp;
  readonly llm: OllamaLLM;
  readonly dev: DeviceFacade;

  constructor(private cfg: Config) {
    this.mcp = new AppiumMcp(cfg);
    this.llm = new OllamaLLM(cfg);
    this.dev = new DeviceFacade(this.mcp, cfg);
  }

  // ---- lifecycle ------------------------------------------------------
  async start(): Promise<void> {
    await this.mcp.start();
    if (this.cfg.createSession) await this.ensureSession();
  }

  private async ensureSession(): Promise<void> {
    const capabilities = loadCapabilities(this.cfg);
    try {
      await this.mcp.tryCall("session", [
        { action: "create", capabilities },
        { action: "create" },
        { capabilities },
      ]);
    } catch (err) {
      console.warn(
        `session create failed (${err}); assuming server auto-manages the session`,
      );
    }
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  // ---- flow running -----------------------------------------------------
  async runFlow(steps: string[]): Promise<RunReport> {
    const results: StepResult[] = [];
    for (const stepRaw of steps) {
      const step = stepRaw.trim();
      if (!step || step.startsWith("#")) continue;
      const result = await this.runStep(step);
      results.push(result);
      console.log(`${result.status.padEnd(18)} ${step}  (${result.detail})`);
      if (result.status === "FAILED" && !this.cfg.continueOnFailure) break;
    }
    return {
      passed: results.every((r) => r.status !== "FAILED"),
      steps: results,
      tokenUsage: this.llm.usage,
    };
  }

  async runStep(text: string): Promise<StepResult> {
    const t0 = Date.now();
    const result: StepResult = {
      step: text, status: "FAILED", attempts: 0, detail: "",
      durationMs: 0, llmUsed: false,
    };

    let command = parseStep(text, this.cfg.dayFirstDates);
    if (!command) {
      command = await this.llmParse(text);
      result.llmUsed = !!command;
    }
    if (!command) {
      result.detail = "could not understand step (grammar + LLM failed)";
      result.durationMs = Date.now() - t0;
      return result;
    }

    const deadline = t0 + this.cfg.stepTimeoutMs;
    let lastDetail = "";
    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      result.attempts = attempt;
      try {
        const verification = await this.attempt(command, result);
        if (verification.ok) {
          result.status = verification.weak ? "PASSED_UNVERIFIED" : "PASSED";
          result.detail = verification.detail;
          result.durationMs = Date.now() - t0;
          return result;
        }
        lastDetail = verification.detail;
      } catch (err) {
        if (!(err instanceof ActionError) && !(err instanceof ToolCallError)) throw err;
        lastDetail = String(err instanceof Error ? err.message : err);
      }
      if (Date.now() > deadline) {
        lastDetail += " (step timeout)";
        break;
      }
      // recovery between attempts: settle UI, drop keyboard, re-snapshot
      await this.dev.hideKeyboard();
      await this.dev.stableSnapshot(3000);
      console.log(`retrying step (attempt ${attempt + 1}): ${text} — ${lastDetail}`);
    }

    result.detail = lastDetail;
    result.durationMs = Date.now() - t0;
    return result;
  }

  // ---- one find→act→verify attempt --------------------------------------
  private async attempt(command: Command, result: StepResult): Promise<V.Verification> {
    const { dev, cfg } = { dev: this.dev, cfg: this.cfg };

    // commands with no target element
    switch (command.kind) {
      case "wait":
        await sleep(parseFloat(command.value ?? "1") * 1000);
        return { ok: true, detail: "waited" };
      case "back":
        await this.mcp.tryCall("device", [
          { action: "back" }, { action: "press_back" }, { key: "back" }]);
        return { ok: true, detail: "back pressed", weak: true };
      case "home":
        await this.mcp.tryCall("device", [{ action: "home" }, { key: "home" }]);
        return { ok: true, detail: "home pressed", weak: true };
      case "hide_keyboard":
        await dev.hideKeyboard();
        return { ok: true, detail: "keyboard hidden", weak: true };
      case "launch":
        await this.mcp.tryCall("app_lifecycle", [
          { action: "launch", appId: command.target },
          { action: "activate", appId: command.target },
          { appId: command.target },
        ]);
        await dev.stableSnapshot();
        return { ok: true, detail: `launched ${command.target}`, weak: true };
      case "press_key":
        await this.mcp.tryCall("keyboard", [
          { action: "press", key: command.value }, { key: command.value }]);
        return { ok: true, detail: `pressed ${command.value}`, weak: true };
      default:
        break;
    }

    // assertions: wait-for-condition rather than instant check
    if (command.kind === "assert_visible" || command.kind === "assert_not_visible") {
      const deadline = Date.now() + cfg.waitForElementTimeoutMs;
      for (;;) {
        const snap = await dev.snapshot();
        const ver = V.verifyVisible(snap, command, cfg.matchAcceptScore);
        if (ver.ok || Date.now() > deadline) return ver;
        await sleep(cfg.stablePollIntervalMs);
      }
    }

    // bare directional scroll
    if (command.kind === "scroll" && !command.target) {
      const snap = await dev.stableSnapshot(3000);
      const containers = scrollContainers(snap);
      await dev.swipeDir(command.direction ?? "down", containers[0], snap);
      return { ok: true, detail: `scrolled ${command.direction}` };
    }

    // ---------- FIND ----------
    let before = await dev.stableSnapshot();
    let match = resolveTarget(command, before, cfg.matchAcceptScore,
      cfg.matchAcceptMargin, cfg.matchStrongScore);
    if (!confident(match) && command.kind !== "select") {
      [match, before] = await scrollToFind(dev, command, cfg);
    }
    if (!confident(match) && match.candidates.length) {
      const picked = await this.llmDisambiguate(command, match);
      if (picked) {
        match = { element: picked, score: 1, margin: 1, candidates: match.candidates };
        result.llmUsed = true;
      }
    }
    if (!confident(match)) {
      if (command.kind === "select" && !command.target) {
        // select can work from the option value alone
      } else if (cfg.enableVisionFallback) {
        return this.visionFallback(command, result);
      } else {
        return {
          ok: false,
          detail: `element not found for '${command.target}' ` +
                  `(best score ${match.score.toFixed(2)})`,
        };
      }
    }
    const el = match.element as UIElement;

    // ---------- ACT + VERIFY ----------
    if (command.kind === "tap" || command.kind === "long_press") {
      if (command.kind === "tap") await dev.tap(el);
      else await dev.longPress(el);
      const after = await dev.stableSnapshot();
      return V.verifyTap(before, after, el);
    }

    if (command.kind === "input" && !command.maybeDate) {
      await dev.typeText(el, command.value ?? "");
      const after = await dev.stableSnapshot(4000);
      const ver = V.verifyInput(after, el, command);
      if (ver.ok) await dev.hideKeyboard();
      return ver;
    }

    if (command.kind === "set_date" || (command.kind === "input" && command.maybeDate)) {
      const ok = await setDate(dev, command, cfg, before, el);
      if (!ok) return { ok: false, detail: "date picker interaction failed" };
      const after = await dev.stableSnapshot(4000);
      const d = parseDateValue(command.value ?? "", cfg.dayFirstDates);
      const variants: string[] = [];
      if (d) {
        const dd = String(d.day).padStart(2, "0");
        const mm = String(d.month).padStart(2, "0");
        const mon = MONTH_NAMES[d.month - 1];
        variants.push(
          `${dd}/${mm}/${d.year}`, `${mm}/${dd}/${d.year}`,
          `${dd} ${mon.slice(0, 3)} ${d.year}`, `${mon} ${d.day}, ${d.year}`,
          `${d.year}-${mm}-${dd}`, `${dd}-${mm}-${d.year}`,
        );
      }
      return V.verifyDateShown(after, el, variants);
    }

    if (command.kind === "toggle") {
      const ok = await setToggle(dev, el, command.toggleState);
      return {
        ok,
        detail: ok ? "toggle state verified" : "toggle did not reach desired state",
      };
    }

    if (command.kind === "select") {
      const ok = await selectOption(dev, command, cfg, match.element);
      if (!ok) return { ok: false, detail: `option '${command.value}' not found` };
      const after = await dev.stableSnapshot(4000);
      const probe: Command = {
        kind: "assert_visible", target: command.value,
        secure: false, maybeDate: false, raw: command.raw,
      };
      const shown = V.verifyVisible(after, probe, cfg.matchAcceptScore);
      return { ok: true, detail: `selected '${command.value}'`, weak: !shown.ok };
    }

    if (command.kind === "scroll") {
      // scroll to <target> — finding it IS the pass
      return { ok: true, detail: `scrolled to '${command.target}'` };
    }

    return { ok: false, detail: `unsupported command kind: ${command.kind}` };
  }

  // ---- LLM escalations ------------------------------------------------
  private async llmParse(text: string): Promise<Command | undefined> {
    let data: {
      kind?: CommandKind;
      target?: string | null;
      value?: string | null;
      direction?: Command["direction"] | null;
      toggle_state?: "on" | "off" | null;
    };
    try {
      data = await this.llm.chatJson(
        "You compile one mobile-UI test step into one JSON command. " +
        "kinds: tap, long_press, input, set_date, select, toggle, scroll, " +
        "assert_visible, assert_not_visible, wait, back, home, " +
        "hide_keyboard, launch, press_key. " +
        "target = element description; value = text/option/date.",
        text,
        COMMAND_SCHEMA,
      );
    } catch (err) {
      if (!(err instanceof LLMUnavailableError)) throw err;
      console.warn(`LLM parse unavailable: ${err.message}`);
      return undefined;
    }
    if (!data.kind) return undefined;
    return {
      kind: data.kind,
      target: data.target ?? undefined,
      value: data.value ?? undefined,
      direction: data.direction ?? undefined,
      toggleState: data.toggle_state ?? undefined,
      secure: false,
      maybeDate: false,
      raw: text,
    };
  }

  private async llmDisambiguate(
    command: Command, match: MatchResult,
  ): Promise<UIElement | undefined> {
    let data: { element_index: number | null };
    try {
      const table = match.candidates.map(brief).join("\n");
      data = await this.llm.chatJson(
        "Pick the UI element a test step refers to. Reply with its index, " +
        "or null if none of them match.",
        `Step: ${command.raw}\nCandidate elements:\n${table}`,
        DISAMBIG_SCHEMA,
      );
    } catch (err) {
      if (!(err instanceof LLMUnavailableError)) throw err;
      return undefined;
    }
    if (data.element_index === null || data.element_index === undefined) return undefined;
    return match.candidates.find((e) => e.index === data.element_index);
  }

  /** Last resort: appium-mcp's own vision tool acts from a screenshot. */
  private async visionFallback(
    command: Command, result: StepResult,
  ): Promise<V.Verification> {
    result.llmUsed = true;
    try {
      await this.mcp.call("ai", { instruction: command.raw });
      await this.dev.stableSnapshot();
      return { ok: true, detail: "performed via vision fallback", weak: true };
    } catch (err) {
      if (!(err instanceof ToolCallError)) throw err;
      return { ok: false, detail: `vision fallback failed: ${err.message}` };
    }
  }
}

// ---------------------------------------------------------------------------
export function loadFlow(path: string): string[] {
  const text = readFileSync(path, "utf8");
  if (/\.ya?ml$/.test(path)) {
    let data = YAML.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      data = data.steps ?? [];
    }
    return (data as unknown[]).map(String);
  }
  return text.split("\n").filter((line) => line.trim());
}

export async function run(cfg: Config, flowPath: string): Promise<RunReport> {
  const agent = new MobileTestAgent(cfg);
  await agent.start();
  let report: RunReport;
  try {
    report = await agent.runFlow(loadFlow(flowPath));
  } finally {
    await agent.close();
  }
  if (cfg.reportFile) {
    writeFileSync(cfg.reportFile, JSON.stringify(report, null, 2));
  }
  return report;
}
