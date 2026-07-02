"""CLI entrypoint.

    python -m mobile_test_agent run flows/login.yaml --platform android
    python -m mobile_test_agent list-tools
    python -m mobile_test_agent dry-run flows/login.yaml
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from .agent import MobileTestAgent, load_flow, run
from .config import Config
from .parser import parse_step


def _build_config(args: argparse.Namespace) -> Config:
    cfg = Config()
    if args.platform:
        cfg.platform = args.platform
    if getattr(args, "caps", None):
        cfg.capabilities_file = args.caps
    if getattr(args, "model", None):
        cfg.model = args.model
    if getattr(args, "report", None):
        cfg.report_file = args.report
    if getattr(args, "no_llm", False):
        cfg.enable_llm = False
    if getattr(args, "vision", False):
        cfg.enable_vision_fallback = True
    if getattr(args, "continue_on_failure", False):
        cfg.continue_on_failure = True
    if getattr(args, "toolmap", None):
        cfg.toolmap_file = args.toolmap
    return cfg


async def _list_tools(cfg: Config) -> None:
    agent = MobileTestAgent(cfg)
    cfg.create_session = False
    await agent.start()
    try:
        for name in agent.mcp.tool_names:
            print(name)
    finally:
        await agent.close()


def _dry_run(flow: str, cfg: Config) -> int:
    ok = True
    for step in load_flow(flow):
        if step.strip().startswith("#") or not step.strip():
            continue
        cmd = parse_step(step, cfg.day_first_dates)
        if cmd is None:
            print(f"  LLM-needed   {step}")
        else:
            desc = f"{cmd.kind}"
            if cmd.target:
                desc += f" target={cmd.target!r}"
            if cmd.value:
                desc += f" value={cmd.value!r}"
            if cmd.toggle_state:
                desc += f" state={cmd.toggle_state}"
            print(f"  deterministic {step!r} -> {desc}")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser(prog="mobile-test-agent")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="execute a flow on a device")
    p_run.add_argument("flow")
    p_run.add_argument("--platform", choices=["android", "ios"])
    p_run.add_argument("--caps", help="Appium capabilities JSON file")
    p_run.add_argument("--model", help="Ollama model (default gpt-oss:120b)")
    p_run.add_argument("--report", help="write JSON report to this path")
    p_run.add_argument("--no-llm", action="store_true",
                       help="fully deterministic mode (0 tokens)")
    p_run.add_argument("--vision", action="store_true",
                       help="enable appium_ai vision fallback")
    p_run.add_argument("--continue-on-failure", action="store_true")
    p_run.add_argument("--toolmap", help="YAML tool-name override file")

    p_dry = sub.add_parser("dry-run", help="parse a flow without a device")
    p_dry.add_argument("flow")
    p_dry.add_argument("--platform", choices=["android", "ios"])

    p_lt = sub.add_parser("list-tools", help="list tools your appium-mcp exposes")
    p_lt.add_argument("--platform", choices=["android", "ios"])
    p_lt.add_argument("--toolmap")

    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s")
    cfg = _build_config(args)

    if args.cmd == "dry-run":
        sys.exit(_dry_run(args.flow, cfg))
    if args.cmd == "list-tools":
        asyncio.run(_list_tools(cfg))
        return

    report = asyncio.run(run(cfg, args.flow))
    print(json.dumps(report.as_dict(), indent=2))
    sys.exit(0 if report.passed else 1)


if __name__ == "__main__":
    main()
