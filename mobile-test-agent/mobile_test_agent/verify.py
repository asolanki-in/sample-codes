"""Post-action verification — the third leg of find → act → VERIFY.

Every command type has an explicit postcondition checked against a fresh
snapshot.  A step only PASSES when its postcondition holds; otherwise the
orchestrator retries with a recovery ladder.  This is what pushes the
end-to-end failure rate down: an action that silently did nothing is
caught immediately, on the step where it happened.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .matcher import norm, resolve, text_score
from .parser import Command
from .snapshot import Snapshot, UIElement


@dataclass
class Verification:
    ok: bool
    detail: str = ""
    weak: bool = False   # action ran, postcondition unobservable (still usable)


def verify_tap(before: Snapshot, after: Snapshot, el: UIElement) -> Verification:
    if after.hash != before.hash:
        return Verification(True, "screen changed after tap")
    fresh = _find_same(after, el)
    if fresh is None:
        return Verification(True, "tapped element left the screen")
    if fresh.selected != el.selected or fresh.checked != el.checked:
        return Verification(True, "element state changed")
    return Verification(False, "no observable change after tap")


def verify_input(after: Snapshot, el: UIElement, cmd: Command) -> Verification:
    fresh = _find_same(after, el)
    if fresh is None:
        return Verification(True, "field not re-found (screen moved on)", weak=True)
    content = fresh.text or fresh.value
    if cmd.secure or fresh.password:
        # masked text ("•••••") normalises to "", so compare raw strings
        ok = bool(content.strip()) and content.strip() != (el.hint or "").strip()
        return Verification(ok, "secure field is non-empty" if ok
                            else "secure field still empty")
    if norm(content) == norm(cmd.value or ""):
        return Verification(True, "field text matches")
    if cmd.value and (cmd.value in (content or "")):
        return Verification(True, "field contains entered text")
    # masked/formatted inputs (e.g. auto-formatted dates) — accept non-empty
    if content and norm(content) != norm(el.hint or "") and content != el.text:
        return Verification(True, f"field changed to '{content[:30]}'", weak=True)
    return Verification(False, f"field shows '{(content or '')[:30]}', "
                               f"expected '{(cmd.value or '')[:30]}'")


def verify_visible(snap: Snapshot, cmd: Command, accept: float = 0.72) -> Verification:
    res = resolve(Command(kind="tap", target=cmd.target, raw=cmd.raw), snap,
                  accept=accept, margin=0.0, strong=accept)
    if cmd.kind == "assert_not_visible":
        ok = res.element is None and res.score < accept
        return Verification(ok, "element absent" if ok else "element still visible")
    ok = res.element is not None or res.score >= accept
    return Verification(ok, "element visible" if ok else
                        f"best match score {res.score:.2f} below {accept}")


def verify_date_shown(snap: Snapshot, el: Optional[UIElement],
                      value_variants: list) -> Verification:
    """After a picker flow, the field should now display the chosen date."""
    if el is None:
        return Verification(True, "no anchor field to re-check", weak=True)
    fresh = _find_same(snap, el)
    content = (fresh.text or fresh.value) if fresh else ""
    for v in value_variants:
        if v and text_score(v, content) >= 0.6:
            return Verification(True, f"field shows '{content[:30]}'")
    if content:
        return Verification(True, f"field changed to '{content[:30]}'", weak=True)
    return Verification(False, "date field still empty")


def _find_same(snap: Snapshot, old: UIElement) -> Optional[UIElement]:
    for el in snap.elements:
        if old.res_id and el.res_id == old.res_id:
            return el
    for el in snap.elements:
        if el.center == old.center and el.tag == old.tag:
            return el
    return None
