/**
 * Offline tests: parser + snapshot + matcher + verifier against a
 * realistic Android page source — no device, no LLM, no network.
 */
import { describe, expect, it } from "vitest";
import { resolveTarget } from "../src/matcher.js";
import { parseDateValue, parseStep, type Command } from "../src/parser.js";
import { listing, parsePageSource, resIdTail } from "../src/snapshot.js";
import * as V from "../src/verify.js";

const FIXTURE = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,2280]" class="android.widget.FrameLayout" displayed="true">
    <android.widget.TextView text="Welcome to MyBank" class="android.widget.TextView" bounds="[80,200][1000,300]" displayed="true"/>
    <android.widget.Button text="OK Continue" resource-id="com.mybank:id/btn_ok_continue" class="android.widget.Button" clickable="true" enabled="true" bounds="[240,2000][840,2150]" displayed="true"/>
    <android.widget.EditText text="Username" resource-id="com.mybank:id/input_username" class="android.widget.EditText" clickable="true" enabled="true" bounds="[80,500][1000,640]" displayed="true"/>
    <android.widget.EditText text="" resource-id="com.mybank:id/input_pin" password="true" class="android.widget.EditText" clickable="true" enabled="true" bounds="[80,700][1000,840]" displayed="true"/>
    <android.widget.TextView text="Date of Birth" class="android.widget.TextView" bounds="[80,900][500,970]" displayed="true"/>
    <android.widget.EditText text="" resource-id="com.mybank:id/input_dob" class="android.widget.EditText" clickable="true" enabled="true" bounds="[80,980][1000,1120]" displayed="true" hint="DD/MM/YYYY"/>
    <android.widget.Switch text="" resource-id="com.mybank:id/switch_biometric" content-desc="Enable biometric login" checkable="true" checked="false" clickable="true" enabled="true" bounds="[900,1200][1040,1280]" displayed="true"/>
    <androidx.recyclerview.widget.RecyclerView resource-id="com.mybank:id/account_list" scrollable="true" class="androidx.recyclerview.widget.RecyclerView" bounds="[0,1300][1080,1900]" displayed="true">
      <android.widget.LinearLayout clickable="true" class="android.widget.LinearLayout" bounds="[0,1300][1080,1480]" displayed="true">
        <android.widget.TextView text="Savings Account 1238735444" class="android.widget.TextView" bounds="[40,1330][900,1400]" displayed="true"/>
      </android.widget.LinearLayout>
      <android.widget.LinearLayout clickable="true" class="android.widget.LinearLayout" bounds="[0,1480][1080,1660]" displayed="true">
        <android.widget.TextView text="Current Account 9987125630" class="android.widget.TextView" bounds="[40,1510][900,1580]" displayed="true"/>
      </android.widget.LinearLayout>
    </androidx.recyclerview.widget.RecyclerView>
  </android.widget.FrameLayout>
</hierarchy>
`;

const snap = () => parsePageSource(FIXTURE, "android");
const mustParse = (text: string): Command => {
  const c = parseStep(text);
  expect(c, `step should parse: ${text}`).toBeDefined();
  return c!;
};

// ------------------------- parser (incl. the user's typos) ----------------

describe("parser", () => {
  it("parses tap", () => {
    const c = mustParse("Tap ok continue");
    expect(c.kind).toBe("tap");
    expect(c.target).toBe("ok continue");
  });

  it("parses enter-as", () => {
    const c = mustParse("Enter username as hello");
    expect(c.kind).toBe("input");
    expect(c.target).toBe("username");
    expect(c.value).toBe("hello");
    expect(c.secure).toBe(false);
  });

  it("tolerates typo'd verbs and flags secure fields", () => {
    const c = mustParse("Entet pin as 7807283"); // typo'd verb
    expect(c.kind).toBe("input");
    expect(c.target).toBe("pin");
    expect(c.value).toBe("7807283");
    expect(c.secure).toBe(true);
  });

  it("flags date-of-birth input as a date", () => {
    const c = mustParse("Enter date of birth as 01 01 1990");
    expect(c.kind).toBe("input");
    expect(c.maybeDate).toBe(true);
    expect(parseDateValue(c.value!)).toEqual({ year: 1990, month: 1, day: 1 });
  });

  it("parses tap on account number", () => {
    const c = mustParse("Tap on account number 1238735444");
    expect(c.kind).toBe("tap");
    expect(c.target).toContain("1238735444");
  });

  it("parses toggle / select / scroll / assert / wait / back", () => {
    expect(mustParse("Turn on enable biometric login").toggleState).toBe("on");
    const sel = mustParse("Select March from month picker");
    expect(sel.kind).toBe("select");
    expect(sel.value).toBe("march");
    expect(sel.target).toBe("month picker");
    expect(mustParse("Scroll down").direction).toBe("down");
    expect(mustParse("scroll to transactions").target).toBe("transactions");
    expect(mustParse("Verify account details is visible").kind).toBe("assert_visible");
    expect(mustParse("wait 2 seconds").value).toBe("2");
    expect(mustParse("press back").kind).toBe("back");
  });

  it("parses various date formats", () => {
    expect(parseDateValue("01/01/1990")).toEqual({ year: 1990, month: 1, day: 1 });
    expect(parseDateValue("15 Aug 1997")).toEqual({ year: 1997, month: 8, day: 15 });
    expect(parseDateValue("1990-01-31")).toEqual({ year: 1990, month: 1, day: 31 });
    expect(parseDateValue("31 12 2000")).toEqual({ year: 2000, month: 12, day: 31 });
  });
});

// ------------------------------- snapshot ------------------------------

describe("snapshot", () => {
  it("distills the hierarchy and hashes deterministically", () => {
    const s = snap();
    expect(s.screenSize).toEqual([1080, 2280]);
    expect(s.hash).toBeTruthy();
    expect(s.hash).toBe(snap().hash);
    const tags = new Set(s.elements.map((e) => e.tag));
    expect(tags).toContain("Button");
    expect(tags).toContain("EditText");
    expect(tags).toContain("Switch");
    const table = listing(s);
    expect(table).toContain("btn_ok_continue");
    expect(table.length).toBeLessThan(FIXTURE.length / 2);
  });
});

// ------------------------------- matcher --------------------------------

const resolveStep = (text: string) => resolveTarget(mustParse(text), snap());

describe("matcher", () => {
  it("matches the button", () => {
    const r = resolveStep("Tap ok continue");
    expect(r.element).toBeDefined();
    expect(resIdTail(r.element!)).toBe("btn_ok_continue");
  });

  it("matches the username field", () => {
    const r = resolveStep("Enter username as hello");
    expect(r.element).toBeDefined();
    expect(resIdTail(r.element!)).toBe("input_username");
    expect(r.element!.editable).toBe(true);
  });

  it("matches the pin field by resource id", () => {
    const r = resolveStep("Entet pin as 7807283");
    expect(r.element).toBeDefined();
    expect(resIdTail(r.element!)).toBe("input_pin");
    expect(r.element!.password).toBe(true);
  });

  it("matches DOB via the acronym rule (date of birth -> input_dob)", () => {
    const r = resolveStep("Enter date of birth as 01 01 1990");
    expect(r.element).toBeDefined();
    expect(resIdTail(r.element!)).toBe("input_dob");
  });

  it("anchors on the digit run for account rows", () => {
    const r = resolveStep("Tap on account number 1238735444");
    expect(r.element).toBeDefined();
    expect(r.element!.text + r.element!.desc).toContain("1238735444");
  });

  it("rejects a wrong account number instead of guessing", () => {
    const r = resolveStep("Tap on account number 0000000000");
    expect(r.element).toBeUndefined();
  });

  it("prefers checkables for toggle commands", () => {
    const r = resolveStep("Turn on biometric login");
    expect(r.element).toBeDefined();
    expect(r.element!.tag).toBe("Switch");
    expect(r.element!.checked).toBe(false);
  });
});

// ------------------------------- verify ---------------------------------

describe("verify", () => {
  const probe = (kind: "assert_visible" | "assert_not_visible", target: string): Command =>
    ({ kind, target, secure: false, maybeDate: false, raw: "" });

  it("checks visible and not-visible assertions", () => {
    const s = snap();
    expect(V.verifyVisible(s, probe("assert_visible", "welcome to mybank")).ok).toBe(true);
    expect(V.verifyVisible(s, probe("assert_not_visible", "logout")).ok).toBe(true);
  });

  it("accepts masked content in secure fields", () => {
    const s = snap();
    const field = s.elements.find((e) => resIdTail(e) === "input_pin")!;
    const filled = FIXTURE.replace(
      '<android.widget.EditText text="" resource-id="com.mybank:id/input_pin"',
      '<android.widget.EditText text="•••••••" resource-id="com.mybank:id/input_pin"',
    );
    const after = parsePageSource(filled, "android");
    const c = mustParse("Enter pin as 7807283");
    expect(V.verifyInput(after, field, c).ok).toBe(true);
  });

  it("flags a tap with no observable change so the agent retries", () => {
    const s = snap();
    const btn = s.elements.find((e) => resIdTail(e) === "btn_ok_continue")!;
    expect(V.verifyTap(s, snap(), btn).ok).toBe(false);
  });
});
