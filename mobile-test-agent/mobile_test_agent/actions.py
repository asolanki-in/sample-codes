"""Action executors: HOW a command is performed on the device.

Like Maestro, taps are performed by coordinates resolved from the live
hierarchy (the most robust cross-platform primitive), with locator-based
fallbacks.  Complex widgets get dedicated deterministic handlers:

  * date pickers  — Android calendar & spinner modes, iOS picker wheels
  * spinners / dropdowns / option lists
  * toggles, switches, checkboxes (state-aware: only tap when needed)
  * scroll-to-find with end-of-list detection via snapshot hashing
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import date
from typing import Optional

from .config import Config
from .matcher import norm, resolve, text_score
from .mcp_client import AppiumMCP, ToolCallError
from .parser import Command, parse_date_value
from .snapshot import (
    ANDROID_PICKER, IOS_PICKER, Snapshot, UIElement, parse_page_source,
)

log = logging.getLogger(__name__)

MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
CONFIRM_WORDS = ("ok", "done", "set", "confirm", "apply", "save", "continue")


class ActionError(RuntimeError):
    pass


class Device:
    """Snapshot-aware device façade shared by executor and verifier."""

    def __init__(self, mcp: AppiumMCP, cfg: Config) -> None:
        self.mcp = mcp
        self.cfg = cfg
        self._last: Optional[Snapshot] = None

    async def snapshot(self) -> Snapshot:
        xml = await self.mcp.page_source()
        self._last = parse_page_source(xml, self.cfg.platform)
        return self._last

    async def stable_snapshot(self, timeout: Optional[float] = None) -> Snapshot:
        """Maestro-style auto-wait: poll until two consecutive snapshots
        hash identically (UI idle), bounded by `stable_timeout_s`."""
        timeout = timeout if timeout is not None else self.cfg.stable_timeout_s
        deadline = asyncio.get_event_loop().time() + timeout
        prev = await self.snapshot()
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(self.cfg.stable_poll_interval_s)
            cur = await self.snapshot()
            if cur.hash == prev.hash:
                return cur
            prev = cur
        return prev  # best effort — never hard-fail on animation

    async def tap(self, el: UIElement) -> None:
        x, y = el.center
        try:
            await self.mcp.w3c_tap(x, y)
            return
        except ToolCallError:
            pass
        try:  # fallback 1: server-native gesture tool
            await self.mcp.try_call("gesture", [
                {"action": "tap", "x": x, "y": y},
                {"gesture": "tap", "x": x, "y": y},
            ])
            return
        except ToolCallError:
            pass
        # fallback 2: locator-based click via find tool
        strategy, selector = self._locator(el)
        await self.mcp.try_call("find", [
            {"strategy": strategy, "selector": selector, "action": "click"},
            {"strategy": strategy, "selector": selector, "click": True},
        ])

    async def long_press(self, el: UIElement, ms: int = 900) -> None:
        x, y = el.center
        await self.mcp.w3c_tap(x, y, hold_ms=ms)

    async def swipe_dir(self, direction: str, container: Optional[UIElement],
                        snap: Snapshot, factor: float = 0.55) -> None:
        if container:
            l, t, r, b = container.bounds
        else:
            l, t, r, b = 0, 0, *snap.screen_size
        cx, cy = (l + r) // 2, (t + b) // 2
        dx = int((r - l) * factor / 2)
        dy = int((b - t) * factor / 2)
        vec = {
            "down": (cx, cy + dy, cx, cy - dy),   # reveal content below
            "up": (cx, cy - dy, cx, cy + dy),
            "left": (cx + dx, cy, cx - dx, cy),
            "right": (cx - dx, cy, cx + dx, cy),
        }[direction]
        await self.mcp.w3c_swipe(*vec, duration_ms=450)

    async def type_text(self, el: UIElement, value: str) -> None:
        await self.tap(el)
        await asyncio.sleep(0.25)
        strategy, selector = self._locator(el)
        try:
            await self.mcp.try_call("set_value", [
                {"text": value, "strategy": strategy, "selector": selector},
                {"text": value},
                {"value": value},
            ])
            return
        except ToolCallError:
            pass
        # last resort: W3C key actions, char by char (slow but universal)
        keys = []
        for ch in value:
            keys.append({"type": "keyDown", "value": ch})
            keys.append({"type": "keyUp", "value": ch})
        await self.mcp.call("perform_actions", {"actions": [
            {"type": "key", "id": "kbd", "actions": keys}
        ]})

    async def hide_keyboard(self) -> None:
        try:
            await self.mcp.try_call("keyboard", [{"action": "hide"}, {}])
        except ToolCallError:
            pass  # keyboard may simply not be shown

    @staticmethod
    def _locator(el: UIElement) -> tuple:
        if el.res_id:
            return ("id", el.res_id)
        if el.desc:
            return ("accessibility id", el.desc)
        if el.text:
            return ("xpath", f'//*[@text={_xq(el.text)} or @label={_xq(el.text)}]')
        return ("xpath", f"//{el.full_tag or '*'}")


def _xq(s: str) -> str:
    return "'" + s.replace("'", "’") + "'" if "'" in s else f"'{s}'"


# ---------------------------------------------------------------------------
# Complex-widget helpers
# ---------------------------------------------------------------------------

async def scroll_to_find(dev: Device, cmd: Command, cfg: Config):
    """Scroll-to-find with end-of-list detection (hash stops changing)."""
    from .matcher import resolve as _resolve
    for direction in ("down", "up"):
        prev_hash = None
        for _ in range(cfg.scroll_max_swipes):
            snap = await dev.snapshot()
            res = _resolve(cmd, snap, cfg.match_accept_score,
                           cfg.match_accept_margin, cfg.match_strong_score)
            if res.confident:
                return res, snap
            if snap.hash == prev_hash:      # end of list reached
                break
            prev_hash = snap.hash
            containers = snap.scroll_containers()
            await dev.swipe_dir(direction, containers[0] if containers else None, snap)
            await asyncio.sleep(0.2)
    snap = await dev.snapshot()
    return _resolve(cmd, snap, cfg.match_accept_score,
                    cfg.match_accept_margin, cfg.match_strong_score), snap


async def set_toggle(dev: Device, el: UIElement, desired: Optional[str]) -> bool:
    """State-aware toggle: read state, tap only if it differs, verify."""
    current = el.checked
    want = None if desired is None else (desired == "on")
    if want is not None and current is not None and current == want:
        return True                                  # already correct: 0 actions
    await dev.tap(el)
    snap = await dev.stable_snapshot(timeout=4)
    fresh = _refind(snap, el)
    if fresh is None or fresh.checked is None:
        return want is None                          # unverifiable flip
    if want is None:
        return current is None or fresh.checked != current
    if fresh.checked != want:                        # one corrective retry
        await dev.tap(fresh)
        snap = await dev.stable_snapshot(timeout=4)
        fresh = _refind(snap, fresh)
        return bool(fresh and fresh.checked == want)
    return True


def _refind(snap: Snapshot, old: UIElement) -> Optional[UIElement]:
    for el in snap.elements:
        if el.res_id and el.res_id == old.res_id:
            return el
        if el.center == old.center and el.tag == old.tag:
            return el
    return None


def find_picker(snap: Snapshot) -> Optional[UIElement]:
    for el in snap.elements:
        if el.full_tag in ANDROID_PICKER or el.full_tag in IOS_PICKER:
            return el
    return None


async def set_date(dev: Device, cmd: Command, cfg: Config, snap: Snapshot,
                   field_el: Optional[UIElement]) -> bool:
    """Universal date entry: plain field -> type; picker dialog -> drive it."""
    target = parse_date_value(cmd.value or "", cfg.day_first_dates)
    if target is None:
        raise ActionError(f"cannot parse date from '{cmd.value}'")

    # If the matched field is an editable text input, just type the date.
    if field_el is not None and field_el.editable:
        formatted = target.strftime("%d/%m/%Y" if cfg.day_first_dates else "%m/%d/%Y")
        await dev.type_text(field_el, formatted)
        return True

    # Otherwise tap the field to open the platform picker.
    if field_el is not None and find_picker(snap) is None:
        await dev.tap(field_el)
        snap = await dev.stable_snapshot(timeout=6)

    if cfg.platform == "ios":
        ok = await _ios_picker_wheels(dev, snap, target)
    else:
        ok = await _android_date_picker(dev, snap, target)
    if not ok:
        return False
    await _tap_confirm(dev)
    return True


async def _tap_confirm(dev: Device) -> None:
    snap = await dev.snapshot()
    for el in snap.elements:
        label = norm(el.text or el.desc)
        if label in CONFIRM_WORDS and (el.clickable or el.enabled):
            await dev.tap(el)
            return


async def _ios_picker_wheels(dev: Device, snap: Snapshot, target: date) -> bool:
    """XCUITest lets you set a picker wheel's value directly."""
    wheels = [e for e in snap.elements if e.full_tag == "XCUIElementTypePickerWheel"]
    if not wheels:
        return False
    wanted = {
        "month": MONTH_NAMES[target.month - 1],
        "day": str(target.day),
        "year": str(target.year),
    }
    values = list(wanted.values()) if len(wheels) >= 3 else [
        f"{MONTH_NAMES[target.month - 1]} {target.day}"  # combined wheel
    ]
    for wheel, val in zip(wheels, values):
        strategy, selector = Device._locator(wheel)
        try:
            await dev.mcp.try_call("set_value", [
                {"text": val, "strategy": strategy, "selector": selector},
                {"value": val, "strategy": strategy, "selector": selector},
            ])
        except ToolCallError:
            return False
        await asyncio.sleep(0.3)
    return True


async def _android_date_picker(dev: Device, snap: Snapshot, target: date) -> bool:
    if any(e.full_tag == "android.widget.NumberPicker" for e in snap.elements):
        return await _android_spinner_picker(dev, target)
    return await _android_calendar_picker(dev, target)


async def _android_spinner_picker(dev: Device, target: date) -> bool:
    """Spinner-mode DatePicker: three NumberPicker columns to spin."""
    wanted = [str(target.day), MONTH_NAMES[target.month - 1][:3], str(target.year)]
    snap = await dev.snapshot()
    columns = [e for e in snap.elements
               if e.full_tag == "android.widget.NumberPicker"]
    if not columns:
        return False
    columns.sort(key=lambda e: e.bounds[0])           # left→right: d, m, y (locale-naive)
    ok = True
    for col, want in zip(columns, wanted):
        ok &= await _spin_column(dev, col, want)
    return ok


async def _spin_column(dev: Device, column: UIElement, want: str,
                       max_spins: int = 24) -> bool:
    """Swipe a NumberPicker column until its value matches `want`."""
    want_n = norm(want)
    numeric = want_n.isdigit()
    for _ in range(max_spins):
        snap = await dev.snapshot()
        col = _refind(snap, column) or column
        current = _column_value(snap, col)
        if current is None:
            return False
        if norm(current) == want_n or text_score(want, current) >= 0.9:
            return True
        if numeric and current.strip().isdigit():
            direction = "down" if int(current) < int(want) else "up"
        else:
            direction = "down"
        await dev.swipe_dir(direction, col, snap, factor=0.35)
        await asyncio.sleep(0.25)
    return False


def _column_value(snap: Snapshot, column: UIElement) -> Optional[str]:
    l, t, r, b = column.bounds
    cy = (t + b) / 2
    best, best_d = None, 1e9
    for el in snap.elements:
        if not (el.text or el.value):
            continue
        el_, et, er, eb = el.bounds
        if el_ >= l - 4 and er <= r + 4 and et >= t and eb <= b:
            d = abs((et + eb) / 2 - cy)
            if d < best_d:
                best, best_d = (el.text or el.value), d
    return best


async def _android_calendar_picker(dev: Device, target: date) -> bool:
    """Calendar-mode DatePicker: year list -> month arrows -> day cell."""
    snap = await dev.snapshot()

    # 1. year — tap the year header, then scroll the year list
    year_el = _find_text(snap, re.compile(r"^\d{4}$"))
    if year_el is not None and year_el.text != str(target.year):
        await dev.tap(year_el)
        await dev.stable_snapshot(timeout=4)
        cmd = Command(kind="tap", target=str(target.year), raw=f"year {target.year}")
        res, snap = await scroll_to_find(dev, cmd, dev.cfg)
        if not res.confident:
            return False
        await dev.tap(res.element)
        snap = await dev.stable_snapshot(timeout=4)

    # 2. month — use next/prev arrows, bounded to 4 years of clicks
    for _ in range(48):
        snap = await dev.snapshot()
        shown = _shown_month_year(snap)
        if shown is None:
            break
        sm, sy = shown
        if (sy, sm) == (target.year, target.month):
            break
        forward = (sy, sm) < (target.year, target.month)
        arrow = _find_desc(snap, "next month" if forward else "previous month")
        if arrow is None:
            break
        await dev.tap(arrow)
        await asyncio.sleep(0.3)

    # 3. day — cells carry the full date in content-desc, or bare day text
    snap = await dev.snapshot()
    full = f"{target.day:02d} {MONTH_NAMES[target.month - 1]} {target.year}"
    for el in snap.elements:
        d = norm(el.desc)
        if d and (norm(full) in d or
                  (str(target.day) in d.split() and MONTH_NAMES[target.month - 1].lower() in d)):
            await dev.tap(el)
            return True
    day_el = _find_text(snap, re.compile(rf"^{target.day}$"))
    if day_el is not None:
        await dev.tap(day_el)
        return True
    return False


def _find_text(snap: Snapshot, pattern: re.Pattern) -> Optional[UIElement]:
    for el in snap.elements:
        if el.text and pattern.match(el.text.strip()):
            return el
    return None


def _find_desc(snap: Snapshot, needle: str) -> Optional[UIElement]:
    for el in snap.elements:
        if needle in norm(el.desc):
            return el
    return None


async def select_option(dev: Device, cmd: Command, cfg: Config,
                        snap: Snapshot, anchor: Optional[UIElement]) -> bool:
    """Dropdown/spinner/option-list: open (if anchored), then pick value."""
    if anchor is not None:
        await dev.tap(anchor)
        await dev.stable_snapshot(timeout=5)
    option_cmd = Command(kind="tap", target=cmd.value, raw=cmd.raw)
    res, _ = await scroll_to_find(dev, option_cmd, cfg)
    if not res.confident:
        return False
    await dev.tap(res.element)
    return True
