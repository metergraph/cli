"""Command line entry point for metergraph-skills.

Results use the same JSON envelope and exit codes as "metergraph skill" in the
npm CLI, so scripts and agents can handle either one.
"""

import json
import sys
from typing import Any, Dict, List, Optional

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


USAGE = """Usage:
  metergraph-skills install --client CLIENT --runtime RUNTIME [--project DIR] [--json]
  metergraph-skills update  --client CLIENT --runtime RUNTIME [--project DIR] [--json]
  metergraph-skills path
  metergraph-skills --version

Install or update the Metergraph agent skill in a project.
  --client   codex, claude or cursor
  --runtime  local or cloud
  --project  Project directory. Default: the current directory.
  --json     Print one JSON line on stdout.

This does not sign in, connect a workspace or configure MCP. For those, use
the Metergraph CLI: npx metergraph-cli@next
"""

ACTIONS = ("install", "update")
OPTIONS = ("--client", "--runtime", "--project")


class UsageError(Exception):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message


def parse_args(argv: List[str]) -> Dict[str, Any]:
    """Mirrors the npm CLI's "skill" parser: the same reasons and messages.
    Messages are fixed strings and never contain an argument value, because
    a mistyped argument can be a credential."""
    if "--help" in argv or "-h" in argv:
        return {"command": "help"}
    command = None
    values: Dict[str, str] = {}
    index = 0
    while index < len(argv):
        arg = argv[index]
        position = index + 1
        index += 1
        if arg == "--json":
            continue
        if command is None and arg in ACTIONS + ("path", "--version"):
            command = arg
            continue
        name, equals, inline = arg.partition("=")
        if command in ACTIONS and name in OPTIONS:
            if equals:
                value = inline
            elif index < len(argv):
                value = argv[index]
                index += 1
            else:
                raise UsageError("missing_value", "{} requires a value.".format(name))
            if name in values:
                raise UsageError("duplicate_option", "{} may be given only once.".format(name))
            values[name] = value
            continue
        if command is None and not arg.startswith("-"):
            raise UsageError(
                "unknown_command",
                'Unknown command at argument {}. Run "metergraph-skills --help" for usage.'.format(position),
            )
        raise UsageError(
            "unknown_argument",
            'Unrecognized argument at position {}. Run "metergraph-skills --help" for usage.'.format(position),
        )
    if command is None:
        return {"command": "help"}
    if command not in ACTIONS:
        return {"command": command}
    client = values.get("--client")
    if client is None:
        raise UsageError("missing_client", "--client is required. Use codex, claude or cursor.")
    if client not in SKILL_CLIENTS and client not in HANDOFF_SKILL_CLIENTS:
        raise UsageError("invalid_client", "--client must be codex, claude or cursor.")
    runtime = values.get("--runtime")
    if runtime is None:
        raise UsageError("missing_runtime", "--runtime is required. Use local or cloud.")
    if runtime not in SKILL_RUNTIMES and runtime not in HANDOFF_SKILL_RUNTIMES:
        raise UsageError("invalid_runtime", "--runtime must be local or cloud.")
    project = values.get("--project")
    if project is not None and (project == "" or "\0" in project):
        raise UsageError("invalid_project", "--project must name an existing directory.")
    return {"command": command, "client": client, "runtime": runtime, "project": project}


def _envelope(command: Optional[str], outcome: str, data, reason=None, message=None) -> Dict[str, Any]:
    ok = outcome == "ok"
    return {
        "schema_version": SCHEMA_VERSION,
        "command": command,
        "ok": ok,
        "outcome": outcome,
        "exit_code": EXIT_CODES[outcome],
        "data": data,
        "error": None if ok else {"code": outcome, "reason": reason, "message": message},
    }


def _write_json(envelope: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(envelope, separators=(",", ":"), ensure_ascii=False) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    as_json = "--json" in argv
    try:
        args = parse_args(argv)
    except UsageError as error:
        action = next((arg for arg in argv if arg in ACTIONS), None)
        envelope = _envelope("skill " + action if action else None, "invalid_input", None, error.reason, error.message)
        if as_json:
            _write_json(envelope)
        else:
            sys.stderr.write(error.message + "\n")
        return envelope["exit_code"]

    if args["command"] == "help":
        sys.stdout.write(USAGE)
        return 0
    if args["command"] == "--version":
        print("metergraph-skills " + __version__)
        return 0
    if args["command"] == "path":
        print(ASSET_DIR)
        return 0

    result = run_skill(args["command"], args["client"], args["runtime"], args["project"])
    envelope = _envelope(
        "skill " + args["command"],
        result["outcome"],
        result["data"],
        result["reason"],
        None if result["outcome"] == "ok" else result["message"],
    )
    if as_json:
        _write_json(envelope)
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
