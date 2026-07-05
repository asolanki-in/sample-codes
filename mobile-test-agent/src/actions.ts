/**
 * Action executors: HOW a command is performed on the device.
 *
 * Like Maestro, taps are performed by coordinates resolved from the live
 * hierarchy (the most robust cross-platform primitive), with locator-based
 * fallbacks. Complex widgets get dedicated deterministic handlers:
 *
 *   * date pickers  — Android calendar & spinner modes, iOS picker wheels
 *   * spinners / dropdowns / option lists
 *   * toggles, switches, checkboxes (state-aware: only tap when needed)
 *   * scroll-to-find with end-of-list detection via snapshot hashing
 */
import type { Config } from "./config.js";
import {
  norm, resolveTarget, textScore, confident, type MatchResult,
} from "./matcher.js";
import { AppiumMcp, ToolCallError } from "./mcpClient.js";
import {
  MONTH_NAMES, parseDateValue, type Command, type SimpleDate,
} from "./parser.js";
import {
  ANDROID_PICKER, IOS_PICKER, area, center, parsePageSource,
  resIdTail, scrollContainers, type Snapshot, type UIElement,
} from "./snapshot.js";

const CONFIRM_WORDS = new Set(["ok", "done", "set", "confirm", "apply", "save", "continue"]);

export class ActionError extends Error {}

export const sleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/** Snapshot-aware device façade shared by executor and verifier. */
export class DeviceFacade {
  constructor(readonly mcp: AppiumMcp, readonly cfg: Config) {}

  async snapshot(): Promise<Snapshot> {
    const xml = await this.mcp.pageSource();
    return parsePageSource(xml, this.cfg.platform);
  }

  /**
   * Maestro-style auto-wait: poll until two consecutive snapshots hash
   * identically (UI idle), bounded by `stableTimeoutMs`.
   */
  async stableSnapshot(timeoutMs?: number): Promise<Snapshot> {
    const deadline = Date.now() + (timeoutMs ?? this.cfg.stableTimeoutMs);
    let prev = await this.snapshot();
    while (Date.now() < deadline) {
      await sleep(this.cfg.stablePollIntervalMs);
      const cur = await this.snapshot();
      if (cur.hash === prev.hash) return cur;
      prev = cur;
    }
    return prev; // best effort — never hard-fail on animation
  }

  async tap(el: UIElement): Promise<void> {
    const [x, y] = center(el);
    try {
      await this.mcp.w3cTap(x, y);
      return;
    } catch (err) {
      if (!(err instanceof ToolCallError)) throw err;
    }
    try { // fallback 1: server-native gesture tool
      await this.mcp.tryCall("gesture", [
        { action: "tap", x, y },
        { gesture: "tap", x, y },
      ]);
      return;
    } catch (err) {
      if (!(err instanceof ToolCallError)) throw err;
    }
    // fallback 2: locator-based click via find tool
    const [strategy, selector] = locator(el);
    await this.mcp.tryCall("find", [
      { strategy, selector, action: "click" },
      { strategy, selector, click: true },
    ]);
  }

  async longPress(el: UIElement, ms = 900): Promise<void> {
    const [x, y] = center(el);
    await this.mcp.w3cTap(x, y, ms);
  }

  async swipeDir(
    direction: "up" | "down" | "left" | "right",
    container: UIElement | undefined,
    snap: Snapshot,
    factor = 0.55,
  ): Promise<void> {
    const [l, t, r, b] = container ? container.bounds : [0, 0, ...snap.screenSize] as const;
    const cx = Math.floor((l + r) / 2);
    const cy = Math.floor((t + b) / 2);
    const dx = Math.floor(((r - l) * factor) / 2);
    const dy = Math.floor(((b - t) * factor) / 2);
    const vectors = {
      down: [cx, cy + dy, cx, cy - dy],   // reveal content below
      up: [cx, cy - dy, cx, cy + dy],
      left: [cx + dx, cy, cx - dx, cy],
      right: [cx - dx, cy, cx + dx, cy],
    } as const;
    const [x1, y1, x2, y2] = vectors[direction];
    await this.mcp.w3cSwipe(x1, y1, x2, y2, 450);
  }

  async typeText(el: UIElement, value: string): Promise<void> {
    await this.tap(el);
    await sleep(250);
    const [strategy, selector] = locator(el);
    try {
      await this.mcp.tryCall("set_value", [
        { text: value, strategy, selector },
        { text: value },
        { value },
      ]);
      return;
    } catch (err) {
      if (!(err instanceof ToolCallError)) throw err;
    }
    // last resort: W3C key actions, char by char (slow but universal)
    const keys: Array<Record<string, unknown>> = [];
    for (const ch of value) {
      keys.push({ type: "keyDown", value: ch });
      keys.push({ type: "keyUp", value: ch });
    }
    await this.mcp.call("perform_actions", {
      actions: [{ type: "key", id: "kbd", actions: keys }],
    });
  }

  async hideKeyboard(): Promise<void> {
    try {
      await this.mcp.tryCall("keyboard", [{ action: "hide" }, {}]);
    } catch (err) {
      if (!(err instanceof ToolCallError)) throw err;
      // keyboard may simply not be shown
    }
  }
}

export function locator(el: UIElement): [strategy: string, selector: string] {
  if (el.resId) return ["id", el.resId];
  if (el.desc) return ["accessibility id", el.desc];
  if (el.text) {
    return ["xpath", `//*[@text=${xq(el.text)} or @label=${xq(el.text)}]`];
  }
  return ["xpath", `//${el.fullTag || "*"}`];
}

const xq = (s: string): string =>
  s.includes("'") ? `'${s.replace(/'/g, "’")}'` : `'${s}'`;

// ---------------------------------------------------------------------------
// Complex-widget helpers
// ---------------------------------------------------------------------------

/** Scroll-to-find with end-of-list detection (hash stops changing). */
export async function scrollToFind(
  dev: DeviceFacade,
  command: Command,
  cfg: Config,
): Promise<[MatchResult, Snapshot]> {
  for (const direction of ["down", "up"] as const) {
    let prevHash: string | undefined;
    for (let i = 0; i < cfg.scrollMaxSwipes; i++) {
      const snap = await dev.snapshot();
      const res = resolveTarget(command, snap, cfg.matchAcceptScore,
        cfg.matchAcceptMargin, cfg.matchStrongScore);
      if (confident(res)) return [res, snap];
      if (snap.hash === prevHash) break;    // end of list reached
      prevHash = snap.hash;
      const containers = scrollContainers(snap);
      await dev.swipeDir(direction, containers[0], snap);
      await sleep(200);
    }
  }
  const snap = await dev.snapshot();
  return [
    resolveTarget(command, snap, cfg.matchAcceptScore,
      cfg.matchAcceptMargin, cfg.matchStrongScore),
    snap,
  ];
}

/** State-aware toggle: read state, tap only if it differs, verify. */
export async function setToggle(
  dev: DeviceFacade,
  el: UIElement,
  desired?: "on" | "off",
): Promise<boolean> {
  const current = el.checked;
  const want = desired === undefined ? undefined : desired === "on";
  if (want !== undefined && current !== undefined && current === want) {
    return true;                                 // already correct: 0 actions
  }
  await dev.tap(el);
  let snap = await dev.stableSnapshot(4000);
  let fresh = refind(snap, el);
  if (!fresh || fresh.checked === undefined) {
    return want === undefined;                   // unverifiable flip
  }
  if (want === undefined) {
    return current === undefined || fresh.checked !== current;
  }
  if (fresh.checked !== want) {                  // one corrective retry
    await dev.tap(fresh);
    snap = await dev.stableSnapshot(4000);
    fresh = refind(snap, fresh);
    return !!fresh && fresh.checked === want;
  }
  return true;
}

export function refind(snap: Snapshot, old: UIElement): UIElement | undefined {
  for (const el of snap.elements) {
    if (el.resId && el.resId === old.resId) return el;
    if (el.tag === old.tag &&
        center(el)[0] === center(old)[0] && center(el)[1] === center(old)[1]) {
      return el;
    }
  }
  return undefined;
}

export function formatDate(d: SimpleDate, dayFirst: boolean): string {
  const dd = String(d.day).padStart(2, "0");
  const mm = String(d.month).padStart(2, "0");
  return dayFirst ? `${dd}/${mm}/${d.year}` : `${mm}/${dd}/${d.year}`;
}

export const findPicker = (snap: Snapshot): UIElement | undefined =>
  snap.elements.find(
    (el) => ANDROID_PICKER.has(el.fullTag) || IOS_PICKER.has(el.fullTag),
  );

/** Universal date entry: plain field -> type; picker dialog -> drive it. */
export async function setDate(
  dev: DeviceFacade,
  command: Command,
  cfg: Config,
  snap: Snapshot,
  fieldEl?: UIElement,
): Promise<boolean> {
  const target = parseDateValue(command.value ?? "", cfg.dayFirstDates);
  if (!target) throw new ActionError(`cannot parse date from '${command.value}'`);

  // If the matched field is an editable text input, just type the date.
  if (fieldEl?.editable) {
    await dev.typeText(fieldEl, formatDate(target, cfg.dayFirstDates));
    return true;
  }

  // Otherwise tap the field to open the platform picker.
  if (fieldEl && !findPicker(snap)) {
    await dev.tap(fieldEl);
    snap = await dev.stableSnapshot(6000);
  }

  const ok = cfg.platform === "ios"
    ? (await iosPickerWheels(dev, snap, target)) ||
      (await iosCalendarPicker(dev, target))
    : await androidDatePicker(dev, snap, target);
  if (!ok) return false;
  await tapConfirm(dev);
  return true;
}

async function tapConfirm(dev: DeviceFacade): Promise<void> {
  const snap = await dev.snapshot();
  for (const el of snap.elements) {
    const label = norm(el.text || el.desc);
    if (CONFIRM_WORDS.has(label) && (el.clickable || el.enabled)) {
      await dev.tap(el);
      return;
    }
  }
}

/** XCUITest lets you set a picker wheel's value directly. */
async function iosPickerWheels(
  dev: DeviceFacade, snap: Snapshot, target: SimpleDate,
): Promise<boolean> {
  const wheels = snap.elements.filter(
    (e) => e.fullTag === "XCUIElementTypePickerWheel",
  );
  if (!wheels.length) return false;
  const monthName = MONTH_NAMES[target.month - 1];
  const values = wheels.length >= 3
    ? [monthName, String(target.day), String(target.year)]
    : [`${monthName} ${target.day}`];               // combined wheel
  for (let i = 0; i < Math.min(wheels.length, values.length); i++) {
    const [strategy, selector] = locator(wheels[i]);
    try {
      await dev.mcp.tryCall("set_value", [
        { text: values[i], strategy, selector },
        { value: values[i], strategy, selector },
      ]);
    } catch (err) {
      if (!(err instanceof ToolCallError)) throw err;
      return false;
    }
    await sleep(300);
  }
  return true;
}

async function androidDatePicker(
  dev: DeviceFacade, snap: Snapshot, target: SimpleDate,
): Promise<boolean> {
  if (snap.elements.some((e) => e.fullTag === "android.widget.NumberPicker")) {
    return androidSpinnerPicker(dev, target);
  }
  return androidCalendarPicker(dev, target);
}

/** iOS 14+ inline/compact calendar (UIDatePickerStyle.inline / .compact). */
async function iosCalendarPicker(
  dev: DeviceFacade, target: SimpleDate,
): Promise<boolean> {
  let snap = await dev.snapshot();
  const monthName = MONTH_NAMES[target.month - 1];

  const shown = shownMonthYear(snap);
  if (shown && (shown[1] !== target.year || shown[0] !== target.month)) {
    // Preferred: tap the "Month Year" header — the calendar flips into
    // month+year picker wheels, which XCUITest can set directly.
    const header = findMonthYearHeader(snap);
    if (header) {
      await dev.tap(header);
      const flipped = await dev.stableSnapshot(3000);
      const wheels = flipped.elements.filter(
        (e) => e.fullTag === "XCUIElementTypePickerWheel",
      );
      if (wheels.length) {
        for (const wheel of wheels) {
          const isYear = /^\d{4}$/.test((wheel.value || wheel.text).trim());
          const val = isYear ? String(target.year) : monthName;
          const [strategy, selector] = locator(wheel);
          try {
            await dev.mcp.tryCall("set_value", [
              { text: val, strategy, selector },
              { value: val, strategy, selector },
            ]);
          } catch (err) {
            if (!(err instanceof ToolCallError)) throw err;
            break; // fall through to chevron navigation
          }
          await sleep(300);
        }
        // collapse the wheels back into the day grid
        const again = findMonthYearHeader(await dev.snapshot());
        if (again) {
          await dev.tap(again);
          await dev.stableSnapshot(3000);
        }
      }
    }
    // Fallback (and residual-drift correction): chevron navigation.
    await stepMonthsWithArrows(dev, target);
  }

  // Day cells carry the full date in their accessibility name
  // ("Thursday, 1 January"), or just the bare day number as the label.
  snap = await dev.snapshot();
  const monthLow = monthName.toLowerCase();
  for (const el of snap.elements) {
    const label = norm(`${el.desc} ${el.text}`);
    if (label.includes(monthLow) &&
        label.split(" ").includes(String(target.day))) {
      await dev.tap(el);
      return true;
    }
  }
  const grid = snap.elements.find((e) => e.fullTag === "XCUIElementTypeDatePicker");
  const dayEl = snap.elements.find(
    (el) => el.text.trim() === String(target.day) &&
            (!grid || boundsContain(grid.bounds, el.bounds)),
  );
  if (dayEl) {
    await dev.tap(dayEl);
    return true;
  }
  return false;
}

/** Clickable "June 2026"-style header of a calendar-mode picker. */
function findMonthYearHeader(snap: Snapshot): UIElement | undefined {
  return snap.elements.find((el) => {
    const label = (el.text || el.desc).trim();
    const m = label.match(/^([A-Za-z]+)\s+\d{4}$/);
    if (!m) return false;
    const month = m[1].toLowerCase();
    return MONTH_NAMES.some(
      (n) => n.toLowerCase() === month || n.slice(0, 3).toLowerCase() === month,
    );
  });
}

/** Step month-by-month via next/previous chevrons, bounded to 4 years. */
async function stepMonthsWithArrows(
  dev: DeviceFacade, target: SimpleDate,
): Promise<void> {
  for (let i = 0; i < 48; i++) {
    const snap = await dev.snapshot();
    const shown = shownMonthYear(snap);
    if (!shown) return;
    const [sm, sy] = shown;
    if (sy === target.year && sm === target.month) return;
    const forward = sy < target.year || (sy === target.year && sm < target.month);
    const arrow = findDesc(snap, forward ? "next month" : "previous month");
    if (!arrow) return;
    await dev.tap(arrow);
    await sleep(300);
  }
}

const boundsContain = (
  outer: UIElement["bounds"], inner: UIElement["bounds"], tolerance = 4,
): boolean =>
  inner[0] >= outer[0] - tolerance && inner[1] >= outer[1] - tolerance &&
  inner[2] <= outer[2] + tolerance && inner[3] <= outer[3] + tolerance;

/** Spinner-mode DatePicker: three NumberPicker columns to spin. */
async function androidSpinnerPicker(
  dev: DeviceFacade, target: SimpleDate,
): Promise<boolean> {
  const wanted = [
    String(target.day),
    MONTH_NAMES[target.month - 1].slice(0, 3),
    String(target.year),
  ];
  const snap = await dev.snapshot();
  const columns = snap.elements
    .filter((e) => e.fullTag === "android.widget.NumberPicker")
    .sort((a, b) => a.bounds[0] - b.bounds[0]); // left→right: d, m, y (locale-naive)
  if (!columns.length) return false;
  let ok = true;
  for (let i = 0; i < Math.min(columns.length, wanted.length); i++) {
    ok = (await spinColumn(dev, columns[i], wanted[i])) && ok;
  }
  return ok;
}

/** Set a NumberPicker column: type into its inner EditText when possible,
 *  otherwise swipe until the centered value matches `want`. */
async function spinColumn(
  dev: DeviceFacade, column: UIElement, want: string, maxSpins = 24,
): Promise<boolean> {
  const wantN = norm(want);
  const numeric = /^\d+$/.test(wantN);

  // fast path: the column's centered value is an EditText — tap and type
  const snap0 = await dev.snapshot();
  const col0 = refind(snap0, column) ?? column;
  const inner = snap0.elements.find(
    (e) => e.editable && boundsContain(col0.bounds, e.bounds),
  );
  if (inner) {
    try {
      await dev.typeText(inner, want);
      await dev.hideKeyboard();
      const check = await dev.stableSnapshot(2000);
      const current = columnValue(check, refind(check, col0) ?? col0);
      if (current !== undefined &&
          (norm(current) === wantN || textScore(want, current) >= 0.9)) {
        return true;
      }
    } catch (err) {
      if (!(err instanceof ToolCallError) && !(err instanceof ActionError)) throw err;
    }
  }
  for (let i = 0; i < maxSpins; i++) {
    const snap = await dev.snapshot();
    const col = refind(snap, column) ?? column;
    const current = columnValue(snap, col);
    if (current === undefined) return false;
    if (norm(current) === wantN || textScore(want, current) >= 0.9) return true;
    const direction = numeric && /^\d+$/.test(current.trim())
      ? (parseInt(current, 10) < parseInt(want, 10) ? "down" : "up")
      : "down";
    await dev.swipeDir(direction, col, snap, 0.35);
    await sleep(250);
  }
  return false;
}

function columnValue(snap: Snapshot, column: UIElement): string | undefined {
  const [l, t, r, b] = column.bounds;
  const cy = (t + b) / 2;
  let best: string | undefined;
  let bestD = Infinity;
  for (const el of snap.elements) {
    if (!el.text && !el.value) continue;
    const [el_, et, er, eb] = el.bounds;
    if (el_ >= l - 4 && er <= r + 4 && et >= t && eb <= b) {
      const d = Math.abs((et + eb) / 2 - cy);
      if (d < bestD) {
        best = el.text || el.value;
        bestD = d;
      }
    }
  }
  return best;
}

/** Calendar-mode DatePicker: year list -> month arrows -> day cell. */
async function androidCalendarPicker(
  dev: DeviceFacade, target: SimpleDate,
): Promise<boolean> {
  let snap = await dev.snapshot();

  // 0. Material pickers offer a text-input mode ("Switch to text input
  //    mode" pencil) — typing the date beats navigating the grid.
  const switchToInput = findDesc(snap, "switch to text input");
  if (switchToInput) {
    await dev.tap(switchToInput);
    const inputSnap = await dev.stableSnapshot(4000);
    const field = inputSnap.elements.find((e) => e.editable);
    if (field) {
      await dev.typeText(field, formatDate(target, dev.cfg.dayFirstDates));
      return true;
    }
  }

  // 1. year — tap the year header, then scroll the year list
  const yearEl = findText(snap, /^\d{4}$/);
  if (yearEl && yearEl.text !== String(target.year)) {
    await dev.tap(yearEl);
    await dev.stableSnapshot(4000);
    const yearCmd: Command = {
      kind: "tap", target: String(target.year),
      secure: false, maybeDate: false, raw: `year ${target.year}`,
    };
    const [res] = await scrollToFind(dev, yearCmd, dev.cfg);
    if (!res.element) return false;
    await dev.tap(res.element);
    await dev.stableSnapshot(4000);
  }

  // 2. month — use next/prev arrows, bounded to 4 years of clicks
  await stepMonthsWithArrows(dev, target);

  // 3. day — cells carry the full date in content-desc, or bare day text
  snap = await dev.snapshot();
  const monthName = MONTH_NAMES[target.month - 1];
  const full = norm(`${String(target.day).padStart(2, "0")} ${monthName} ${target.year}`);
  for (const el of snap.elements) {
    const d = norm(el.desc);
    if (d && (d.includes(full) ||
        (d.split(" ").includes(String(target.day)) &&
         d.includes(monthName.toLowerCase())))) {
      await dev.tap(el);
      return true;
    }
  }
  const dayEl = findText(snap, new RegExp(`^${target.day}$`));
  if (dayEl) {
    await dev.tap(dayEl);
    return true;
  }
  return false;
}

function shownMonthYear(snap: Snapshot): [month: number, year: number] | undefined {
  for (const el of snap.elements) {
    const m = (el.text || el.desc).match(/([A-Za-z]+)\s+(\d{4})/);
    if (m) {
      const idx = MONTH_NAMES.findIndex(
        (name) => name.toLowerCase() === m[1].toLowerCase() ||
                  name.slice(0, 3).toLowerCase() === m[1].toLowerCase(),
      );
      if (idx >= 0) return [idx + 1, parseInt(m[2], 10)];
    }
  }
  return undefined;
}

const findText = (snap: Snapshot, pattern: RegExp): UIElement | undefined =>
  snap.elements.find((el) => el.text && pattern.test(el.text.trim()));

const findDesc = (snap: Snapshot, needle: string): UIElement | undefined =>
  snap.elements.find((el) => norm(el.desc).includes(needle));

/** Dropdown/spinner/option-list: open (if anchored), then pick value. */
export async function selectOption(
  dev: DeviceFacade,
  command: Command,
  cfg: Config,
  anchor?: UIElement,
): Promise<boolean> {
  if (anchor) {
    await dev.tap(anchor);
    await dev.stableSnapshot(5000);
  }
  const optionCmd: Command = {
    kind: "tap", target: command.value,
    secure: false, maybeDate: false, raw: command.raw,
  };
  const [res] = await scrollToFind(dev, optionCmd, cfg);
  if (!res.element) return false;
  await dev.tap(res.element);
  return true;
}
