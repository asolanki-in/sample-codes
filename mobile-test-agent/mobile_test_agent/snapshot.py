"""UI snapshot: page-source XML -> distilled element table.

This is where the token savings come from.  A raw Appium page source is
20–100 KB of XML; the LLM never sees it.  We parse it into a compact
indexed table of *interactive-or-labelled* elements (typically 5–10% of
the raw size), which is:

  1. matched deterministically first (0 tokens), and
  2. only shown to the LLM — truncated — when matching is ambiguous.

The snapshot hash doubles as Maestro-style "UI is idle" detection: we
poll until two consecutive hashes agree instead of ever sleeping blind.
"""
from __future__ import annotations

import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

_BOUNDS_RE = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")

ANDROID_EDITABLE = {"android.widget.EditText", "android.widget.AutoCompleteTextView",
                    "android.widget.MultiAutoCompleteTextView"}
IOS_EDITABLE = {"XCUIElementTypeTextField", "XCUIElementTypeSecureTextField",
                "XCUIElementTypeTextView", "XCUIElementTypeSearchField"}
IOS_CHECKABLE = {"XCUIElementTypeSwitch", "XCUIElementTypeToggle"}
IOS_PICKER = {"XCUIElementTypePickerWheel", "XCUIElementTypeDatePicker",
              "XCUIElementTypePicker"}
ANDROID_PICKER = {"android.widget.DatePicker", "android.widget.TimePicker",
                  "android.widget.NumberPicker", "android.widget.CalendarView",
                  "android.widget.Spinner"}


@dataclass
class UIElement:
    index: int
    tag: str                      # short class, e.g. "EditText" / "Button"
    full_tag: str = ""
    text: str = ""
    desc: str = ""                # content-desc (Android) / label (iOS)
    res_id: str = ""              # resource-id (Android) / name (iOS)
    hint: str = ""
    value: str = ""
    bounds: Tuple[int, int, int, int] = (0, 0, 0, 0)
    clickable: bool = False
    enabled: bool = True
    editable: bool = False
    checkable: bool = False
    checked: Optional[bool] = None
    password: bool = False
    scrollable: bool = False
    selected: bool = False
    displayed: bool = True

    @property
    def center(self) -> Tuple[int, int]:
        l, t, r, b = self.bounds
        return ((l + r) // 2, (t + b) // 2)

    @property
    def area(self) -> int:
        l, t, r, b = self.bounds
        return max(0, r - l) * max(0, b - t)

    @property
    def res_id_tail(self) -> str:
        return self.res_id.split("/")[-1] if self.res_id else ""

    def state_key(self) -> str:
        """Identity+state string used for screen-change hashing."""
        return "|".join([
            self.tag, self.res_id_tail, self.text[:40], self.desc[:40],
            self.value[:40], str(self.checked), str(self.selected),
        ])

    def brief(self) -> str:
        """One compact line for LLM disambiguation prompts."""
        bits = [f"[{self.index}] {self.tag}"]
        if self.text:
            bits.append(f'text="{self.text[:60]}"')
        if self.desc and self.desc != self.text:
            bits.append(f'desc="{self.desc[:60]}"')
        if self.hint:
            bits.append(f'hint="{self.hint[:40]}"')
        if self.res_id_tail:
            bits.append(f"id={self.res_id_tail}")
        if self.value and self.value != self.text:
            bits.append(f'value="{self.value[:40]}"')
        flags = []
        if self.editable:
            flags.append("editable")
        if self.password:
            flags.append("secure")
        if self.checkable or self.checked is not None:
            flags.append(f"checked={'on' if self.checked else 'off'}")
        if self.scrollable:
            flags.append("scrollable")
        if self.selected:
            flags.append("selected")
        if not self.enabled:
            flags.append("disabled")
        if flags:
            bits.append("(" + ",".join(flags) + ")")
        return " ".join(bits)


@dataclass
class Snapshot:
    elements: List[UIElement] = field(default_factory=list)
    screen_size: Tuple[int, int] = (1080, 1920)
    hash: str = ""
    platform: str = "android"

    def listing(self, max_chars: int = 6000) -> str:
        lines, used = [], 0
        # interactive elements first so truncation drops decoration, not targets
        ordered = sorted(
            self.elements,
            key=lambda e: (not (e.clickable or e.editable or e.checkable), e.index),
        )
        for el in ordered:
            line = el.brief()
            if used + len(line) + 1 > max_chars:
                lines.append("... (truncated)")
                break
            lines.append(line)
            used += len(line) + 1
        return "\n".join(lines)

    def by_index(self, idx: int) -> Optional[UIElement]:
        for el in self.elements:
            if el.index == idx:
                return el
        return None

    def scroll_containers(self) -> List[UIElement]:
        return sorted(
            (e for e in self.elements if e.scrollable),
            key=lambda e: -e.area,
        )


def _parse_bounds(val: str) -> Tuple[int, int, int, int]:
    m = _BOUNDS_RE.match(val or "")
    if not m:
        return (0, 0, 0, 0)
    return tuple(int(g) for g in m.groups())  # type: ignore[return-value]


def _short(tag: str) -> str:
    t = tag.split(".")[-1]
    return t[len("XCUIElementType"):] if t.startswith("XCUIElementType") else t


def _bool(v: Optional[str]) -> bool:
    return (v or "").lower() == "true"


def parse_page_source(xml_text: str, platform: str = "android") -> Snapshot:
    xml_text = xml_text.strip()
    root = ET.fromstring(xml_text)
    snap = Snapshot(platform=platform.lower())
    elements: List[UIElement] = []
    idx = 0
    screen_w, screen_h = 0, 0

    for node in root.iter():
        a = node.attrib
        if not a:
            continue
        if snap.platform == "ios":
            try:
                x, y = int(float(a.get("x", 0))), int(float(a.get("y", 0)))
                w, h = int(float(a.get("width", 0))), int(float(a.get("height", 0)))
            except ValueError:
                x = y = w = h = 0
            bounds = (x, y, x + w, y + h)
            full = a.get("type", node.tag)
            visible = a.get("visible", "true").lower() != "false"
            el = UIElement(
                index=0, tag=_short(full), full_tag=full,
                text=a.get("label", "") or "",
                desc=a.get("name", "") or "",
                res_id=a.get("name", "") or "",
                value=a.get("value", "") or "",
                bounds=bounds,
                clickable=full in ("XCUIElementTypeButton", "XCUIElementTypeCell",
                                   "XCUIElementTypeLink", "XCUIElementTypeImage",
                                   "XCUIElementTypeStaticText") or _bool(a.get("accessible")),
                enabled=a.get("enabled", "true").lower() != "false",
                editable=full in IOS_EDITABLE,
                checkable=full in IOS_CHECKABLE,
                checked=(a.get("value") in ("1", "true"))
                if full in IOS_CHECKABLE else None,
                password=full == "XCUIElementTypeSecureTextField",
                scrollable=full in ("XCUIElementTypeScrollView", "XCUIElementTypeTable",
                                    "XCUIElementTypeCollectionView"),
                selected=_bool(a.get("selected")),
                displayed=visible,
            )
        else:
            bounds = _parse_bounds(a.get("bounds", ""))
            full = a.get("class", node.tag)
            el = UIElement(
                index=0, tag=_short(full), full_tag=full,
                text=a.get("text", "") or "",
                desc=a.get("content-desc", "") or "",
                res_id=a.get("resource-id", "") or "",
                hint=a.get("hint", "") or "",
                bounds=bounds,
                clickable=_bool(a.get("clickable")) or _bool(a.get("long-clickable")),
                enabled=a.get("enabled", "true").lower() != "false",
                editable=full in ANDROID_EDITABLE or _bool(a.get("editable")),
                checkable=_bool(a.get("checkable")),
                checked=_bool(a.get("checked")) if _bool(a.get("checkable")) else None,
                password=_bool(a.get("password")),
                scrollable=_bool(a.get("scrollable")),
                selected=_bool(a.get("selected")),
                displayed=a.get("displayed", "true").lower() != "false",
            )
            # Android: an empty EditText shows its hint in `text`
            if el.editable and not el.hint and el.text and not a.get("hint"):
                pass  # cannot distinguish reliably; matcher treats text+hint alike

        screen_w = max(screen_w, el.bounds[2])
        screen_h = max(screen_h, el.bounds[3])

        keep = el.displayed and el.area > 0 and (
            el.clickable or el.editable or el.checkable or el.scrollable
            or el.text or el.desc or el.value
            or el.full_tag in ANDROID_PICKER or el.full_tag in IOS_PICKER
        )
        if keep:
            el.index = idx
            idx += 1
            elements.append(el)

    snap.elements = elements
    snap.screen_size = (screen_w or 1080, screen_h or 1920)
    snap.hash = hashlib.sha1(
        "\n".join(e.state_key() for e in elements).encode()
    ).hexdigest()
    return snap
