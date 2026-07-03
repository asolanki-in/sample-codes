/**
 * Deterministic element matcher — best-in-class finding without an LLM.
 *
 * Resolution ladder (cheapest first):
 *   1. exact text / content-desc / accessibility-id / resource-id match
 *   2. containment + fuzzy token matching with intent-aware bonuses
 *      (editable fields for `input`, checkables for `toggle`, ...)
 *   3. digit-run anchoring ("account number 1238735444" must land on the
 *      element that actually contains 1238735444)
 * Only when the winner is weak or ambiguous does the agent escalate to
 * the LLM with the compact element table.
 */
import type { Command } from "./parser.js";
import { similarity } from "./similarity.js";
import { resIdTail, type Snapshot, type UIElement } from "./snapshot.js";

const STOPWORDS = new Set([
  "the", "a", "an", "button", "field", "box", "link", "icon",
  "tab", "option", "item", "text", "input",
]);

export const norm = (s: string): string =>
  (s ?? "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

function tokens(s: string): Set<string> {
  const all = norm(s).split(" ").filter(Boolean);
  const kept = all.filter((t) => !STOPWORDS.has(t));
  return new Set(kept.length ? kept : all);
}

export function textScore(target: string, candidate: string): number {
  const t = norm(target);
  const c = norm(candidate);
  if (!t || !c) return 0;
  if (t === c) return 1;
  let contain = 0;
  if (t.includes(c) || c.includes(t)) {
    contain = 0.82 + 0.13 * (Math.min(t.length, c.length) / Math.max(t.length, c.length));
  }
  const tt = tokens(target);
  const tc = tokens(candidate);
  const union = new Set([...tt, ...tc]);
  let inter = 0;
  for (const tok of tt) if (tc.has(tok)) inter++;
  const jac = union.size ? inter / union.size : 0;
  const ratio = similarity(t, c);
  return Math.max(contain, 0.65 * jac + 0.35 * ratio);
}

const initials = (s: string): string => {
  const toks = norm(s).split(" ").filter(Boolean);
  return toks.length >= 2 ? toks.map((t) => t[0]).join("") : "";
};

function idScore(target: string, tail: string): number {
  if (!tail) return 0;
  // btn_ok_continue -> "btn ok continue"
  const asWords = tail
    .replace(/([a-z])(?=[A-Z])/g, "$1 ")
    .replace(/[_-]/g, " ");
  let score = textScore(target, asWords);
  // acronym rule: "date of birth" matches id tail "input_dob"
  const tin = initials(target);
  const cin = initials(asWords);
  const wordToks = new Set(norm(asWords).split(" "));
  const targetToks = new Set(norm(target).split(" "));
  if ((tin && wordToks.has(tin)) || (cin && targetToks.has(cin))) {
    score = Math.max(score, 0.9);
  }
  return score;
}

export function elementScore(command: Command, el: UIElement): number {
  const target = command.target ?? "";
  const fields: Array<[string, number]> = [
    [el.text, 1.0],
    [el.desc, 0.98],
    [el.hint, 0.96],
    [el.value, 0.9],
  ];
  let best = Math.max(0, ...fields.map(([f, w]) => textScore(target, f) * w));
  best = Math.max(best, idScore(target, resIdTail(el)) * 0.92);

  // digit-run anchoring: "account number 1238735444"
  const runs = target.match(/\d{4,}/g) ?? [];
  if (runs.length) {
    const haystack = [el.text, el.desc, el.value, el.resId].join(" ");
    if (runs.some((r) => haystack.includes(r))) {
      best = Math.min(1, Math.max(best, 0.9) + 0.05);
    } else {
      best = Math.min(best, 0.45);
    }
  }

  // intent-aware adjustments
  if (command.kind === "input") {
    best += el.editable ? 0.08 : -0.3;
  } else if (command.kind === "toggle") {
    best += el.checkable || el.checked !== undefined ? 0.1 : -0.25;
  } else if (["tap", "long_press", "select"].includes(command.kind)) {
    if (el.clickable || el.enabled) best += 0.03;
  }
  if (!el.enabled && ["tap", "input", "toggle", "select"].includes(command.kind)) {
    best -= 0.15;
  }
  return Math.max(0, Math.min(1, best));
}

export interface MatchResult {
  element?: UIElement;
  score: number;
  margin: number;
  candidates: UIElement[];      // top-k for LLM escalation
}

export const confident = (r: MatchResult): boolean => r.element !== undefined;

export function resolveTarget(
  command: Command,
  snap: Snapshot,
  accept = 0.72,
  margin = 0.08,
  strong = 0.9,
  topK = 8,
): MatchResult {
  if (!command.target) return { score: 0, margin: 0, candidates: [] };
  const scored = snap.elements
    .map((el) => ({ score: elementScore(command, el), el }))
    .filter((p) => p.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (!scored.length) return { score: 0, margin: 0, candidates: [] };
  const best = scored[0];
  const gap = scored.length > 1 ? best.score - scored[1].score : 1;
  const candidates = scored.map((p) => p.el);
  if (best.score >= strong || (best.score >= accept && gap >= margin)) {
    return { element: best.el, score: best.score, margin: gap, candidates };
  }
  return { score: best.score, margin: gap, candidates };
}
