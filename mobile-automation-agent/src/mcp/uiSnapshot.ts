/**
 * Compact UI snapshot.
 *
 * Raw Appium page-source XML is verbose and token-hungry: a single screen is
 * routinely 5-20k tokens, full of layout containers and attributes the model
 * never needs. Feeding that to the LLM is slow, expensive, and error-prone
 * (and truncation can drop the very element you want).
 *
 * Instead we parse the XML once, keep only *actionable* elements (things with
 * text/ids or that are clickable/editable/checkable/scrollable), and emit a
 * small JSON list where each element carries:
 *   - a short `ref` number,
 *   - the few attributes that matter (text, id, accessibility id, value, state),
 *   - a tap-point (`c`: center x,y), and
 *   - a precomputed, prioritised locator (`by`: strategy + selector).
 *
 * The precomputed locator is the key bit: the model no longer has to *invent* a
 * strategy, it just uses the one we already derived using the recommended
 * priority (accessibility id > resource-id/name > text/predicate > xpath). This
 * makes element finding both cheaper and far more reliable.
 *
 * Works for Android (UiAutomator2 `<node class=.. bounds=..>`) and iOS
 * (XCUITest `<XCUIElementType.. x= y= width= height=>`).
 */

import { XMLParser } from "fast-xml-parser";
import type { Platform } from "../types.js";

export interface Locator {
  strategy: string;
  selector: string;
}

export interface UiElement {
  ref: number;
  /** Short role/class, e.g. "Button", "EditText", "Switch". */
  role: string;
  text?: string;
  /** resource-id (Android) — appium strategy "id". */
  id?: string;
  /** content-desc (Android) / name (iOS) — accessibility id. */
  acc?: string;
  /** value/content of inputs and toggles. */
  val?: string;
  /** compact state flags, space separated (e.g. "clickable checked"). */
  state?: string;
  /** center point [x, y] for coordinate taps as a fallback. */
  c?: [number, number];
  /**
   * bounding box [x1, y1, x2, y2]. Kept for internal spatial reasoning
   * (relative selectors, label→input association) and stripped from the text
   * we send to the model to save tokens.
   */
  b?: [number, number, number, number];
  /** recommended locator for appium_find_element. */
  by?: Locator;
}

export interface UiSnapshot {
  platform: Platform;
  /** screen size [width, height] when known. */
  size?: [number, number];
  count: number;
  /** true when the list was capped (more elements existed). */
  truncated: boolean;
  elements: UiElement[];
}

const DEFAULT_MAX_ELEMENTS = 120;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Parse Appium page-source XML into a compact snapshot. */
export function buildSnapshot(
  xml: string,
  platform: Platform,
  maxElements: number = DEFAULT_MAX_ELEMENTS,
): UiSnapshot {
  let roots: PreservedNode[];
  try {
    roots = parser.parse(xml) as PreservedNode[];
  } catch {
    // Fall back to an empty snapshot rather than throwing into the agent loop.
    return { platform, count: 0, truncated: false, elements: [] };
  }

  const out: UiElement[] = [];
  let size: [number, number] | undefined;
  let ref = 0;
  let truncated = false;

  const visit = (node: PreservedNode): void => {
    if (out.length >= maxElements) {
      truncated = true;
      return;
    }
    const tag = tagOf(node);
    if (!tag) return;
    const attrs = node[":@"] ?? {};
    const children = (node[tag] as PreservedNode[]) ?? [];

    // Capture screen size from the root container the first time we see bounds.
    if (!size) {
      const s = readSize(attrs, platform);
      if (s) size = s;
    }

    const element = platform === "ios" ? toIosElement(attrs, tag) : toAndroidElement(attrs);
    if (element) {
      element.ref = ++ref;
      out.push(element);
    }

    for (const child of children) {
      if (typeof child === "object" && child !== null) visit(child);
    }
  };

  for (const root of roots) visit(root);

  return { platform, size, count: out.length, truncated, elements: out };
}

/** Render a snapshot as the compact text we hand to the model. */
export function renderSnapshot(snapshot: UiSnapshot): string {
  const header =
    `UI_SNAPSHOT ${snapshot.platform}` +
    (snapshot.size ? ` size=${snapshot.size[0]}x${snapshot.size[1]}` : "") +
    ` elements=${snapshot.count}${snapshot.truncated ? "(capped)" : ""}`;
  // `b` (bounding box) is for internal spatial reasoning only — strip it to
  // keep the model payload small; `c` (center) stays for coordinate taps.
  const body = JSON.stringify(snapshot.elements, (key, value) =>
    key === "b" ? undefined : value,
  );
  return `${header}\n${body}`;
}

/** Marker used so old snapshots can be pruned from history. */
export const SNAPSHOT_MARKER = "UI_SNAPSHOT";

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

function toAndroidElement(attrs: Attrs): UiElement | null {
  const text = clean(attrs.text);
  const desc = clean(attrs["content-desc"]);
  const resourceId = clean(attrs["resource-id"]);
  const cls = clean(attrs.class) ?? "";

  const clickable = attrs.clickable === "true";
  const longClickable = attrs["long-clickable"] === "true";
  const checkable = attrs.checkable === "true";
  const scrollable = attrs.scrollable === "true";
  const enabled = attrs.enabled !== "false";
  const checked = attrs.checked === "true";
  const selected = attrs.selected === "true";
  const focused = attrs.focused === "true";
  const isPassword = attrs.password === "true";

  const interactive =
    clickable || longClickable || checkable || scrollable || /EditText/i.test(cls);
  const informative = Boolean(text || desc);

  // Skip pure layout/containers that carry no useful info.
  if (!interactive && !informative && !resourceId) return null;

  const el: UiElement = { ref: 0, role: shortRole(cls) };
  if (text) el.text = text;
  if (desc) el.acc = desc;
  if (resourceId) el.id = resourceId;

  const box = boxFromBounds(attrs.bounds);
  if (box) {
    el.b = box;
    el.c = [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)];
  }

  const state = [
    clickable ? "clickable" : "",
    checkable ? "checkable" : "",
    checked ? "checked" : "",
    selected ? "selected" : "",
    scrollable ? "scrollable" : "",
    /EditText/i.test(cls) ? "editable" : "",
    isPassword ? "password" : "",
    enabled ? "" : "disabled",
    focused ? "focused" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (state) el.state = state;

  el.by = androidLocator({ desc, resourceId, text, cls });
  return el;
}

function androidLocator(p: {
  desc?: string;
  resourceId?: string;
  text?: string;
  cls: string;
}): Locator | undefined {
  if (p.desc) return { strategy: "accessibility id", selector: p.desc };
  if (p.resourceId) return { strategy: "id", selector: p.resourceId };
  if (p.text) {
    return {
      strategy: "-android uiautomator",
      selector: `new UiSelector().text(${jstr(p.text)})`,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// iOS
// ---------------------------------------------------------------------------

function toIosElement(attrs: Attrs, tag: string): UiElement | null {
  const type = clean(attrs.type) ?? tag;
  const name = clean(attrs.name);
  const label = clean(attrs.label);
  const value = clean(attrs.value);
  const visible = attrs.visible !== "false";
  const enabled = attrs.enabled !== "false";

  const role = shortRole(type);
  // Structural containers are never tap targets - skip them.
  if (STRUCTURAL_IOS.has(role)) return null;

  const interactive = INTERACTIVE_IOS.has(role) || /button|cell|switch|field|segment|slider/i.test(role);
  const informative = Boolean(name || label || value);

  if (!visible) return null;
  if (!interactive && !informative) return null;

  const el: UiElement = { ref: 0, role };
  if (label && label !== name) el.text = label;
  if (name) el.acc = name;
  if (value) el.val = value;

  const box = boxFromXywh(attrs);
  if (box) {
    el.b = box;
    el.c = [Math.round((box[0] + box[2]) / 2), Math.round((box[1] + box[3]) / 2)];
  }

  const state = [
    interactive ? "clickable" : "",
    /switch/i.test(role) ? "checkable" : "",
    value === "1" || value === "true" ? "checked" : "",
    /field|searchfield|textview/i.test(role) ? "editable" : "",
    enabled ? "" : "disabled",
  ]
    .filter(Boolean)
    .join(" ");
  if (state) el.state = state;

  el.by = iosLocator({ name, label, value });
  return el;
}

const STRUCTURAL_IOS = new Set(["Application", "Window"]);

const INTERACTIVE_IOS = new Set([
  "Button",
  "Cell",
  "Switch",
  "TextField",
  "SecureTextField",
  "SearchField",
  "Slider",
  "Link",
  "MenuItem",
  "Tab",
  "PickerWheel",
]);

function iosLocator(p: { name?: string; label?: string; value?: string }): Locator | undefined {
  if (p.name) return { strategy: "accessibility id", selector: p.name };
  if (p.label) {
    return { strategy: "-ios predicate string", selector: `label == ${jstr(p.label)}` };
  }
  if (p.value) {
    return { strategy: "-ios predicate string", selector: `value == ${jstr(p.value)}` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>;
interface PreservedNode {
  ":@"?: Attrs;
  [key: string]: unknown;
}

function tagOf(node: PreservedNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  return undefined;
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Shorten android.widget.Button -> Button, XCUIElementTypeButton -> Button. */
function shortRole(cls: string): string {
  let r = cls.replace(/^XCUIElementType/, "");
  const dot = r.lastIndexOf(".");
  if (dot >= 0) r = r.slice(dot + 1);
  return r || "View";
}

/** Android bounds "[x1,y1][x2,y2]" -> box [x1, y1, x2, y2]. */
function boxFromBounds(bounds: string | undefined): [number, number, number, number] | undefined {
  if (!bounds) return undefined;
  const m = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** iOS x/y/width/height -> box [x1, y1, x2, y2]. */
function boxFromXywh(attrs: Attrs): [number, number, number, number] | undefined {
  const x = Number(attrs.x);
  const y = Number(attrs.y);
  const w = Number(attrs.width);
  const h = Number(attrs.height);
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return undefined;
  return [x, y, x + w, y + h];
}

function readSize(attrs: Attrs, platform: Platform): [number, number] | undefined {
  if (platform === "ios") {
    const w = Number(attrs.width);
    const h = Number(attrs.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return [w, h];
    return undefined;
  }
  const m = attrs.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return undefined;
  return [Number(m[3]), Number(m[4])];
}

/** JSON-string-escape a selector value (handles quotes safely). */
function jstr(value: string): string {
  return JSON.stringify(value);
}
