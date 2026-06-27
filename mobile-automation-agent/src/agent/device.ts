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

/** A simple anchor used by relative selectors. */
export interface AnchorQuery {
  text?: string;
  id?: string;
  accessibilityId?: string;
}

export interface ElementQuery {
  text?: string;
  id?: string;
  accessibilityId?: string;
  /** disambiguate when several elements match (0-based). */
  index?: number;
  /** spatial constraints relative to another element (Maestro-style). */
  below?: AnchorQuery;
  above?: AnchorQuery;
  leftOf?: AnchorQuery;
  rightOf?: AnchorQuery;
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
    // Resolve any relative anchors first, then keep only candidates that satisfy
    // the spatial relation (e.g. "the field below the 'Email' label").
    const anchors = this.resolveAnchors(snapshot, query);
    let pool = snapshot.elements;
    for (const { el: anchor, relation } of anchors) {
      pool = pool.filter((cand) => cand !== anchor && satisfies(cand, anchor, relation));
    }

    const hasPrimary = Boolean(query.text || query.id || query.accessibilityId);
    if (!hasPrimary) {
      // Relative-only query: order by proximity to the (first) anchor.
      const anchor = anchors[0]?.el;
      if (!anchor) return [];
      return [...pool].sort((a, b) => distance(a, anchor) - distance(b, anchor));
    }

    const scored: Array<{ el: UiElement; score: number }> = [];
    for (const el of pool) {
      const score = scoreElement(el, query);
      if (score > 0) scored.push({ el, score });
    }
    scored.sort((a, b) => b.score - a.score || a.el.ref - b.el.ref);
    return scored.map((s) => s.el);
  }

  /** Resolve each present relative anchor to a concrete element. */
  private resolveAnchors(
    snapshot: UiSnapshot,
    query: ElementQuery,
  ): Array<{ el: UiElement; relation: Relation }> {
    const out: Array<{ el: UiElement; relation: Relation }> = [];
    const dirs: Array<[Relation, AnchorQuery | undefined]> = [
      ["below", query.below],
      ["above", query.above],
      ["leftOf", query.leftOf],
      ["rightOf", query.rightOf],
    ];
    for (const [relation, anchorQuery] of dirs) {
      if (!anchorQuery) continue;
      const el = this.match(snapshot, { ...anchorQuery })[0];
      if (el) out.push({ el, relation });
    }
    return out;
  }

  /**
   * Find the editable field associated with a (possibly non-editable) label.
   * Handles the common pattern of a static label sitting directly above an
   * unlabeled EditText / TextField. Returns the label itself if it is editable.
   */
  findInputFor(snapshot: UiSnapshot, label: UiElement): UiElement | undefined {
    if (isEditable(label)) return label;
    const fields = snapshot.elements.filter(isEditable);
    if (fields.length === 0) return undefined;

    // Prefer a field directly below the label and horizontally overlapping it,
    // with the smallest vertical gap (the field immediately under this label).
    const below = fields
      .filter((f) => isBelow(f, label) && horizontallyOverlaps(f, label))
      .sort((a, b) => topGap(a, label) - topGap(b, label));
    if (below.length > 0) return below[0];

    // Otherwise the nearest editable field by center distance.
    return [...fields].sort((a, b) => distance(a, label) - distance(b, label))[0];
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
    let label = "the focused field";
    let toolError = false;

    if (args.into) {
      const found = await this.waitForMatch(args.into);
      if (!found.element) {
        return { ok: false, message: `No input matched ${describe(args.into)}.`, snapshot: found.text };
      }
      // The match may be a static label above an unlabeled field — resolve to
      // the actual editable element.
      const field = this.findInputFor(found.snapshot, found.element) ?? found.element;
      label = describe(args.into) + (field !== found.element ? " (field below the label)" : "");

      const uuid = await this.resolveUuid(field);
      if (uuid) {
        const res = await this.mcp.callTool("appium_set_value", { elementUUID: uuid, text: args.text });
        toolError = res.isError;
      } else {
        // No locator (unlabeled field): focus by tapping its center, then type.
        if (field.c) await this.tapAt(field.c[0], field.c[1]);
        const res = await this.mcp.callTool("appium_set_value", { text: args.text, w3cActions: true });
        toolError = res.isError;
      }
    } else {
      const res = await this.mcp.callTool("appium_set_value", { text: args.text, w3cActions: true });
      toolError = res.isError;
    }

    const after = await this.waitForStableHierarchy();
    if (toolError) {
      return this.result(false, `Failed to enter text into ${label}.`, after, true);
    }

    // VERIFY: read the field's value back and confirm it took the input.
    const verdict = this.verifyInput(after, args.text, args.into);
    return this.result(verdict.ok, `${verdict.message} (${label})`, after, true);
  }

  /**
   * Independent verification that text actually landed in a field: re-locate the
   * field after typing and compare its value to what we sent (alphanumeric,
   * case-insensitive — tolerant of formatting/masks). Password fields can't be
   * read, so they're reported as unverifiable rather than failed.
   */
  private verifyInput(
    xml: string,
    expected: string,
    into?: ElementQuery,
  ): { ok: boolean; message: string } {
    const snapshot = buildSnapshot(xml, this.opts.platform);
    let field: UiElement | undefined;
    if (into) {
      const match = this.match(snapshot, into)[0];
      if (match) field = this.findInputFor(snapshot, match) ?? match;
    } else {
      field =
        snapshot.elements.find((e) => e.state?.includes("focused") && isEditable(e)) ??
        snapshot.elements.find(isEditable);
    }

    if (!field) return { ok: true, message: `Entered "${expected}"; could not re-locate field to verify` };
    if (field.state?.includes("password")) {
      return { ok: true, message: `Entered text into a password field (value hidden, not verified)` };
    }

    const actual = field.val ?? field.text ?? "";
    if (containsNormalized(actual, expected)) {
      return { ok: true, message: `Entered & verified "${expected}" (field shows "${actual}")` };
    }
    return {
      ok: false,
      message: `Verification FAILED: typed "${expected}" but field shows "${actual}"`,
    };
  }

  /** Quick boolean visibility check (used by step-level assertions). */
  async isVisible(query: ElementQuery, timeoutMs?: number): Promise<boolean> {
    const found = await this.waitForMatch(query, timeoutMs ?? this.opts.findTimeoutMs);
    return Boolean(found.element);
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

/** Arguments accepted by the high-level reliable actions. */
export type ReliableActionArgs = ElementQuery & {
  x?: number;
  y?: number;
  text?: string;
  to?: "on" | "off";
  into?: ElementQuery;
  clear?: boolean;
  timeoutMs?: number;
  direction?: "up" | "down" | "left" | "right";
  maxScrolls?: number;
};

/**
 * Dispatch a reliable-action by name to the DeviceController. Shared by the
 * agent loop and the deterministic replay engine so both behave identically.
 */
export function dispatchAction(
  device: DeviceController,
  name: string,
  args: Record<string, unknown>,
): Promise<ActionResult> {
  const q = args as ReliableActionArgs;
  switch (name) {
    case "tap":
      return device.tap(q);
    case "input_text":
      return device.inputText({ text: q.text ?? "", into: q.into, clear: q.clear });
    case "assert_visible":
      return device.assertVisible(q, q.timeoutMs);
    case "scroll_until_visible":
      return device.scrollUntilVisible(q);
    case "toggle":
      return device.toggle({ text: q.text ?? "", to: q.to });
    case "back":
      return device.back();
    default:
      return Promise.resolve({ ok: false, message: `Unknown action ${name}`, snapshot: "" });
  }
}

type Relation = "below" | "above" | "leftOf" | "rightOf";

function isEditable(el: UiElement): boolean {
  // The snapshot sets the `editable` flag per-platform (Android EditText; iOS
  // TextField/SecureTextField/SearchField/TextView), which is authoritative.
  // The role check is only a fallback and deliberately excludes Android's
  // static TextView.
  if (el.state?.includes("editable")) return true;
  return /EditText|TextField|SecureTextField|SearchField/i.test(el.role);
}

function centerOf(el: UiElement): [number, number] | undefined {
  if (el.c) return el.c;
  if (el.b) return [(el.b[0] + el.b[2]) / 2, (el.b[1] + el.b[3]) / 2];
  return undefined;
}

function distance(a: UiElement, b: UiElement): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  if (!ca || !cb) return Number.POSITIVE_INFINITY;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}

/** Candidate is below the anchor (its center sits beneath the anchor's center). */
function isBelow(cand: UiElement, anchor: UiElement): boolean {
  const c = centerOf(cand);
  const a = centerOf(anchor);
  return !!c && !!a && c[1] > a[1];
}

/** Vertical gap from the anchor's bottom to the candidate's top. */
function topGap(cand: UiElement, anchor: UiElement): number {
  const top = cand.b ? cand.b[1] : centerOf(cand)?.[1] ?? 0;
  const bottom = anchor.b ? anchor.b[3] : centerOf(anchor)?.[1] ?? 0;
  return Math.abs(top - bottom);
}

/** Candidate's horizontal span overlaps the anchor's (same column). */
function horizontallyOverlaps(cand: UiElement, anchor: UiElement): boolean {
  if (!cand.b || !anchor.b) {
    const c = centerOf(cand);
    const a = centerOf(anchor);
    return !!c && !!a && Math.abs(c[0] - a[0]) < 200;
  }
  return cand.b[0] < anchor.b[2] && cand.b[2] > anchor.b[0];
}

/** Does a candidate satisfy a spatial relation to the anchor? */
function satisfies(cand: UiElement, anchor: UiElement, relation: Relation): boolean {
  const c = centerOf(cand);
  const a = centerOf(anchor);
  if (!c || !a) return false;
  switch (relation) {
    case "below":
      return c[1] > a[1] && horizontallyOverlaps(cand, anchor);
    case "above":
      return c[1] < a[1] && horizontallyOverlaps(cand, anchor);
    case "rightOf":
      return c[0] > a[0] && verticallyOverlaps(cand, anchor);
    case "leftOf":
      return c[0] < a[0] && verticallyOverlaps(cand, anchor);
  }
}

function verticallyOverlaps(cand: UiElement, anchor: UiElement): boolean {
  if (!cand.b || !anchor.b) {
    const c = centerOf(cand);
    const a = centerOf(anchor);
    return !!c && !!a && Math.abs(c[1] - a[1]) < 120;
  }
  return cand.b[1] < anchor.b[3] && cand.b[3] > anchor.b[1];
}

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

/** Tolerant containment: compare alphanumerics only, case-insensitive. */
function containsNormalized(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const h = norm(haystack);
  const n = norm(needle);
  if (n.length === 0) return true;
  return h.includes(n);
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
