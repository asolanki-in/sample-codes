/**
 * Natural-language step parser.
 *
 * Maestro's reliability starts with a *closed, declarative command
 * vocabulary* — the flow says WHAT, the engine decides HOW. We adopt the
 * same idea: plain-English steps are compiled into typed commands by a
 * deterministic grammar (0 LLM tokens). Only steps the grammar cannot
 * understand are sent to the LLM, which must answer in the exact same
 * command schema, so execution is always deterministic afterwards.
 *
 * The grammar is typo-tolerant on verbs ("Entet pin as 7807283" -> enter),
 * because human-authored steps are the input format.
 */
import { similarity } from "./similarity.js";

export type CommandKind =
  | "tap" | "long_press" | "input" | "set_date" | "select" | "toggle"
  | "scroll" | "assert_visible" | "assert_not_visible" | "wait"
  | "back" | "home" | "hide_keyboard" | "launch" | "press_key";

export interface Command {
  kind: CommandKind;
  target?: string;              // element description ("ok continue")
  value?: string;               // text/date/option value
  direction?: "up" | "down" | "left" | "right";
  toggleState?: "on" | "off";   // undefined = flip
  secure: boolean;              // pin/password style field
  maybeDate: boolean;           // value looks like a date / field is date-ish
  raw: string;                  // original step text
}

const cmd = (partial: Partial<Command> & { kind: CommandKind; raw: string }): Command => ({
  secure: false,
  maybeDate: false,
  ...partial,
});

const VERBS = [
  "tap", "click", "press", "enter", "type", "input", "fill", "set",
  "select", "choose", "pick", "turn", "switch", "toggle", "enable",
  "disable", "check", "uncheck", "scroll", "swipe", "assert", "verify",
  "expect", "see", "wait", "launch", "open", "long", "go", "hide",
  "clear", "back",
];

const SECURE_TOKENS = new Set(["pin", "password", "passcode", "passphrase", "otp", "cvv", "mpin"]);
const DATE_FIELD_TOKENS = new Set([
  "date", "dob", "birth", "birthday", "expiry", "expiration",
  "anniversary", "doj", "calendar",
]);

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];
const MONTHS: Record<string, number> = {};
MONTH_NAMES.forEach((name, i) => {
  MONTHS[name.toLowerCase()] = i + 1;
  MONTHS[name.slice(0, 3).toLowerCase()] = i + 1;
});
MONTHS.sept = 9;

export interface SimpleDate { year: number; month: number; day: number }

function validDate(d: SimpleDate): SimpleDate | undefined {
  const { year, month, day } = d;
  if (month < 1 || month > 12 || day < 1) return undefined;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day ? d : undefined;
}

export function parseDateValue(value: string, dayFirst = true): SimpleDate | undefined {
  const v = value.trim().toLowerCase();
  let m = v.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (m && MONTHS[m[2]]) {
    return validDate({ year: +m[3], month: MONTHS[m[2]], day: +m[1] });
  }
  m = v.match(/^(\d{4})[\s/\-.](\d{1,2})[\s/\-.](\d{1,2})$/); // ISO-ish
  if (m) return validDate({ year: +m[1], month: +m[2], day: +m[3] });
  m = v.match(/^(\d{1,2})[\s/\-.](\d{1,2})[\s/\-.](\d{4})$/);
  if (m) {
    const [a, b, year] = [+m[1], +m[2], +m[3]];
    let [day, month] = dayFirst ? [a, b] : [b, a];
    if (month > 12 && day <= 12) [day, month] = [month, day]; // auto-repair
    return validDate({ year, month, day });
  }
  return undefined;
}

/** Typo-tolerant verb normalisation: 'entet' -> 'enter'. */
function fixVerb(word: string): string {
  const w = word.toLowerCase();
  if (VERBS.includes(w)) return w;
  let best = w, bestScore = 0.75;
  for (const verb of VERBS) {
    const s = similarity(w, verb);
    if (s >= bestScore) { best = verb; bestScore = s; }
  }
  return best;
}

const words = (s: string): string[] => s.toLowerCase().match(/[a-z]+/g) ?? [];
const isSecure = (field: string) => words(field).some((w) => SECURE_TOKENS.has(w));
const isDateish = (field: string) => words(field).some((w) => DATE_FIELD_TOKENS.has(w));

/** Deterministic grammar. Returns undefined when the step needs the LLM. */
export function parseStep(text: string, dayFirst = true): Command | undefined {
  const raw = text.trim();
  let s = raw.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  if (!s) return undefined;
  const parts = s.split(" ");
  parts[0] = fixVerb(parts[0]);
  s = parts.join(" ");
  const low = s.toLowerCase();
  let m: RegExpMatchArray | null;

  // -- simple device/system commands ----------------------------------
  if ((m = low.match(/^wait(?: for)? (\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|ms)?$/))) {
    let val = parseFloat(m[1]);
    if (m[2] === "ms") val /= 1000;
    return cmd({ kind: "wait", value: String(val), raw });
  }
  if (/^(go |press |navigate )?back$/.test(low)) return cmd({ kind: "back", raw });
  if (/^(go |press )?home$/.test(low)) return cmd({ kind: "home", raw });
  if (/^hide (the )?keyboard$/.test(low)) return cmd({ kind: "hide_keyboard", raw });
  if ((m = low.match(/^(launch|open)( the)?( app)?\s+([\w.]+)$/)) && (m[4].includes(".") || m[3])) {
    return cmd({ kind: "launch", target: m[4], raw });
  }
  if ((m = low.match(/^press (enter|done|search|go|next|delete|tab)( key)?$/))) {
    return cmd({ kind: "press_key", value: m[1], raw });
  }

  // -- toggles ---------------------------------------------------------
  if ((m = low.match(/^(?:turn|switch) (on|off) (.+)$/))) {
    return cmd({ kind: "toggle", target: m[2], toggleState: m[1] as "on" | "off", raw });
  }
  if ((m = low.match(/^(?:turn|switch) (.+?) (on|off)$/))) {
    return cmd({ kind: "toggle", target: m[1], toggleState: m[2] as "on" | "off", raw });
  }
  if ((m = low.match(/^(enable|disable) (.+)$/))) {
    return cmd({ kind: "toggle", target: m[2], toggleState: m[1] === "enable" ? "on" : "off", raw });
  }
  if ((m = low.match(/^toggle (.+?)(?: (on|off))?$/))) {
    return cmd({ kind: "toggle", target: m[1], toggleState: m[2] as "on" | "off" | undefined, raw });
  }
  if ((m = low.match(/^(check|uncheck|tick|untick) (?!that )(.+)$/)) &&
      !/(visible|displayed|exists|shown)/.test(low)) {
    const state = m[1] === "check" || m[1] === "tick" ? "on" : "off";
    return cmd({ kind: "toggle", target: m[2], toggleState: state, raw });
  }

  // -- pickers / dropdowns ---------------------------------------------
  if ((m = low.match(/^(?:select|choose|pick) (.+?) (?:from|in|on) (.+)$/))) {
    return cmd({ kind: "select", target: m[2], value: m[1], raw });
  }
  if ((m = low.match(/^(?:select|choose|pick) (.+)$/))) {
    return cmd({ kind: "select", value: m[1], raw });
  }

  // -- explicit dates ----------------------------------------------------
  if ((m = low.match(/^set (.+?) (?:to|as) (.+)$/)) &&
      (isDateish(m[1]) || parseDateValue(m[2], dayFirst))) {
    return cmd({ kind: "set_date", target: m[1], value: m[2], maybeDate: true, raw });
  }

  // -- text entry --------------------------------------------------------
  if ((m = low.match(/^(?:enter|type|input|fill|set) (.+?) (?:as|with|to|=) (.+)$/))) {
    const [field, value] = [m[1], m[2]];
    // keep the user's original casing for the value
    const origValue = raw.toLowerCase().endsWith(value)
      ? raw.slice(raw.length - value.length).trim()
      : value;
    return cmd({
      kind: "input", target: field, value: origValue,
      secure: isSecure(field),
      maybeDate: isDateish(field) && !!parseDateValue(value, dayFirst),
      raw,
    });
  }
  if ((m = low.match(/^(?:enter|type|input) ["']?(.+?)["']? (?:in|into|on) (?:the )?(.+)$/))) {
    const field = m[2];
    return cmd({
      kind: "input", target: field, value: m[1],
      secure: isSecure(field),
      maybeDate: isDateish(field) && !!parseDateValue(m[1], dayFirst),
      raw,
    });
  }

  // -- scrolling ---------------------------------------------------------
  if ((m = low.match(/^(?:scroll|swipe) (up|down|left|right)(?: (?:to|until) (.+))?$/))) {
    return cmd({
      kind: "scroll", direction: m[1] as Command["direction"], target: m[2], raw,
    });
  }
  if ((m = low.match(/^scroll (?:to|until) (.+)$/))) {
    return cmd({ kind: "scroll", target: m[1], raw });
  }

  // -- assertions ----------------------------------------------------------
  if (/^(assert|verify|expect|see)/.test(low) &&
      (m = low.match(
        /^(?:assert|verify|expect|see|check)(?: that)? ["']?(.+?)["']?(?: is)?(?: (not))? ?(?:visible|displayed|shown|exists|present|on(?: the)? screen)?$/,
      ))) {
    return cmd({ kind: m[2] ? "assert_not_visible" : "assert_visible", target: m[1], raw });
  }

  // -- taps (last: broadest pattern) ----------------------------------------
  if ((m = low.match(/^long ?(?:press|tap)(?: on)? (.+)$/))) {
    return cmd({ kind: "long_press", target: m[1], raw });
  }
  if ((m = low.match(/^(?:tap|click|press)(?: on)?(?: the)? (.+?)(?: button| link| icon| tab)?$/))) {
    return cmd({ kind: "tap", target: m[1], raw });
  }

  return undefined;
}
