/**
 * UI snapshot: page-source XML -> distilled element table.
 *
 * This is where the token savings come from. A raw Appium page source is
 * 20–100 KB of XML; the LLM never sees it. We parse it into a compact
 * indexed table of *interactive-or-labelled* elements (typically 5–10% of
 * the raw size), which is:
 *
 *   1. matched deterministically first (0 tokens), and
 *   2. only shown to the LLM — truncated — when matching is ambiguous.
 *
 * The snapshot hash doubles as Maestro-style "UI is idle" detection: we
 * poll until two consecutive hashes agree instead of ever sleeping blind.
 */
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { Platform } from "./config.js";

export const ANDROID_EDITABLE = new Set([
  "android.widget.EditText", "android.widget.AutoCompleteTextView",
  "android.widget.MultiAutoCompleteTextView",
]);
export const IOS_EDITABLE = new Set([
  "XCUIElementTypeTextField", "XCUIElementTypeSecureTextField",
  "XCUIElementTypeTextView", "XCUIElementTypeSearchField",
]);
export const IOS_CHECKABLE = new Set(["XCUIElementTypeSwitch", "XCUIElementTypeToggle"]);
export const IOS_PICKER = new Set([
  "XCUIElementTypePickerWheel", "XCUIElementTypeDatePicker", "XCUIElementTypePicker",
]);
export const ANDROID_PICKER = new Set([
  "android.widget.DatePicker", "android.widget.TimePicker",
  "android.widget.NumberPicker", "android.widget.CalendarView",
  "android.widget.Spinner",
]);
const IOS_CLICKABLE = new Set([
  "XCUIElementTypeButton", "XCUIElementTypeCell", "XCUIElementTypeLink",
  "XCUIElementTypeImage", "XCUIElementTypeStaticText",
]);
const IOS_SCROLLABLE = new Set([
  "XCUIElementTypeScrollView", "XCUIElementTypeTable", "XCUIElementTypeCollectionView",
]);

export type Bounds = [left: number, top: number, right: number, bottom: number];

export interface UIElement {
  index: number;
  tag: string;                  // short class, e.g. "EditText" / "Button"
  fullTag: string;
  text: string;
  desc: string;                 // content-desc (Android) / label (iOS)
  resId: string;                // resource-id (Android) / name (iOS)
  hint: string;
  value: string;
  bounds: Bounds;
  clickable: boolean;
  enabled: boolean;
  editable: boolean;
  checkable: boolean;
  checked?: boolean;
  password: boolean;
  scrollable: boolean;
  selected: boolean;
  displayed: boolean;
}

export const center = (el: UIElement): [number, number] => [
  Math.floor((el.bounds[0] + el.bounds[2]) / 2),
  Math.floor((el.bounds[1] + el.bounds[3]) / 2),
];

export const area = (el: UIElement): number =>
  Math.max(0, el.bounds[2] - el.bounds[0]) * Math.max(0, el.bounds[3] - el.bounds[1]);

export const resIdTail = (el: UIElement): string =>
  el.resId ? el.resId.split("/").pop()! : "";

/** Identity+state string used for screen-change hashing. */
const stateKey = (el: UIElement): string =>
  [
    el.tag, resIdTail(el), el.text.slice(0, 40), el.desc.slice(0, 40),
    el.value.slice(0, 40), String(el.checked), String(el.selected),
  ].join("|");

/** One compact line for LLM disambiguation prompts. */
export function brief(el: UIElement): string {
  const bits = [`[${el.index}] ${el.tag}`];
  if (el.text) bits.push(`text="${el.text.slice(0, 60)}"`);
  if (el.desc && el.desc !== el.text) bits.push(`desc="${el.desc.slice(0, 60)}"`);
  if (el.hint) bits.push(`hint="${el.hint.slice(0, 40)}"`);
  const tail = resIdTail(el);
  if (tail) bits.push(`id=${tail}`);
  if (el.value && el.value !== el.text) bits.push(`value="${el.value.slice(0, 40)}"`);
  const flags: string[] = [];
  if (el.editable) flags.push("editable");
  if (el.password) flags.push("secure");
  if (el.checkable || el.checked !== undefined) {
    flags.push(`checked=${el.checked ? "on" : "off"}`);
  }
  if (el.scrollable) flags.push("scrollable");
  if (el.selected) flags.push("selected");
  if (!el.enabled) flags.push("disabled");
  if (flags.length) bits.push(`(${flags.join(",")})`);
  return bits.join(" ");
}

export interface Snapshot {
  elements: UIElement[];
  screenSize: [number, number];
  hash: string;
  platform: Platform;
}

export function listing(snap: Snapshot, maxChars = 6000): string {
  // interactive elements first so truncation drops decoration, not targets
  const ordered = [...snap.elements].sort((a, b) => {
    const ia = a.clickable || a.editable || a.checkable ? 0 : 1;
    const ib = b.clickable || b.editable || b.checkable ? 0 : 1;
    return ia - ib || a.index - b.index;
  });
  const lines: string[] = [];
  let used = 0;
  for (const el of ordered) {
    const line = brief(el);
    if (used + line.length + 1 > maxChars) {
      lines.push("... (truncated)");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export const scrollContainers = (snap: Snapshot): UIElement[] =>
  snap.elements.filter((e) => e.scrollable).sort((a, b) => area(b) - area(a));

// ---------------------------------------------------------------------------

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

const parseBounds = (val: string): Bounds => {
  const m = BOUNDS_RE.exec(val ?? "");
  return m ? [+m[1], +m[2], +m[3], +m[4]] : [0, 0, 0, 0];
};

const shortTag = (tag: string): string => {
  const t = tag.split(".").pop()!;
  return t.startsWith("XCUIElementType") ? t.slice("XCUIElementType".length) : t;
};

const asBool = (v: unknown): boolean => String(v ?? "").toLowerCase() === "true";
const notFalse = (v: unknown): boolean =>
  String(v ?? "true").toLowerCase() !== "false";

type XmlNode = Record<string, unknown>;

function* walk(node: XmlNode, name: string): Generator<[string, XmlNode]> {
  yield [name, node];
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text") continue;
    for (const child of Array.isArray(val) ? val : [val]) {
      if (child && typeof child === "object") {
        yield* walk(child as XmlNode, key);
      }
    }
  }
}

export function parsePageSource(xmlText: string, platform: Platform = "android"): Snapshot {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    parseTagValue: false,
  });
  const doc = parser.parse(xmlText.trim()) as XmlNode;

  const elements: UIElement[] = [];
  let idx = 0;
  let screenW = 0;
  let screenH = 0;

  for (const [tagName, node] of Object.entries(doc).flatMap(([name, val]) =>
    val && typeof val === "object" ? [...walk(val as XmlNode, name)] : [],
  )) {
    const attr = (k: string): string => String(node[`@_${k}`] ?? "");
    const has = (k: string): boolean => `@_${k}` in node;
    if (!Object.keys(node).some((k) => k.startsWith("@_"))) continue;

    let el: UIElement;
    if (platform === "ios") {
      const x = Math.trunc(Number(attr("x")) || 0);
      const y = Math.trunc(Number(attr("y")) || 0);
      const w = Math.trunc(Number(attr("width")) || 0);
      const h = Math.trunc(Number(attr("height")) || 0);
      const full = attr("type") || tagName;
      el = {
        index: 0, tag: shortTag(full), fullTag: full,
        text: attr("label"), desc: attr("name"), resId: attr("name"),
        hint: "", value: attr("value"),
        bounds: [x, y, x + w, y + h],
        clickable: IOS_CLICKABLE.has(full) || asBool(attr("accessible")),
        enabled: notFalse(has("enabled") ? attr("enabled") : undefined),
        editable: IOS_EDITABLE.has(full),
        checkable: IOS_CHECKABLE.has(full),
        checked: IOS_CHECKABLE.has(full)
          ? ["1", "true"].includes(attr("value"))
          : undefined,
        password: full === "XCUIElementTypeSecureTextField",
        scrollable: IOS_SCROLLABLE.has(full),
        selected: asBool(attr("selected")),
        displayed: notFalse(has("visible") ? attr("visible") : undefined),
      };
    } else {
      const full = attr("class") || tagName;
      const checkable = asBool(attr("checkable"));
      el = {
        index: 0, tag: shortTag(full), fullTag: full,
        text: attr("text"), desc: attr("content-desc"),
        resId: attr("resource-id"), hint: attr("hint"), value: "",
        bounds: parseBounds(attr("bounds")),
        clickable: asBool(attr("clickable")) || asBool(attr("long-clickable")),
        enabled: notFalse(has("enabled") ? attr("enabled") : undefined),
        editable: ANDROID_EDITABLE.has(full) || asBool(attr("editable")),
        checkable,
        checked: checkable ? asBool(attr("checked")) : undefined,
        password: asBool(attr("password")),
        scrollable: asBool(attr("scrollable")),
        selected: asBool(attr("selected")),
        displayed: notFalse(has("displayed") ? attr("displayed") : undefined),
      };
    }

    screenW = Math.max(screenW, el.bounds[2]);
    screenH = Math.max(screenH, el.bounds[3]);

    const keep =
      el.displayed && area(el) > 0 &&
      (el.clickable || el.editable || el.checkable || el.scrollable ||
        !!el.text || !!el.desc || !!el.value ||
        ANDROID_PICKER.has(el.fullTag) || IOS_PICKER.has(el.fullTag));
    if (keep) {
      el.index = idx++;
      elements.push(el);
    }
  }

  const hash = createHash("sha1")
    .update(elements.map(stateKey).join("\n"))
    .digest("hex");
  return {
    elements,
    screenSize: [screenW || 1080, screenH || 1920],
    hash,
    platform,
  };
}
