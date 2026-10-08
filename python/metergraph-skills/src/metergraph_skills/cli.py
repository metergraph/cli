"""Command line entry point for metergraph-skills.

Results use the same JSON envelope and exit codes as "metergraph skill" in the
npm CLI, so scripts and agents can handle either one.
"""

import argparse
import json
import sys
from typing import List, Optional

from . import __version__
from .bundle import ASSET_DIR
from .installer import (
    HANDOFF_SKILL_CLIENTS,
    HANDOFF_SKILL_RUNTIMES,
    SKILL_CLIENTS,
    SKILL_RUNTIMES,
    run_skill,
)

SCHEMA_VERSION = 1
EXIT_CODES = {
    "ok": 0,
    "internal_error": 1,
    "invalid_input": 2,
    "unsupported": 6,
    "conflict": 8,
    "filesystem_error": 9,
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="metergraph-skills",
        description=(
            "Install or update the Metergraph agent skill in a project. "
            "This does not sign in, connect a workspace or configure MCP. "
            "For those, use the Metergraph CLI: npx metergraph-cli@next."
        ),
    )
    parser.add_argument("--version", action="version", version="metergraph-skills " + __version__)
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")
    commands.required = True
    for action in ("install", "update"):
        command = commands.add_parser(action, help="{} the skill for one client".format(action.capitalize()))
        command.add_argument(
            "--client", required=True, choices=list(SKILL_CLIENTS) + list(HANDOFF_SKILL_CLIENTS)
        )
        command.add_argument("--runtime", required=True, choices=SKILL_RUNTIMES + HANDOFF_SKILL_RUNTIMES)
        command.add_argument("--project", metavar="DIR", help="Project directory. Default: the current directory.")
        command.add_argument("--json", action="store_true", help="Print one JSON line on stdout.")
    commands.add_parser("path", help="Print the directory that holds the bundled skill files")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "path":
        print(ASSET_DIR)
        return 0

    result = run_skill(args.command, args.client, args.runtime, args.project)
    outcome = result["outcome"]
    ok = outcome == "ok"
    envelope = {
        "schema_version": SCHEMA_VERSION,
        "command": "skill " + args.command,
        "ok": ok,
        "outcome": outcome,
        "exit_code": EXIT_CODES[outcome],
        "data": result["data"],
        "error": None if ok else {"code": outcome, "reason": result["reason"], "message": result["message"]},
    }
    if args.json:
        sys.stdout.write(json.dumps(envelope, separators=(",", ":"), ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(_text(envelope, result["message"]))
    return envelope["exit_code"]


def _text(result, message: str) -> str:
    report = result["data"]
    label = SKILL_CLIENTS.get(report["client"], {}).get("label") or HANDOFF_SKILL_CLIENTS.get(report["client"])
    lines = ["Metergraph {}: {}, {} runtime".format(result["command"], label, report["runtime"])]
    if report["path"] is not None:
        lines.append("Path: " + report["path"])
    if result["ok"]:
        lines += [
            "Status: " + report["status"],
            "Source revision: {} (sha256 {})".format(report["source"]["revision"], report["source"]["sha256"]),
            "Discovery: pending until {} loads the skill".format(label),
            "Authenticated: no",
            "",
            message,
            "Next: " + report["next_action"]["message"],
        ]
    else:
        lines += ["", "Result: {} (exit {})".format(result["outcome"], result["exit_code"]), message]
        next_action = report["next_action"] or {}
        if next_action.get("kind") == "connection_guide":
            lines.append("Connection guide: " + next_action["url"])
    return "\n".join(lines) + "\n"
