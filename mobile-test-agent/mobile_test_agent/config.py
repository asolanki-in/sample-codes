"""Central configuration for the mobile test agent.

Everything is overridable via environment variables or CLI flags so the
agent can run unchanged against local Ollama, Ollama Cloud, different
appium-mcp versions, Android or iOS.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


@dataclass
class Config:
    # --- LLM (Ollama Cloud) ---
    ollama_host: str = os.environ.get("OLLAMA_HOST", "https://ollama.com")
    ollama_api_key: str = os.environ.get("OLLAMA_API_KEY", "")
    model: str = os.environ.get("AGENT_MODEL", "gpt-oss:120b")
    llm_timeout_s: float = float(os.environ.get("AGENT_LLM_TIMEOUT", "120"))

    # --- appium-mcp server launch ---
    mcp_command: str = os.environ.get("APPIUM_MCP_COMMAND", "npx")
    mcp_args: List[str] = field(
        default_factory=lambda: os.environ.get(
            "APPIUM_MCP_ARGS", "-y appium-mcp@latest"
        ).split()
    )
    # Extra env for the server process (ANDROID_HOME etc. are inherited).
    mcp_env: Dict[str, str] = field(default_factory=dict)

    # --- device / session ---
    platform: str = os.environ.get("AGENT_PLATFORM", "android")  # android | ios
    capabilities_file: Optional[str] = os.environ.get("AGENT_CAPS_FILE")
    create_session: bool = True

    # --- reliability tuning (Maestro-style) ---
    step_timeout_s: float = 30.0        # max wall time per step incl. retries
    max_attempts: int = 3               # find→act→verify attempts per step
    stable_poll_interval_s: float = 0.4  # UI-idle polling cadence
    stable_timeout_s: float = 10.0       # max wait for UI to settle
    wait_for_element_timeout_s: float = 12.0
    scroll_max_swipes: int = 8          # scroll-to-find budget per direction

    # --- matching thresholds ---
    match_accept_score: float = 0.72    # deterministic accept threshold
    match_accept_margin: float = 0.08   # required gap over the runner-up
    match_strong_score: float = 0.90    # accept regardless of margin

    # --- token frugality ---
    snapshot_max_chars: int = 6000      # cap on UI listing sent to the LLM
    enable_llm: bool = True             # False => fully deterministic mode
    enable_vision_fallback: bool = False  # appium_ai (needs vision creds)

    # --- misc ---
    day_first_dates: bool = True        # "01 02 1990" => 1 Feb 1990
    continue_on_failure: bool = False
    report_file: Optional[str] = None
    toolmap_file: Optional[str] = os.environ.get("AGENT_TOOLMAP")

    def load_capabilities(self) -> Dict[str, Any]:
        if self.capabilities_file:
            return json.loads(Path(self.capabilities_file).read_text())
        if self.platform.lower() == "ios":
            return {
                "platformName": "iOS",
                "appium:automationName": "XCUITest",
            }
        return {
            "platformName": "Android",
            "appium:automationName": "UiAutomator2",
        }

    def load_toolmap(self) -> Dict[str, List[str]]:
        """Optional logical-name -> [candidate tool names] overrides.

        appium-mcp tool names can drift between versions; this lets users
        re-map without touching code.  See toolmap.example.yaml.
        """
        if not self.toolmap_file:
            return {}
        path = Path(self.toolmap_file)
        if not path.exists():
            raise FileNotFoundError(f"toolmap file not found: {path}")
        if yaml is None:
            raise RuntimeError("pyyaml is required to read a toolmap file")
        data = yaml.safe_load(path.read_text()) or {}
        return {k: (v if isinstance(v, list) else [v]) for k, v in data.items()}
