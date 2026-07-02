"""Deterministic element matcher — best-in-class finding without an LLM.

Resolution ladder (cheapest first):
  1. exact text / content-desc / accessibility-id / resource-id match
  2. containment + fuzzy token matching with intent-aware bonuses
     (editable fields for `input`, checkables for `toggle`, ...)
  3. digit-run anchoring ("account number 1238735444" must land on the
     element that actually contains 1238735444)
Only when the winner is weak or ambiguous does the agent escalate to the
LLM with the compact element table.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import List, Optional

from .parser import Command
from .snapshot import Snapshot, UIElement

_PUNCT = re.compile(r"[^\w\s]")
_WS = re.compile(r"\s+")
_DIGIT_RUN = re.compile(r"\d{4,}")

STOPWORDS = {"the", "a", "an", "button", "field", "box", "link", "icon",
             "tab", "option", "item", "text", "input"}


def norm(s: str) -> str:
    return _WS.sub(" ", _PUNCT.sub(" ", (s or "").lower())).strip()


def _tokens(s: str) -> set:
    return {t for t in norm(s).split() if t not in STOPWORDS} or set(norm(s).split())


def text_score(target: str, candidate: str) -> float:
    t, c = norm(target), norm(candidate)
    if not t or not c:
        return 0.0
    if t == c:
        return 1.0
    contain = 0.0
    if t in c or c in t:
        contain = 0.82 + 0.13 * (min(len(t), len(c)) / max(len(t), len(c)))
    tt, tc = _tokens(target), _tokens(candidate)
    jac = len(tt & tc) / len(tt | tc) if (tt or tc) else 0.0
    ratio = SequenceMatcher(None, t, c).ratio()
    return max(contain, 0.65 * jac + 0.35 * ratio)


def _initials(s: str) -> str:
    toks = [t for t in norm(s).split() if t]
    return "".join(t[0] for t in toks) if len(toks) >= 2 else ""


def _id_score(target: str, res_id_tail: str) -> float:
    if not res_id_tail:
        return 0.0
    # btn_ok_continue -> "btn ok continue"
    words = re.sub(r"[_\-]", " ", re.sub(r"(?<=[a-z])(?=[A-Z])", " ", res_id_tail))
    score = text_score(target, words)
    # acronym rule: "date of birth" matches id tail "input_dob"
    tin, cin = _initials(target), _initials(words)
    word_toks = set(norm(words).split())
    target_toks = set(norm(target).split())
    if (tin and tin in word_toks) or (cin and cin in target_toks):
        score = max(score, 0.9)
    return score


def element_score(cmd: Command, el: UIElement) -> float:
    target = cmd.target or ""
    fields = [
        (el.text, 1.00),
        (el.desc, 0.98),
        (el.hint, 0.96),
        (el.value, 0.90),
    ]
    best = max((text_score(target, f) * w for f, w in fields), default=0.0)
    best = max(best, _id_score(target, el.res_id_tail) * 0.92)

    # digit-run anchoring: "account number 1238735444"
    runs = _DIGIT_RUN.findall(target)
    if runs:
        haystack = " ".join([el.text, el.desc, el.value, el.res_id])
        if any(r in haystack for r in runs):
            best = max(best, 0.9)
            best = min(1.0, best + 0.05)
        else:
            best = min(best, 0.45)

    # intent-aware adjustments
    if cmd.kind == "input":
        best += 0.08 if el.editable else -0.30
    elif cmd.kind == "toggle":
        best += 0.10 if (el.checkable or el.checked is not None) else -0.25
    elif cmd.kind in ("tap", "long_press", "select"):
        if el.clickable or el.enabled:
            best += 0.03
    if not el.enabled and cmd.kind in ("tap", "input", "toggle", "select"):
        best -= 0.15
    return max(0.0, min(1.0, best))


@dataclass
class MatchResult:
    element: Optional[UIElement]
    score: float
    margin: float
    candidates: List[UIElement]     # top-k for LLM escalation

    @property
    def confident(self) -> bool:
        return self.element is not None


def resolve(
    cmd: Command,
    snap: Snapshot,
    accept: float = 0.72,
    margin: float = 0.08,
    strong: float = 0.90,
    top_k: int = 8,
) -> MatchResult:
    if not cmd.target:
        return MatchResult(None, 0.0, 0.0, [])
    scored = sorted(
        ((element_score(cmd, el), el) for el in snap.elements),
        key=lambda p: -p[0],
    )
    scored = [(s, e) for s, e in scored if s > 0.1][:top_k]
    if not scored:
        return MatchResult(None, 0.0, 0.0, [])
    best_s, best_e = scored[0]
    gap = best_s - scored[1][0] if len(scored) > 1 else 1.0
    if best_s >= strong or (best_s >= accept and gap >= margin):
        return MatchResult(best_e, best_s, gap, [e for _, e in scored])
    return MatchResult(None, best_s, gap, [e for _, e in scored])
