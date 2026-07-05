/**
 * Date-picker handler tests against a scripted fake device — verifies the
 * per-widget strategies without a real device:
 *
 *   iOS: three picker wheels (direct set_value)
 *   iOS: inline calendar (chevron navigation + day-cell accessibility label)
 *   Android: Material calendar "Switch to text input mode" -> type the date
 *   Android: calendar grid day cell by content-desc
 */
import { describe, expect, it } from "vitest";
import { setDate, type DeviceFacade } from "../src/actions.js";
import { defaultConfig, type Config, type Platform } from "../src/config.js";
import type { Command } from "../src/parser.js";
import { parsePageSource, type UIElement } from "../src/snapshot.js";

const dobCommand: Command = {
  kind: "set_date",
  target: "date of birth",
  value: "01 01 1990",
  secure: false,
  maybeDate: true,
  raw: "Enter date of birth as 01 01 1990",
};

interface FakeOptions {
  platform: Platform;
  getXml: () => string;
  onTap?: (el: UIElement) => void;
  onType?: (el: UIElement, value: string) => void;
  onSetValue?: (args: Record<string, unknown>) => void;
}

function makeFakeDevice(opts: FakeOptions): DeviceFacade {
  const cfg: Config = { ...defaultConfig(), platform: opts.platform };
  const snapshot = async () => parsePageSource(opts.getXml(), opts.platform);
  const fake = {
    cfg,
    mcp: {
      tryCall: async (logical: string, variants: Array<Record<string, unknown>>) => {
        if (logical === "set_value") opts.onSetValue?.(variants[0]);
        return {};
      },
      call: async () => ({}),
    },
    snapshot,
    stableSnapshot: async () => snapshot(),
    tap: async (el: UIElement) => opts.onTap?.(el),
    longPress: async () => {},
    swipeDir: async () => {},
    typeText: async (el: UIElement, value: string) => opts.onType?.(el, value),
    hideKeyboard: async () => {},
  };
  return fake as unknown as DeviceFacade;
}

// Handlers take the pre-fetched snapshot as an argument; passing the live
// one keeps the scripted states in sync.
const run = async (dev: DeviceFacade) =>
  setDate(dev, dobCommand, dev.cfg, await dev.snapshot(), undefined);

describe("iOS date pickers", () => {
  it("sets three picker wheels directly (wheel-style UIDatePicker)", async () => {
    const xml = `<?xml version="1.0"?>
      <AppiumAUT>
        <XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="390" height="844">
          <XCUIElementTypeDatePicker type="XCUIElementTypeDatePicker" x="0" y="500" width="390" height="300">
            <XCUIElementTypePickerWheel type="XCUIElementTypePickerWheel" value="June" x="20" y="520" width="120" height="260"/>
            <XCUIElementTypePickerWheel type="XCUIElementTypePickerWheel" value="15" x="150" y="520" width="80" height="260"/>
            <XCUIElementTypePickerWheel type="XCUIElementTypePickerWheel" value="2026" x="240" y="520" width="120" height="260"/>
          </XCUIElementTypeDatePicker>
        </XCUIElementTypeApplication>
      </AppiumAUT>`;
    const setValues: string[] = [];
    const dev = makeFakeDevice({
      platform: "ios",
      getXml: () => xml,
      onSetValue: (args) => setValues.push(String(args.text)),
    });
    expect(await run(dev)).toBe(true);
    expect(setValues).toEqual(["January", "1", "1990"]);
  });

  it("drives the inline calendar via chevrons and the day-cell label", async () => {
    let state = 0; // 0: showing February 1990, 1: showing January 1990
    const header = () => (state === 0 ? "February 1990" : "January 1990");
    const days = () => (state === 0 ? "" : `
      <XCUIElementTypeButton type="XCUIElementTypeButton" label="1" name="Monday, 1 January" x="20" y="300" width="40" height="40"/>
      <XCUIElementTypeButton type="XCUIElementTypeButton" label="2" name="Tuesday, 2 January" x="70" y="300" width="40" height="40"/>`);
    const xml = () => `<?xml version="1.0"?>
      <AppiumAUT>
        <XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="390" height="844">
          <XCUIElementTypeDatePicker type="XCUIElementTypeDatePicker" x="0" y="100" width="390" height="400">
            <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" label="${header()}" x="20" y="110" width="150" height="30"/>
            <XCUIElementTypeButton type="XCUIElementTypeButton" name="Previous Month" x="300" y="110" width="40" height="30"/>
            <XCUIElementTypeButton type="XCUIElementTypeButton" name="Next Month" x="345" y="110" width="40" height="30"/>
            ${days()}
          </XCUIElementTypeDatePicker>
        </XCUIElementTypeApplication>
      </AppiumAUT>`;
    const tapped: string[] = [];
    const dev = makeFakeDevice({
      platform: "ios",
      getXml: xml,
      onTap: (el) => {
        const label = el.desc || el.text;
        tapped.push(label);
        if (label === "Previous Month") state = 1;
      },
    });
    expect(await run(dev)).toBe(true);
    expect(tapped).toContain("Previous Month");
    expect(tapped[tapped.length - 1]).toBe("Monday, 1 January");
  });
});

describe("Android date pickers", () => {
  it("uses Material's text-input mode and types the date", async () => {
    let state = 0; // 0: calendar grid, 1: text-input mode
    const body = () => state === 0
      ? `<android.widget.ImageButton content-desc="Switch to text input mode" class="android.widget.ImageButton" clickable="true" bounds="[900,300][1000,400]" displayed="true"/>
         <android.widget.TextView text="January 2026" class="android.widget.TextView" bounds="[100,300][500,380]" displayed="true"/>`
      : `<android.widget.EditText text="" hint="dd/mm/yyyy" class="android.widget.EditText" clickable="true" bounds="[100,300][900,420]" displayed="true"/>`;
    const xml = () => `<?xml version='1.0'?>
      <hierarchy>
        <android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,200][1080,1200]" displayed="true">
          ${body()}
          <android.widget.Button text="OK" class="android.widget.Button" clickable="true" bounds="[800,1100][1000,1180]" displayed="true"/>
        </android.widget.FrameLayout>
      </hierarchy>`;
    let typed = "";
    const dev = makeFakeDevice({
      platform: "android",
      getXml: xml,
      onTap: (el) => {
        if (el.desc.includes("Switch to text input")) state = 1;
      },
      onType: (_el, value) => { typed = value; },
    });
    expect(await run(dev)).toBe(true);
    expect(typed).toBe("01/01/1990"); // dayFirstDates default
  });

  it("taps the calendar day cell via its content-desc", async () => {
    const xml = `<?xml version='1.0'?>
      <hierarchy>
        <android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,200][1080,1400]" displayed="true">
          <android.widget.TextView text="1990" class="android.widget.TextView" bounds="[100,240][300,300]" displayed="true"/>
          <android.widget.TextView text="January 1990" class="android.widget.TextView" bounds="[100,320][500,380]" displayed="true"/>
          <android.widget.TextView text="1" content-desc="01 January 1990" class="android.widget.TextView" clickable="true" bounds="[60,500][160,600]" displayed="true"/>
          <android.widget.TextView text="2" content-desc="02 January 1990" class="android.widget.TextView" clickable="true" bounds="[180,500][280,600]" displayed="true"/>
          <android.widget.Button text="OK" class="android.widget.Button" clickable="true" bounds="[800,1300][1000,1380]" displayed="true"/>
        </android.widget.FrameLayout>
      </hierarchy>`;
    const tapped: string[] = [];
    const dev = makeFakeDevice({
      platform: "android",
      getXml: () => xml,
      onTap: (el) => tapped.push(el.desc || el.text),
    });
    expect(await run(dev)).toBe(true);
    expect(tapped[0]).toBe("01 January 1990");
    expect(tapped).toContain("OK"); // confirm button tapped afterwards
  });
});
