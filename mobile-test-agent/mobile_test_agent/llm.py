"""Ollama Cloud client.

The agent is deterministic-first: the LLM is consulted only when the
grammar parser or the element matcher cannot resolve a step on their own.
Every call uses structured outputs (`format` = JSON schema) at
temperature 0 so responses are small, cheap and machine-checkable.

API: POST {OLLAMA_HOST}/api/chat with `Authorization: Bearer $OLLAMA_API_KEY`.
Works identically against a local Ollama (no key needed).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

import requests

from .config import Config

log = logging.getLogger(__name__)


class LLMUnavailable(RuntimeError):
    pass


class TokenUsage:
    def __init__(self) -> None:
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.calls = 0

    def add(self, data: Dict[str, Any]) -> None:
        self.calls += 1
        self.prompt_tokens += int(data.get("prompt_eval_count") or 0)
        self.completion_tokens += int(data.get("eval_count") or 0)

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def as_dict(self) -> Dict[str, int]:
        return {
            "llm_calls": self.calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total,
        }


class OllamaLLM:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.usage = TokenUsage()
        self._session = requests.Session()
        if cfg.ollama_api_key:
            self._session.headers["Authorization"] = f"Bearer {cfg.ollama_api_key}"

    @property
    def available(self) -> bool:
        if not self.cfg.enable_llm:
            return False
        # Local hosts don't need a key; ollama.com does.
        if "ollama.com" in self.cfg.ollama_host and not self.cfg.ollama_api_key:
            return False
        return True

    def chat_json(
        self,
        system: str,
        user: str,
        schema: Dict[str, Any],
        retries: int = 2,
    ) -> Dict[str, Any]:
        """One structured-output round trip. Raises LLMUnavailable when the
        LLM is disabled/unreachable so callers can fall back gracefully."""
        if not self.available:
            raise LLMUnavailable(
                "LLM disabled or OLLAMA_API_KEY not set "
                "(create one at https://ollama.com/settings/keys)"
            )
        body = {
            "model": self.cfg.model,
            "stream": False,
            "format": schema,
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        last_err: Optional[Exception] = None
        for attempt in range(retries + 1):
            try:
                resp = self._session.post(
                    f"{self.cfg.ollama_host.rstrip('/')}/api/chat",
                    json=body,
                    timeout=self.cfg.llm_timeout_s,
                )
                resp.raise_for_status()
                data = resp.json()
                self.usage.add(data)
                content = (data.get("message") or {}).get("content", "")
                return json.loads(content)
            except (requests.RequestException, json.JSONDecodeError, KeyError) as exc:
                last_err = exc
                log.warning("LLM call failed (attempt %d): %s", attempt + 1, exc)
        raise LLMUnavailable(f"Ollama call failed after retries: {last_err}")


# ---- JSON schemas for structured outputs (kept tiny on purpose) ----

COMMAND_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {
            "type": "string",
            "enum": [
                "tap", "long_press", "input", "set_date", "select", "toggle",
                "scroll", "assert_visible", "assert_not_visible", "wait",
                "back", "home", "hide_keyboard", "launch", "press_key",
            ],
        },
        "target": {"type": ["string", "null"]},
        "value": {"type": ["string", "null"]},
        "direction": {
            "type": ["string", "null"],
            "enum": ["up", "down", "left", "right", None],
        },
        "toggle_state": {"type": ["string", "null"], "enum": ["on", "off", None]},
    },
    "required": ["kind"],
}

DISAMBIG_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "element_index": {"type": ["integer", "null"]},
    },
    "required": ["element_index"],
}

RECOVERY_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["retry", "scroll_down", "scroll_up", "dismiss", "give_up"],
        },
        "dismiss_target": {"type": ["string", "null"]},
    },
    "required": ["action"],
}
