"""Natural-language step parser.

Maestro's reliability starts with a *closed, declarative command
vocabulary* — the flow says WHAT, the engine decides HOW.  We adopt the
same idea: plain-English steps are compiled into typed commands by a
deterministic grammar (0 LLM tokens).  Only steps the grammar cannot
understand are sent to the LLM, which must answer in the exact same
command schema, so execution is always deterministic afterwards.

The grammar is typo-tolerant on verbs ("Entet pin as 7807283" -> enter),
because human-authored steps are the input format.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from difflib import get_close_matches
from typing import Optional


@dataclass
class Command:
    kind: str                       # tap|input|set_date|select|toggle|scroll|...
    target: Optional[str] = None    # element description ("ok continue")
    value: Optional[str] = None     # text/date/option value
    direction: Optional[str] = None  # for scroll/swipe
    toggle_state: Optional[str] = None  # "on"|"off"|None(=flip)
    secure: bool = False            # pin/password style field
    maybe_date: bool = False        # value looks like a date / field is date-ish
    raw: str = ""                   # original step text
    meta: dict = field(default_factory=dict)


VERBS = [
    "tap", "click", "press", "enter", "type", "input", "fill", "set",
    "select", "choose", "pick", "turn", "switch", "toggle", "enable",
    "disable", "check", "uncheck", "scroll", "swipe", "assert", "verify",
    "expect", "see", "wait", "launch", "open", "long", "go", "hide",
    "clear", "back",
]

SECURE_TOKENS = {"pin", "password", "passcode", "passphrase", "otp", "cvv", "mpin"}
DATE_FIELD_TOKENS = {
    "date", "dob", "birth", "birthday", "expiry", "expiration",
    "anniversary", "doj", "calendar",
}

_DATE_PATTERNS = [
    # (regex, groups order) — day-first by default, configurable at exec time
    re.compile(r"^(\d{1,2})[\s/\-.](\d{1,2})[\s/\-.](\d{4})$"),
    re.compile(r"^(\d{4})[\s/\-.](\d{1,2})[\s/\-.](\d{1,2})$"),
]
_MONTHS = {
    m: i + 1
    for i, ms in enumerate(
        [
            ("jan", "january"), ("feb", "february"), ("mar", "march"),
            ("apr", "april"), ("may",), ("jun", "june"), ("jul", "july"),
            ("aug", "august"), ("sep", "sept", "september"), ("oct", "october"),
            ("nov", "november"), ("dec", "december"),
        ]
    )
    for m in ms
}
_DATE_WORDS = re.compile(r"^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$")


def parse_date_value(value: str, day_first: bool = True) -> Optional[date]:
    v = value.strip().lower()
    m = _DATE_WORDS.match(v)
    if m and m.group(2) in _MONTHS:
        return date(int(m.group(3)), _MONTHS[m.group(2)], int(m.group(1)))
    m = _DATE_PATTERNS[1].match(v)  # ISO-ish: 1990-01-31
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = _DATE_PATTERNS[0].match(v)
    if m:
        a, b, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        d, mo = (a, b) if day_first else (b, a)
        if mo > 12 and d <= 12:      # auto-repair impossible month
            d, mo = mo, d
        try:
            return date(year, mo, d)
        except ValueError:
            return None
    return None


def _fix_verb(word: str) -> str:
    """Typo-tolerant verb normalisation: 'entet' -> 'enter'."""
    w = word.lower()
    if w in VERBS:
        return w
    close = get_close_matches(w, VERBS, n=1, cutoff=0.75)
    return close[0] if close else w


def _is_secure(fieldname: str) -> bool:
    return bool(set(re.findall(r"[a-z]+", fieldname.lower())) & SECURE_TOKENS)


def _is_dateish(fieldname: str) -> bool:
    return bool(set(re.findall(r"[a-z]+", fieldname.lower())) & DATE_FIELD_TOKENS)


def parse_step(text: str, day_first: bool = True) -> Optional[Command]:
    """Deterministic grammar. Returns None when the step needs the LLM."""
    raw = text.strip()
    s = re.sub(r"\s+", " ", raw).strip().rstrip(".")
    if not s:
        return None
    words = s.split(" ")
    words[0] = _fix_verb(words[0])
    s = " ".join(words)
    low = s.lower()

    # -- simple device/system commands ----------------------------------
    m = re.match(r"^wait(?: for)? (\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|ms)?$", low)
    if m:
        val = float(m.group(1))
        if m.group(2) == "ms":
            val /= 1000.0
        return Command(kind="wait", value=str(val), raw=raw)
    if re.match(r"^(go |press |navigate )?back$", low):
        return Command(kind="back", raw=raw)
    if re.match(r"^(go |press )?home$", low):
        return Command(kind="home", raw=raw)
    if re.match(r"^hide (the )?keyboard$", low):
        return Command(kind="hide_keyboard", raw=raw)
    m = re.match(r"^(launch|open)( the)?( app)?\s+(?P<app>[\w.]+)$", low)
    if m and ("." in m.group("app") or m.group(3)):
        return Command(kind="launch", target=m.group("app"), raw=raw)
    m = re.match(r"^press (enter|done|search|go|next|delete|tab)( key)?$", low)
    if m:
        return Command(kind="press_key", value=m.group(1), raw=raw)

    # -- toggles ---------------------------------------------------------
    m = re.match(r"^(?:turn|switch) (on|off) (.+)$", low)
    if m:
        return Command(kind="toggle", target=m.group(2), toggle_state=m.group(1), raw=raw)
    m = re.match(r"^(?:turn|switch) (.+?) (on|off)$", low)
    if m:
        return Command(kind="toggle", target=m.group(1), toggle_state=m.group(2), raw=raw)
    m = re.match(r"^(enable|disable) (.+)$", low)
    if m:
        state = "on" if m.group(1) == "enable" else "off"
        return Command(kind="toggle", target=m.group(2), toggle_state=state, raw=raw)
    m = re.match(r"^toggle (.+?)(?: (on|off))?$", low)
    if m:
        return Command(kind="toggle", target=m.group(1), toggle_state=m.group(2), raw=raw)
    m = re.match(r"^(check|uncheck|tick|untick) (?!that )(.+)$", low)
    if m and not re.search(r"(visible|displayed|exists|shown)", low):
        state = "on" if m.group(1) in ("check", "tick") else "off"
        return Command(kind="toggle", target=m.group(2), toggle_state=state, raw=raw)

    # -- pickers / dropdowns ---------------------------------------------
    m = re.match(r"^(?:select|choose|pick) (.+?) (?:from|in|on) (.+)$", low)
    if m:
        return Command(kind="select", target=m.group(2), value=m.group(1), raw=raw)
    m = re.match(r"^(?:select|choose|pick) (.+)$", low)
    if m:
        return Command(kind="select", target=None, value=m.group(1), raw=raw)

    # -- explicit dates ----------------------------------------------------
    m = re.match(r"^set (.+?) (?:to|as) (.+)$", low)
    if m and (_is_dateish(m.group(1)) or parse_date_value(m.group(2), day_first)):
        return Command(
            kind="set_date", target=m.group(1), value=m.group(2),
            maybe_date=True, raw=raw,
        )

    # -- text entry --------------------------------------------------------
    m = re.match(r"^(?:enter|type|input|fill|set) (.+?) (?:as|with|to|=) (.+)$", low)
    if m:
        fieldname, value = m.group(1), m.group(2)
        # keep the user's original casing for the value
        orig_value = raw[len(raw) - len(value):] if raw.lower().endswith(value) else value
        cmd = Command(
            kind="input", target=fieldname, value=orig_value.strip(),
            secure=_is_secure(fieldname), raw=raw,
        )
        if _is_dateish(fieldname) and parse_date_value(value, day_first):
            cmd.maybe_date = True
        return cmd
    m = re.match(r"^(?:enter|type|input) [\"']?(.+?)[\"']? (?:in|into|on) (?:the )?(.+)$", low)
    if m:
        fieldname = m.group(2)
        return Command(
            kind="input", target=fieldname, value=m.group(1),
            secure=_is_secure(fieldname),
            maybe_date=_is_dateish(fieldname) and bool(parse_date_value(m.group(1), day_first)),
            raw=raw,
        )

    # -- scrolling ---------------------------------------------------------
    m = re.match(r"^(?:scroll|swipe) (up|down|left|right)(?: (?:to|until) (.+))?$", low)
    if m:
        return Command(kind="scroll", direction=m.group(1), target=m.group(2), raw=raw)
    m = re.match(r"^scroll (?:to|until) (.+)$", low)
    if m:
        return Command(kind="scroll", target=m.group(1), raw=raw)

    # -- assertions ----------------------------------------------------------
    m = re.match(
        r"^(?:assert|verify|expect|see|check)(?: that)? [\"']?(.+?)[\"']?"
        r"(?: is)?(?: (not))? ?(?:visible|displayed|shown|exists|present|on(?: the)? screen)?$",
        low,
    )
    if m and re.match(r"^(assert|verify|expect|see)", low):
        kind = "assert_not_visible" if m.group(2) else "assert_visible"
        return Command(kind=kind, target=m.group(1), raw=raw)

    # -- taps (last: broadest pattern) ----------------------------------------
    m = re.match(r"^long ?(?:press|tap)(?: on)? (.+)$", low)
    if m:
        return Command(kind="long_press", target=m.group(1), raw=raw)
    m = re.match(r"^(?:tap|click|press)(?: on)?(?: the)? (.+?)(?: button| link| icon| tab)?$", low)
    if m:
        return Command(kind="tap", target=m.group(1), raw=raw)

    return None
