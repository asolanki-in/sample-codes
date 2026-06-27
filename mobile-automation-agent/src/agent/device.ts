/**
 * Maestro-inspired reliability layer.
 *
 * Maestro is reliable not because of clever AI, but because every interaction is
 * wrapped in deterministic robustness:
 *   1. wait for the UI to *settle* (stop changing) before observing or acting,
 *   2. an *implicit wait* for the target element to appear (no manual sleeps),
 *   3. *tolerant* element matching (substring / case-insensitive / accessibility),
 *   4. *verify-and-retry*: after a tap, confirm the hierarchy actually changed,
 *      and retry the tap if it didn't.
 *
 * This controller ports those behaviours on top of appium-mcp so our agent gets
 * the same stability. The LLM calls high-level tools (tap / input_text /
 * assert_visible / scroll_until_visible / toggle / back); the determinism lives
 * here, not in the model.
 */

import type { Logger } from "../logger.js";
import type { AppiumMcpClient } from "../mcp/appiumClient.js";
import {
  buildSnapshot,
  renderSnapshot,
  type UiElement,
  type UiSnapshot,
} from "../mcp/uiSnapshot.js";
import type { Platform } from "../types.js";

export interface DeviceOptions {
  platform: Platform;
  settleTimeoutMs: number;
  findTimeoutMs: number;
  settleIntervalMs?: number;
  settleStableCount?: number;
  tapMaxRetries?: number;
}

export interface ElementQuery {
  text?: string;
  id?: string;
  accessibilityId?: string;
  /** disambiguate when several elements match (0-based). */
  index?: number;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Fresh, settled snapshot text to feed back to the model. */
  snapshot: string;
}

export class DeviceController {
  private readonly log: Logger;
  private readonly settleIntervalMs: number;
  private readonly settleStableCount: number;
  private readonly tapMaxRetries: number;

  constructor(
    private readonly mcp: AppiumMcpClient,
    private readonly opts: DeviceOptions,
    logger: Logger,
  ) {
    this.log = logger.child("device");
    this.settleIntervalMs = opts.settleIntervalMs ?? 350;
    this.settleStableCount = opts.settleStableCount ?? 2;
    this.tapMaxRetries = opts.tapMaxRetries ?? 2;
  }

  // --- observation -------------------------------------------------------

  /** Page source as text, or "" if unavailable. */
  private async pageSource(): Promise<string> {
    const res = await this.mcp.callTool("appium_get_page_source", {});
    return res.isError ? "" : res.text ?? "";
  }

  /**
   * Poll the view hierarchy until it stops changing (stable for N consecutive
   * reads) or the timeout elapses. Returns the last hierarchy XML. This is the
   * deterministic replacement for sleeps after navigation/animation.
   */
  async waitForStableHierarchy(timeoutMs = this.opts.settleTimeoutMs): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let prev = await this.pageSource();
    let stable = 1;
    while (Date.now() < deadline) {
      await delay(this.settleIntervalMs);
      const cur = await this.pageSource();
      if (cur && cur === prev) {
        stable += 1;
        if (stable >= this.settleStableCount) return cur;
      } else {
        stable = 1;
        prev = cur;
      }
    }
    this.log.debug("hierarchy did not fully settle before timeout");
    return prev;
  }

  /** Settle, then return a compact snapshot (object + rendered text). */
  async snapshot(): Promise<{ snapshot: UiSnapshot; xml: string; text: string }> {
    const xml = await this.waitForStableHierarchy();
    const snapshot = buildSnapshot(xml, this.opts.platform);
    return { snapshot, xml, text: renderSnapshot(snapshot) };
  }

  // --- matching ----------------------------------------------------------

  /**
   * Tolerant matching against the snapshot: case-insensitive, exact > prefix >
   * substring, with a small bonus for interactive elements. Mirrors Maestro's
   * forgiving text/accessibility matching.
   */
  match(snapshot: UiSnapshot, query: ElementQuery): UiElement[] {
    const scored: Array<{ el: UiElement; score: number }> = [];
    for (const el of snapshot.elements) {
      const score = scoreElement(el, query);
      if (score > 0) scored.push({ el, score });
    }
    scored.sort((a, b) => b.score - a.score || a.el.ref - b.el.ref);
    return scored.map((s) => s.el);
  }

  /** Implicit-wait for a matching element to appear; returns it + the snapshot. */
  private async waitForMatch(
    query: ElementQuery,
    timeoutMs = this.opts.findTimeoutMs,
  ): Promise<{ element?: UiElement; snapshot: UiSnapshot; text: string }> {
    const deadline = Date.now() + timeoutMs;
    let last: { snapshot: UiSnapshot; text: string } | null = null;
    const index = query.index ?? 0;
    do {
      const { snapshot, text } = await this.snapshot();
      last = { snapshot, text };
      const matches = this.match(snapshot, query);
      if (matches.length > index) {
        return { element: matches[index], snapshot, text };
      }
    } while (Date.now() < deadline);
    return { element: undefined, snapshot: last!.snapshot, text: last!.text };
  }

  // --- actions -----------------------------------------------------------

  /**
   * Tap an element (or raw coordinates). Verifies the UI changed and retries the
   * tap if it didn't — Maestro's `retryIfNoChange` behaviour.
   */
  async tap(args: ElementQuery & { x?: number; y?: number }): Promise<ActionResult> {
    if (typeof args.x === "number" && typeof args.y === "number") {
      const before = await this.pageSource();
      await this.tapAt(args.x, args.y);
      const after = await this.waitForStableHierarchy();
      return this.result(true, `Tapped (${args.x}, ${args.y}).`, after, before !== after);
    }

    const found = await this.waitForMatch(args);
    if (!found.element) {
      return { ok: false, message: `No element matched ${describe(args)}.`, snapshot: found.text };
    }

    let element = found.element;

    for (let attempt = 0; attempt <= this.tapMaxRetries; attempt++) {
      const point = element.c;
      if (!point) {
        // No center (rare): fall back to a locator tap via find_element + UUID.
        const viaLocator = await this.tapViaLocator(element);
        const after = await this.waitForStableHierarchy();
        return this.result(viaLocator, `Tapped ${describe(args)} via locator.`, after, true);
      }

      const before = await this.pageSource();
      await this.tapAt(point[0], point[1]);
      const after = await this.waitForStableHierarchy();

      if (before !== after) {
        return this.result(true, `Tapped ${describe(args)} (ref ${element.ref}).`, after, true);
      }

      // No change: re-locate (it may have moved) and retry.
      const reMatch = this.match(buildSnapshot(after, this.opts.platform), args);
      const next = reMatch[args.index ?? 0];
      if (!next) break;
      element = next;
      this.log.debug(`tap produced no change, retry ${attempt + 1}`);
    }

    const final = await this.waitForStableHierarchy();
    return this.result(
      true,
      `Tapped ${describe(args)} (ref ${element.ref}); no UI change detected after retries — it may be a no-op or an in-place toggle.`,
      final,
      false,
    );
  }

  /**
   * Enter text. When `into` is given we resolve the field and use Appium's
   * setValue (focuses + replaces); otherwise we type into the focused element.
   */
  async inputText(args: { text: string; into?: ElementQuery; clear?: boolean }): Promise<ActionResult> {
    if (args.into) {
      const found = await this.waitForMatch(args.into);
      if (!found.element) {
        return { ok: false, message: `No input matched ${describe(args.into)}.`, snapshot: found.text };
      }
      const uuid = await this.resolveUuid(found.element);
      if (uuid) {
        const res = await this.mcp.callTool("appium_set_value", { elementUUID: uuid, text: args.text });
        const after = await this.waitForStableHierarchy();
        return this.result(!res.isError, `Entered text into ${describe(args.into)}.`, after, true);
      }
      // No locator: focus by tapping its center, then type into focus.
      if (found.element.c) await this.tapAt(found.element.c[0], found.element.c[1]);
    }

    const res = await this.mcp.callTool("appium_set_value", { text: args.text, w3cActions: true });
    const after = await this.waitForStableHierarchy();
    return this.result(!res.isError, `Typed "${args.text}" into the focused field.`, after, true);
  }

  /** Poll until an element is visible, or fail after the timeout. */
  async assertVisible(query: ElementQuery, timeoutMs?: number): Promise<ActionResult> {
    const found = await this.waitForMatch(query, timeoutMs ?? this.opts.findTimeoutMs);
    if (found.element) {
      return { ok: true, message: `Visible: ${describe(query)} (ref ${found.element.ref}).`, snapshot: found.text };
    }
    return { ok: false, message: `Not visible within timeout: ${describe(query)}.`, snapshot: found.text };
  }

  /** Scroll in a direction until the element appears (delegates to appium scroll_to_element). */
  async scrollUntilVisible(args: {
    text?: string;
    id?: string;
    accessibilityId?: string;
    direction?: "up" | "down" | "left" | "right";
    maxScrolls?: number;
  }): Promise<ActionResult> {
    const query: ElementQuery = { text: args.text, id: args.id, accessibilityId: args.accessibilityId };
    // Already on screen?
    const pre = await this.snapshot();
    if (this.match(pre.snapshot, query).length > 0) {
      return { ok: true, message: `Already visible: ${describe(query)}.`, snapshot: pre.text };
    }

    const locator = this.queryLocator(query);
    if (locator) {
      await this.mcp.callTool("appium_gesture", {
        action: "scroll_to_element",
        strategy: locator.strategy,
        selector: locator.selector,
        direction: args.direction ?? "down",
        maxScrollAttempts: args.maxScrolls ?? 10,
      });
    }
    const found = await this.waitForMatch(query, 2000);
    return found.element
      ? { ok: true, message: `Scrolled to ${describe(query)}.`, snapshot: found.text }
      : { ok: false, message: `Could not reveal ${describe(query)} by scrolling.`, snapshot: found.text };
  }

  /** State-aware toggle: only taps when the current state differs from desired. */
  async toggle(args: { text: string; to?: "on" | "off" }): Promise<ActionResult> {
    const found = await this.waitForMatch({ text: args.text });
    // Maybe the switch has no label; fall back to the nearest checkable element.
    const el =
      found.element ?? found.snapshot.elements.find((e) => e.state?.includes("checkable"));
    if (!el) {
      return { ok: false, message: `No toggle matched "${args.text}".`, snapshot: found.text };
    }
    const isOn = el.state?.includes("checked") ?? false;
    const desired = args.to === "on" ? true : args.to === "off" ? false : !isOn;

    if (isOn === desired) {
      return { ok: true, message: `Toggle "${args.text}" already ${desired ? "on" : "off"}.`, snapshot: found.text };
    }
    if (el.c) await this.tapAt(el.c[0], el.c[1]);
    const after = await this.waitForStableHierarchy();
    const reMatch = this.match(buildSnapshot(after, this.opts.platform), { text: args.text })[0];
    const nowOn = reMatch?.state?.includes("checked") ?? desired;
    return this.result(
      nowOn === desired,
      `Toggled "${args.text}" → ${desired ? "on" : "off"} (now ${nowOn ? "on" : "off"}).`,
      after,
      true,
    );
  }

  /** System back, then settle. */
  async back(): Promise<ActionResult> {
    await this.mcp.callTool("appium_gesture", { action: "back" });
    const after = await this.waitForStableHierarchy();
    return this.result(true, "Navigated back.", after, true);
  }

  // --- low-level helpers -------------------------------------------------

  private async tapAt(x: number, y: number): Promise<void> {
    await this.mcp.callTool("appium_gesture", { action: "tap", x: Math.round(x), y: Math.round(y) });
  }

  private async tapViaLocator(el: UiElement): Promise<boolean> {
    const uuid = await this.resolveUuid(el);
    if (!uuid) return false;
    const res = await this.mcp.callTool("appium_gesture", { action: "tap", elementUUID: uuid });
    return !res.isError;
  }

  /** Resolve an element to an Appium UUID via its precomputed locator. */
  private async resolveUuid(el: UiElement): Promise<string | undefined> {
    if (!el.by) return undefined;
    const res = await this.mcp.callTool("appium_find_element", {
      strategy: el.by.strategy,
      selector: el.by.selector,
    });
    if (res.isError) return undefined;
    return extractUuid(res.text);
  }

  /** Build an Appium locator from a free-text query (for scroll_to_element). */
  private queryLocator(q: ElementQuery): { strategy: string; selector: string } | undefined {
    if (q.accessibilityId) return { strategy: "accessibility id", selector: q.accessibilityId };
    if (q.id) return { strategy: "id", selector: q.id };
    if (q.text) {
      if (this.opts.platform === "ios") {
        return {
          strategy: "-ios predicate string",
          selector: `label CONTAINS[c] ${jstr(q.text)} OR name CONTAINS[c] ${jstr(q.text)} OR value CONTAINS[c] ${jstr(q.text)}`,
        };
      }
      return {
        strategy: "-android uiautomator",
        selector: `new UiSelector().textContains(${jstr(q.text)})`,
      };
    }
    return undefined;
  }

  private result(ok: boolean, message: string, xml: string, changed: boolean): ActionResult {
    const snapshot = renderSnapshot(buildSnapshot(xml, this.opts.platform));
    const note = changed ? "" : " (no UI change)";
    return { ok, message: message + note, snapshot };
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function scoreElement(el: UiElement, query: ElementQuery): number {
  let best = 0;
  if (query.accessibilityId) best = Math.max(best, fieldScore(el.acc, query.accessibilityId, true));
  if (query.id) best = Math.max(best, fieldScore(el.id, query.id, false));
  if (query.text) {
    for (const field of [el.text, el.acc, el.val, el.id]) {
      best = Math.max(best, fieldScore(field, query.text, false));
    }
  }
  if (best > 0 && el.state) {
    if (/clickable|checkable|editable/.test(el.state)) best += 5;
  }
  return best;
}

function fieldScore(value: string | undefined, query: string, exactOnly: boolean): number {
  if (!value) return 0;
  const v = value.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (v === q) return 100;
  if (exactOnly) return 0;
  if (v.startsWith(q)) return 70;
  if (v.includes(q)) return 40;
  return 0;
}

function describe(q: ElementQuery): string {
  const parts: string[] = [];
  if (q.text) parts.push(`text~"${q.text}"`);
  if (q.id) parts.push(`id~"${q.id}"`);
  if (q.accessibilityId) parts.push(`acc="${q.accessibilityId}"`);
  if (q.index) parts.push(`#${q.index}`);
  return parts.join(" ") || "(element)";
}

/** Extract an Appium element UUID from a find_element result, tolerant of format. */
function extractUuid(text: string): string | undefined {
  try {
    const obj = JSON.parse(text);
    for (const key of ["uuid", "elementUUID", "elementId", "ELEMENT", "value", "id"]) {
      const v = (obj as Record<string, unknown>)?.[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    // not JSON
  }
  const m = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m?.[0];
}

function jstr(value: string): string {
  return JSON.stringify(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
