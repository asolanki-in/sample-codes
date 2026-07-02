"""Thin async client around the official `appium-mcp` server (stdio).

We do NOT write a custom MCP server — this is an MCP *client* that
launches `npx appium-mcp@latest` and calls its tools.  Tool names are
resolved through a logical-name registry (with candidate aliases and an
optional user toolmap), because appium-mcp tool names can drift between
releases; run `--list-tools` to see what your server exposes.
"""
from __future__ import annotations

import json
import logging
import os
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from .config import Config

log = logging.getLogger(__name__)

# logical name -> candidate tool names on the server (first hit wins)
DEFAULT_TOOLMAP: Dict[str, List[str]] = {
    "select_device": ["select_device", "appium_select_device"],
    "session": ["appium_session_management", "create_session", "appium_create_session"],
    "page_source": ["appium_get_page_source", "get_page_source", "appium_page_source"],
    "screenshot": ["appium_screenshot", "take_screenshot"],
    "find": ["appium_find_element", "find_element"],
    "set_value": ["appium_set_value", "set_value", "appium_send_keys", "send_keys"],
    "get_text": ["appium_get_text", "get_text"],
    "gesture": ["appium_gesture", "gesture"],
    "perform_actions": ["appium_perform_actions", "perform_actions"],
    "keyboard": ["appium_mobile_keyboard", "appium_hide_keyboard", "hide_keyboard"],
    "device": ["appium_mobile_device_control", "appium_device_control"],
    "app_lifecycle": ["appium_app_lifecycle", "app_lifecycle", "appium_activate_app"],
    "alert": ["appium_alert", "alert"],
    "ai": ["appium_ai"],
    "window_size": ["appium_get_window_size", "get_window_size"],
    "orientation": ["appium_orientation"],
}


class ToolCallError(RuntimeError):
    pass


class AppiumMCP:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._stack: Optional[AsyncExitStack] = None
        self.session: Optional[ClientSession] = None
        self.tool_names: List[str] = []
        self.tool_schemas: Dict[str, Any] = {}
        self._toolmap = dict(DEFAULT_TOOLMAP)
        for logical, cands in cfg.load_toolmap().items():
            self._toolmap[logical] = cands + self._toolmap.get(logical, [])

    # ---- lifecycle -----------------------------------------------------
    async def start(self) -> None:
        env = {**os.environ, **self.cfg.mcp_env}
        # NO_UI trims 500-5000+ tokens of HTML from every appium-mcp response
        env.setdefault("NO_UI", "true")
        params = StdioServerParameters(
            command=self.cfg.mcp_command, args=self.cfg.mcp_args, env=env,
        )
        self._stack = AsyncExitStack()
        read, write = await self._stack.enter_async_context(stdio_client(params))
        self.session = await self._stack.enter_async_context(
            ClientSession(read, write)
        )
        await self.session.initialize()
        tools = await self.session.list_tools()
        self.tool_names = [t.name for t in tools.tools]
        self.tool_schemas = {t.name: t.inputSchema for t in tools.tools}
        log.info("appium-mcp exposes %d tools", len(self.tool_names))

    async def close(self) -> None:
        if self._stack:
            await self._stack.aclose()
            self._stack = None

    # ---- generic calls ---------------------------------------------------
    def tool_for(self, logical: str) -> str:
        for cand in self._toolmap.get(logical, [logical]):
            if cand in self.tool_names:
                return cand
        raise ToolCallError(
            f"No server tool found for '{logical}'. Server exposes: "
            f"{', '.join(self.tool_names)}. Add a mapping in your toolmap "
            f"file (AGENT_TOOLMAP) to fix this."
        )

    async def call(self, logical: str, args: Optional[Dict[str, Any]] = None) -> Any:
        return await self.raw_call(self.tool_for(logical), args or {})

    async def raw_call(self, tool_name: str, args: Dict[str, Any]) -> Any:
        assert self.session is not None, "call start() first"
        result = await self.session.call_tool(tool_name, args)
        texts = []
        for item in result.content or []:
            if getattr(item, "type", "") == "text":
                texts.append(item.text)
        payload = "\n".join(texts)
        if getattr(result, "isError", False):
            raise ToolCallError(f"{tool_name} failed: {payload[:800]}")
        try:
            return json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return payload

    async def try_call(
        self, logical: str, variants: List[Dict[str, Any]]
    ) -> Any:
        """Try several argument shapes until one succeeds (schema drift guard)."""
        last: Optional[Exception] = None
        for args in variants:
            try:
                return await self.call(logical, args)
            except ToolCallError as exc:
                last = exc
        raise ToolCallError(f"all argument variants failed for {logical}: {last}")

    # ---- convenience wrappers ---------------------------------------------
    async def page_source(self) -> str:
        out = await self.try_call("page_source", [{}, {"format": "xml"}])
        if isinstance(out, dict):
            for key in ("source", "pageSource", "page_source", "xml", "result"):
                if key in out and isinstance(out[key], str):
                    return out[key]
            return json.dumps(out)
        return str(out)

    async def w3c_tap(self, x: int, y: int, hold_ms: int = 80) -> None:
        await self.call("perform_actions", {"actions": _pointer_seq([
            {"type": "pointerMove", "duration": 0, "x": x, "y": y},
            {"type": "pointerDown", "button": 0},
            {"type": "pause", "duration": hold_ms},
            {"type": "pointerUp", "button": 0},
        ])})

    async def w3c_swipe(
        self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 500
    ) -> None:
        await self.call("perform_actions", {"actions": _pointer_seq([
            {"type": "pointerMove", "duration": 0, "x": x1, "y": y1},
            {"type": "pointerDown", "button": 0},
            {"type": "pause", "duration": 100},
            {"type": "pointerMove", "duration": duration_ms, "x": x2, "y": y2},
            {"type": "pointerUp", "button": 0},
        ])})


def _pointer_seq(actions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{
        "type": "pointer",
        "id": "finger1",
        "parameters": {"pointerType": "touch"},
        "actions": actions,
    }]
