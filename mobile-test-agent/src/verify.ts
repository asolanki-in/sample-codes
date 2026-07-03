/**
 * Post-action verification — the third leg of find → act → VERIFY.
 *
 * Every command type has an explicit postcondition checked against a
 * fresh snapshot. A step only PASSES when its postcondition holds;
 * otherwise the orchestrator retries with a recovery ladder. This is
 * what pushes the end-to-end failure rate down: an action that silently
 * did nothing is caught immediately, on the step where it happened.
 */
import { norm, resolveTarget, textScore } from "./matcher.js";
import type { Command } from "./parser.js";
import { center, type Snapshot, type UIElement } from "./snapshot.js";

export interface Verification {
  ok: boolean;
  detail: string;
  weak?: boolean;  // action ran, postcondition unobservable (still usable)
}

export function verifyTap(
  before: Snapshot, after: Snapshot, el: UIElement,
): Verification {
  if (after.hash !== before.hash) {
    return { ok: true, detail: "screen changed after tap" };
  }
  const fresh = findSame(after, el);
  if (!fresh) return { ok: true, detail: "tapped element left the screen" };
  if (fresh.selected !== el.selected || fresh.checked !== el.checked) {
    return { ok: true, detail: "element state changed" };
  }
  return { ok: false, detail: "no observable change after tap" };
}

export function verifyInput(
  after: Snapshot, el: UIElement, command: Command,
): Verification {
  const fresh = findSame(after, el);
  if (!fresh) {
    return { ok: true, detail: "field not re-found (screen moved on)", weak: true };
  }
  const content = fresh.text || fresh.value;
  if (command.secure || fresh.password) {
    // masked text ("•••••") normalises to "", so compare raw strings
    const ok = !!content.trim() && content.trim() !== (el.hint ?? "").trim();
    return {
      ok,
      detail: ok ? "secure field is non-empty" : "secure field still empty",
    };
  }
  if (norm(content) === norm(command.value ?? "")) {
    return { ok: true, detail: "field text matches" };
  }
  if (command.value && content.includes(command.value)) {
    return { ok: true, detail: "field contains entered text" };
  }
  // masked/formatted inputs (e.g. auto-formatted dates) — accept non-empty
  if (content && norm(content) !== norm(el.hint ?? "") && content !== el.text) {
    return { ok: true, detail: `field changed to '${content.slice(0, 30)}'`, weak: true };
  }
  return {
    ok: false,
    detail: `field shows '${content.slice(0, 30)}', ` +
            `expected '${(command.value ?? "").slice(0, 30)}'`,
  };
}

export function verifyVisible(
  snap: Snapshot, command: Command, accept = 0.72,
): Verification {
  const probe: Command = {
    kind: "tap", target: command.target,
    secure: false, maybeDate: false, raw: command.raw,
  };
  const res = resolveTarget(probe, snap, accept, 0, accept);
  if (command.kind === "assert_not_visible") {
    const ok = !res.element && res.score < accept;
    return { ok, detail: ok ? "element absent" : "element still visible" };
  }
  const ok = !!res.element || res.score >= accept;
  return {
    ok,
    detail: ok ? "element visible"
      : `best match score ${res.score.toFixed(2)} below ${accept}`,
  };
}

/** After a picker flow, the field should now display the chosen date. */
export function verifyDateShown(
  snap: Snapshot, el: UIElement | undefined, valueVariants: string[],
): Verification {
  if (!el) return { ok: true, detail: "no anchor field to re-check", weak: true };
  const fresh = findSame(snap, el);
  const content = fresh ? fresh.text || fresh.value : "";
  for (const v of valueVariants) {
    if (v && textScore(v, content) >= 0.6) {
      return { ok: true, detail: `field shows '${content.slice(0, 30)}'` };
    }
  }
  if (content) {
    return { ok: true, detail: `field changed to '${content.slice(0, 30)}'`, weak: true };
  }
  return { ok: false, detail: "date field still empty" };
}

function findSame(snap: Snapshot, old: UIElement): UIElement | undefined {
  for (const el of snap.elements) {
    if (old.resId && el.resId === old.resId) return el;
  }
  const [ox, oy] = center(old);
  for (const el of snap.elements) {
    const [x, y] = center(el);
    if (x === ox && y === oy && el.tag === old.tag) return el;
  }
  return undefined;
}
