"""Orchestrator: the find → act → verify loop.

Escalation ladder per step (cheapest first — this is the token budget):

  parse:   grammar (0 tokens) ────────────► LLM parse (~150 tokens, rare)
  find:    fuzzy matcher (0 tokens) ─► scroll-to-find (0) ─► LLM pick
           (~300 tokens, rare) ─► appium_ai vision (optional)
  act:     deterministic executors (0 tokens)
  verify:  postcondition on fresh snapshot (0 tokens)
  recover: wait-for-idle → re-find → alternate action path → retry (×N)

A typical flow therefore costs *zero* LLM tokens; the LLM only pays for
genuinely ambiguous screens, which is how this stays far below
plan-every-step agents (DroidRun averages ~3,225 tokens per task).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from .actions import (
    ActionError, Device, scroll_to_find, select_option, set_date, set_toggle,
)
from .config import Config
from .llm import (
    COMMAND_SCHEMA, DISAMBIG_SCHEMA, LLMUnavailable, OllamaLLM,
)
from .matcher import MatchResult, resolve
from .mcp_client import AppiumMCP, ToolCallError
from .parser import Command, parse_date_value, parse_step
from .snapshot import Snapshot, UIElement
from . import verify as V

log = logging.getLogger(__name__)


@dataclass
class StepResult:
    step: str
    status: str            # PASSED | PASSED_UNVERIFIED | FAILED | SKIPPED
    attempts: int = 0
    detail: str = ""
    duration_s: float = 0.0
    llm_used: bool = False


@dataclass
class RunReport:
    results: List[StepResult] = field(default_factory=list)
    token_usage: dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return all(r.status.startswith("PASSED") or r.status == "SKIPPED"
                   for r in self.results)

    def as_dict(self) -> dict:
        return {
            "passed": self.passed,
            "steps": [r.__dict__ for r in self.results],
            "token_usage": self.token_usage,
        }


class MobileTestAgent:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.mcp = AppiumMCP(cfg)
        self.llm = OllamaLLM(cfg)
        self.dev = Device(self.mcp, cfg)

    # ---- lifecycle ------------------------------------------------------
    async def start(self) -> None:
        await self.mcp.start()
        if self.cfg.create_session:
            await self._ensure_session()

    async def _ensure_session(self) -> None:
        caps = self.cfg.load_capabilities()
        try:
            await self.mcp.try_call("session", [
                {"action": "create", "capabilities": caps},
                {"action": "create"},
                {"capabilities": caps},
            ])
        except ToolCallError as exc:
            log.warning("session create failed (%s); assuming server "
                        "auto-manages the session", exc)

    async def close(self) -> None:
        await self.mcp.close()

    # ---- flow running -----------------------------------------------------
    async def run_flow(self, steps: List[str]) -> RunReport:
        report = RunReport()
        for step in steps:
            step = step.strip()
            if not step or step.startswith("#"):
                continue
            result = await self.run_step(step)
            report.results.append(result)
            log.info("%-18s %s  (%s)", result.status, step, result.detail)
            if result.status == "FAILED" and not self.cfg.continue_on_failure:
                break
        report.token_usage = self.llm.usage.as_dict()
        return report

    async def run_step(self, text: str) -> StepResult:
        t0 = time.monotonic()
        result = StepResult(step=text, status="FAILED")

        cmd = parse_step(text, self.cfg.day_first_dates)
        if cmd is None:
            cmd = self._llm_parse(text)
            result.llm_used = cmd is not None
        if cmd is None:
            result.detail = "could not understand step (grammar + LLM failed)"
            result.duration_s = time.monotonic() - t0
            return result

        deadline = t0 + self.cfg.step_timeout_s
        last_detail = ""
        for attempt in range(1, self.cfg.max_attempts + 1):
            result.attempts = attempt
            try:
                verification = await self._attempt(cmd, result)
                if verification.ok:
                    result.status = "PASSED_UNVERIFIED" if verification.weak else "PASSED"
                    result.detail = verification.detail
                    result.duration_s = time.monotonic() - t0
                    return result
                last_detail = verification.detail
            except (ActionError, ToolCallError) as exc:
                last_detail = str(exc)
            if time.monotonic() > deadline:
                last_detail += " (step timeout)"
                break
            # recovery between attempts: settle UI, drop keyboard, re-snapshot
            await self.dev.hide_keyboard()
            await self.dev.stable_snapshot(timeout=3)
            log.info("retrying step (attempt %d): %s — %s", attempt + 1, text, last_detail)

        result.detail = last_detail
        result.duration_s = time.monotonic() - t0
        return result

    # ---- one find→act→verify attempt --------------------------------------
    async def _attempt(self, cmd: Command, result: StepResult) -> V.Verification:
        dev, cfg = self.dev, self.cfg

        # commands with no target element
        if cmd.kind == "wait":
            await asyncio.sleep(float(cmd.value or 1))
            return V.Verification(True, "waited")
        if cmd.kind == "back":
            await self.mcp.try_call("device", [
                {"action": "back"}, {"action": "press_back"}, {"key": "back"}])
            return V.Verification(True, "back pressed", weak=True)
        if cmd.kind == "home":
            await self.mcp.try_call("device", [{"action": "home"}, {"key": "home"}])
            return V.Verification(True, "home pressed", weak=True)
        if cmd.kind == "hide_keyboard":
            await dev.hide_keyboard()
            return V.Verification(True, "keyboard hidden", weak=True)
        if cmd.kind == "launch":
            await self.mcp.try_call("app_lifecycle", [
                {"action": "launch", "appId": cmd.target},
                {"action": "activate", "appId": cmd.target},
                {"appId": cmd.target},
            ])
            await dev.stable_snapshot()
            return V.Verification(True, f"launched {cmd.target}", weak=True)
        if cmd.kind == "press_key":
            await self.mcp.try_call("keyboard", [
                {"action": "press", "key": cmd.value}, {"key": cmd.value}])
            return V.Verification(True, f"pressed {cmd.value}", weak=True)

        # assertions: wait-for-condition rather than instant check
        if cmd.kind in ("assert_visible", "assert_not_visible"):
            deadline = time.monotonic() + cfg.wait_for_element_timeout_s
            while True:
                snap = await dev.snapshot()
                ver = V.verify_visible(snap, cmd, cfg.match_accept_score)
                if ver.ok or time.monotonic() > deadline:
                    return ver
                await asyncio.sleep(cfg.stable_poll_interval_s)

        # bare directional scroll
        if cmd.kind == "scroll" and not cmd.target:
            snap = await dev.stable_snapshot(timeout=3)
            containers = snap.scroll_containers()
            await dev.swipe_dir(cmd.direction or "down",
                                containers[0] if containers else None, snap)
            return V.Verification(True, f"scrolled {cmd.direction}")

        # ---------- FIND ----------
        before = await dev.stable_snapshot()
        match = resolve(cmd, before, cfg.match_accept_score,
                        cfg.match_accept_margin, cfg.match_strong_score)
        if not match.confident and cmd.kind != "select":
            match, before = await scroll_to_find(dev, cmd, cfg)
        if not match.confident and match.candidates:
            picked = self._llm_disambiguate(cmd, before, match)
            if picked is not None:
                match = MatchResult(picked, 1.0, 1.0, match.candidates)
                result.llm_used = True
        if not match.confident:
            if cmd.kind == "select" and cmd.target is None:
                pass  # select can work from the option value alone
            elif cfg.enable_vision_fallback:
                return await self._vision_fallback(cmd, result)
            else:
                return V.Verification(
                    False,
                    f"element not found for '{cmd.target}' "
                    f"(best score {match.score:.2f})",
                )
        el = match.element

        # ---------- ACT + VERIFY ----------
        if cmd.kind in ("tap", "long_press"):
            if cmd.kind == "tap":
                await dev.tap(el)
            else:
                await dev.long_press(el)
            after = await dev.stable_snapshot()
            return V.verify_tap(before, after, el)

        if cmd.kind == "input" and not cmd.maybe_date:
            await dev.type_text(el, cmd.value or "")
            after = await dev.stable_snapshot(timeout=4)
            ver = V.verify_input(after, el, cmd)
            if ver.ok:
                await dev.hide_keyboard()
            return ver

        if cmd.kind in ("set_date",) or (cmd.kind == "input" and cmd.maybe_date):
            ok = await set_date(dev, cmd, cfg, before, el)
            if not ok:
                return V.Verification(False, "date picker interaction failed")
            after = await dev.stable_snapshot(timeout=4)
            d = parse_date_value(cmd.value or "", cfg.day_first_dates)
            variants = []
            if d:
                variants = [d.strftime(f) for f in
                            ("%d/%m/%Y", "%m/%d/%Y", "%d %b %Y", "%B %d, %Y",
                             "%Y-%m-%d", "%d-%m-%Y")]
            return V.verify_date_shown(after, el, variants)

        if cmd.kind == "toggle":
            ok = await set_toggle(dev, el, cmd.toggle_state)
            return V.Verification(ok, "toggle state verified" if ok
                                  else "toggle did not reach desired state")

        if cmd.kind == "select":
            ok = await select_option(dev, cmd, cfg, before, el)
            if not ok:
                return V.Verification(False, f"option '{cmd.value}' not found")
            after = await dev.stable_snapshot(timeout=4)
            shown = V.verify_visible(
                after, Command(kind="assert_visible", target=cmd.value, raw=cmd.raw),
                cfg.match_accept_score)
            return V.Verification(True, f"selected '{cmd.value}'",
                                  weak=not shown.ok)

        if cmd.kind == "scroll":  # scroll to <target> — finding it IS the pass
            return V.Verification(True, f"scrolled to '{cmd.target}'")

        return V.Verification(False, f"unsupported command kind: {cmd.kind}")

    # ---- LLM escalations ------------------------------------------------
    def _llm_parse(self, text: str) -> Optional[Command]:
        try:
            data = self.llm.chat_json(
                system=(
                    "You compile one mobile-UI test step into one JSON command. "
                    "kinds: tap, long_press, input, set_date, select, toggle, "
                    "scroll, assert_visible, assert_not_visible, wait, back, "
                    "home, hide_keyboard, launch, press_key. "
                    "target = element description; value = text/option/date."
                ),
                user=text,
                schema=COMMAND_SCHEMA,
            )
        except LLMUnavailable as exc:
            log.warning("LLM parse unavailable: %s", exc)
            return None
        if not data.get("kind"):
            return None
        return Command(
            kind=data["kind"], target=data.get("target"),
            value=data.get("value"), direction=data.get("direction"),
            toggle_state=data.get("toggle_state"), raw=text,
        )

    def _llm_disambiguate(self, cmd: Command, snap: Snapshot,
                          match: MatchResult) -> Optional[UIElement]:
        try:
            listing = "\n".join(el.brief() for el in match.candidates)
            data = self.llm.chat_json(
                system=(
                    "Pick the UI element a test step refers to. Reply with its "
                    "index, or null if none of them match."
                ),
                user=f"Step: {cmd.raw}\nCandidate elements:\n{listing}",
                schema=DISAMBIG_SCHEMA,
            )
        except LLMUnavailable:
            return None
        idx = data.get("element_index")
        if idx is None:
            return None
        return next((e for e in match.candidates if e.index == idx), None)

    async def _vision_fallback(self, cmd: Command, result: StepResult) -> V.Verification:
        """Last resort: appium-mcp's own vision tool acts from a screenshot."""
        result.llm_used = True
        try:
            await self.mcp.call("ai", {"instruction": cmd.raw})
            await self.dev.stable_snapshot()
            return V.Verification(True, "performed via vision fallback", weak=True)
        except ToolCallError as exc:
            return V.Verification(False, f"vision fallback failed: {exc}")


# ---------------------------------------------------------------------------
def load_flow(path: str) -> List[str]:
    p = Path(path)
    text = p.read_text()
    if p.suffix in (".yaml", ".yml"):
        import yaml
        data = yaml.safe_load(text)
        if isinstance(data, dict):
            data = data.get("steps", [])
        return [str(s) for s in data]
    return [line for line in text.splitlines() if line.strip()]


async def run(cfg: Config, flow_path: str) -> RunReport:
    agent = MobileTestAgent(cfg)
    await agent.start()
    try:
        report = await agent.run_flow(load_flow(flow_path))
    finally:
        await agent.close()
    if cfg.report_file:
        Path(cfg.report_file).write_text(json.dumps(report.as_dict(), indent=2))
    return report
