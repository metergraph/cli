"""Project-scoped skill installer.

This is a port of src/skill.js in the npm CLI. Both write the same skill paths
and the same ownership receipt, so a skill installed by either one is
recognised, reused and updated by the other. Keep the two in step.

It writes exactly two things inside the project: the client's SKILL.md and a
secret-free ownership receipt. It never touches client settings, AGENTS.md,
CLAUDE.md or any other file, never follows a symbolic link below the resolved
project directory and makes no network request.
"""

import errno
import json
import os
import secrets
import signal
import stat
import threading
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from .bundle import load_bundled_skill, revision_for, sha256_hex

CONNECTION_GUIDE_URL = "https://www.metergraph.dev/docs/guides/agent-access/"

# Clients that load project skills from a native directory. Every client has
# its own directory, so installing for one never touches another's files.
SKILL_CLIENTS = {
    "codex": {"label": "Codex", "dir": ".agents"},
    "claude": {"label": "Claude Code", "dir": ".claude"},
    "cursor": {"label": "Cursor", "dir": ".cursor"},
}
SKILL_RUNTIMES = ["local", "cloud"]

# Recognised values that cannot load project skill files. They get a pointer
# to the connection guide instead of a usage error, and nothing is written.
HANDOFF_SKILL_CLIENTS = {"claude-desktop": "Claude Desktop", "chatgpt": "ChatGPT"}
HANDOFF_SKILL_RUNTIMES = ["cloud-no-shell"]

RECEIPT_DIR = ".metergraph"
RECEIPT_FILE = "skill-installations.json"
LOCK_FILE = "skill-installations.lock"
MAX_RECEIPT_BYTES = 64 * 1024
MAX_SKILL_BYTES = 1024 * 1024
ENTRY_KEYS = ["client", "path", "revision", "runtimes", "sha256", "skill"]
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
BINARY = getattr(os, "O_BINARY", 0)

MESSAGES = {
    "invalid_project": "--project must name an existing directory.",
    "client_not_supported": (
        "This client cannot load project skill files. Follow the connection guide instead. "
        "Nothing was written."
    ),
    "runtime_not_supported": (
        "This runtime has no shell or project checkout for skill files. Follow the connection "
        "guide instead. Nothing was written."
    ),
    "not_owned": (
        "A skill already exists at the target path and was not installed by Metergraph. "
        "Nothing was changed."
    ),
    "modified": (
        "The skill file was changed after Metergraph installed it. Nothing was changed. "
        "Restore or remove the file, then retry."
    ),
    "not_installed": (
        "Metergraph has not installed the skill for this client in this project. "
        'Run "metergraph-skills install" first.'
    ),
    "update_required": (
        "An older skill revision installed by Metergraph is present. "
        'Run "metergraph-skills update" to replace it.'
    ),
    "unsafe_path": (
        "A path used by the installer is a symbolic link or is not a regular file or directory. "
        "Nothing was changed."
    ),
    "receipt_invalid": "The receipt {}/{} is not valid. Nothing was changed.".format(RECEIPT_DIR, RECEIPT_FILE),
    "changed_during_install": "A file changed while the skill was being installed. Changes were rolled back.",
    "locked": "Another skill install may be running. If none is, delete {}/{} and retry.".format(
        RECEIPT_DIR, LOCK_FILE
    ),
    "read_failed": "The project files could not be read. Nothing was changed.",
    "write_failed": "The skill could not be written. Changes were rolled back.",
    "rollback_failed": (
        "The skill could not be written and the rollback did not finish. "
        "Check the skill path and {}/{}.".format(RECEIPT_DIR, RECEIPT_FILE)
    ),
    "bundled_skill_invalid": (
        "The skill bundled with metergraph-skills failed its integrity check. "
        "Reinstall metergraph-skills. Nothing was written."
    ),
}


class Stop(Exception):
    def __init__(self, outcome: str, reason: str) -> None:
        super().__init__(reason)
        self.outcome = outcome
        self.reason = reason


class Context:
    def __init__(self, action: str, client: str, runtime: str) -> None:
        self.action = action
        self.client = client
        self.runtime = runtime
        self.target: Optional[Dict[str, Any]] = None
        self.bundle = None


def run_skill(action: str, client: str, runtime: str, project: Optional[str] = None) -> Dict[str, Any]:
    """Returns {outcome, reason, message, data}. Every string comes from this
    package. Paths in data are relative to the project."""
    context = Context(action, client, runtime)
    if client not in SKILL_CLIENTS:
        return _handoff(context, "client_not_supported")
    if runtime not in SKILL_RUNTIMES:
        return _handoff(context, "runtime_not_supported")
    try:
        return _execute(context, project)
    except Stop as error:
        return _failure(context, error.outcome, error.reason)
    except Exception:
        return _failure(context, "filesystem_error", "write_failed")


def _execute(context: Context, project: Optional[str]) -> Dict[str, Any]:
    context.bundle = load_bundled_skill()
    if context.bundle is None:
        raise Stop("internal_error", "bundled_skill_invalid")
    context.target = _target_for(context.client, context.bundle.name)
    root = _resolve_project(project)

    # Decide from a read-only look first, so a matching rerun writes nothing.
    state = _inspect(root, context)
    plan = _decide(context.action, context.runtime, state, context.bundle)
    if plan["noop"]:
        return _success(context, plan["status"])

    with _deferred_signals():
        created_meta = _ensure_dirs(root, [RECEIPT_DIR])
        lock_path = os.path.join(root, RECEIPT_DIR, LOCK_FILE)
        done = False
        try:
            _acquire_lock(lock_path)
            try:
                # Look again under the lock in case another run changed anything.
                state = _inspect(root, context)
                plan = _decide(context.action, context.runtime, state, context.bundle)
                if not plan["noop"]:
                    _commit(root, context, state, plan)
                done = True
                return _success(context, plan["status"])
            finally:
                try:
                    os.unlink(lock_path)
                except OSError:
                    # A lock that cannot be removed is reported by the next run.
                    pass
        finally:
            if not done:
                _remove_dirs(created_meta)


def _target_for(client: str, name: str) -> Dict[str, Any]:
    dirs = [SKILL_CLIENTS[client]["dir"], "skills", name]
    return {"dirs": dirs, "relative": "/".join(dirs + ["SKILL.md"])}


def _resolve_project(project: Optional[str]) -> str:
    try:
        real = os.path.realpath(os.path.abspath(project if project is not None else os.getcwd()))
        if os.path.isdir(real):
            return real
    except (OSError, ValueError):
        pass
    raise Stop("invalid_input", "invalid_project")


def _inspect(root: str, context: Context) -> Dict[str, Any]:
    """Reads the receipt and the target without writing. Any symbolic link or
    non-regular entry on either path stops the run."""
    try:
        _check_dirs(root, [RECEIPT_DIR])
        receipt_file = _read_regular(os.path.join(root, RECEIPT_DIR, RECEIPT_FILE), MAX_RECEIPT_BYTES)
        receipt = None
        if receipt_file is not None:
            if receipt_file["content"] is not None:
                receipt = _parse_receipt(receipt_file["content"], context.bundle.name)
            if receipt is None:
                raise Stop("conflict", "receipt_invalid")
        skill_dir_exists = _check_dirs(root, context.target["dirs"])
        file = (
            _read_regular(os.path.join(root, *context.target["dirs"], "SKILL.md"), MAX_SKILL_BYTES)
            if skill_dir_exists
            else None
        )
        entry = None
        if receipt is not None:
            entry = next((item for item in receipt["installations"] if item["client"] == context.client), None)
        return {
            "receipt": receipt,
            "receipt_file": receipt_file,
            "entry": entry,
            "skill_dir_exists": skill_dir_exists,
            "file": file,
        }
    except Stop:
        raise
    except Exception:
        raise Stop("filesystem_error", "read_failed")


def _decide(action: str, runtime: str, state: Dict[str, Any], bundle) -> Dict[str, Any]:
    """Returns {status, noop, write_skill} or raises a conflict. There is no
    force option: an unowned or modified skill is never replaced."""
    entry, file = state["entry"], state["file"]
    if entry is None:
        if file is not None or state["skill_dir_exists"]:
            raise Stop("conflict", "not_owned")
        if action == "update":
            raise Stop("conflict", "not_installed")
        return {"status": "installed", "noop": False, "write_skill": True}
    if file is not None and (file["content"] is None or sha256_hex(file["content"]) != entry["sha256"]):
        raise Stop("conflict", "modified")
    current = entry["revision"] == bundle.revision
    if not current and action == "install":
        raise Stop("conflict", "update_required")
    if file is not None and current:
        return {"status": "reused", "noop": runtime in entry["runtimes"], "write_skill": False}
    return {"status": "installed" if current else "updated", "noop": False, "write_skill": True}


def _commit(root: str, context: Context, state: Dict[str, Any], plan: Dict[str, Any]) -> None:
    """Writes the skill, then the receipt. If the receipt cannot be written the
    skill is restored to its previous state, so ownership is never recorded
    for a skill that was not written."""
    bundle, target = context.bundle, context.target
    skill_path = os.path.join(root, *target["dirs"], "SKILL.md")
    receipt_path = os.path.join(root, RECEIPT_DIR, RECEIPT_FILE)
    receipt = _next_receipt(state["receipt"], context, target["relative"])
    created_dirs: List[str] = []
    skill_written = False
    try:
        if plan["write_skill"]:
            created_dirs = _ensure_dirs(root, target["dirs"])
            _replace_file(skill_path, bundle.content, state["file"])
            skill_written = True
        if state["receipt_file"] is None or state["receipt_file"]["content"] != receipt:
            _replace_file(receipt_path, receipt, state["receipt_file"])
    except BaseException:
        try:
            if skill_written:
                if state["file"] is None:
                    os.unlink(skill_path)
                else:
                    _replace_file(
                        skill_path,
                        state["file"]["content"],
                        {"content": bundle.content, "mode": state["file"]["mode"]},
                    )
        except Exception:
            raise Stop("filesystem_error", "rollback_failed")
        _remove_dirs(created_dirs)
        raise


def _next_receipt(receipt: Optional[Dict[str, Any]], context: Context, relative: str) -> bytes:
    bundle, client, runtime = context.bundle, context.client, context.runtime
    installations = list(receipt["installations"]) if receipt is not None else []
    previous = next((item for item in installations if item["client"] == client), None)
    runtimes = sorted(set((previous["runtimes"] if previous else []) + [runtime]))
    installations = [item for item in installations if item["client"] != client]
    # Key order matches the npm CLI, so both write byte-identical receipts.
    installations.append(
        {
            "client": client,
            "path": relative,
            "skill": bundle.name,
            "revision": bundle.revision,
            "sha256": bundle.sha256,
            "runtimes": runtimes,
        }
    )
    installations.sort(key=lambda item: item["client"])
    text = json.dumps({"schema_version": 1, "installations": installations}, indent=2, ensure_ascii=False)
    return (text + "\n").encode("utf-8")


def _parse_receipt(content: bytes, name: str) -> Optional[Dict[str, Any]]:
    """Accepts only the exact shape the installers write. Each entry is bound
    to one client and that client's fixed path, and its revision must match
    its hash."""
    try:
        value = json.loads(content.decode("utf-8"))
    except ValueError:
        return None
    if not _is_record(value, ["installations", "schema_version"]):
        return None
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        return None
    if not isinstance(value["installations"], list):
        return None
    seen = set()
    for entry in value["installations"]:
        if not _is_record(entry, ENTRY_KEYS):
            return None
        client = entry["client"]
        if not isinstance(client, str) or client not in SKILL_CLIENTS or client in seen:
            return None
        seen.add(client)
        if entry["skill"] != name or entry["path"] != _target_for(client, name)["relative"]:
            return None
        sha256 = entry["sha256"]
        if not isinstance(sha256, str) or len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256):
            return None
        if entry["revision"] != revision_for(sha256):
            return None
        runtimes = entry["runtimes"]
        if not isinstance(runtimes, list) or not runtimes:
            return None
        if not all(isinstance(item, str) and item in SKILL_RUNTIMES for item in runtimes):
            return None
        if len(set(runtimes)) != len(runtimes):
            return None
    return value


def _is_record(value: Any, keys: List[str]) -> bool:
    return isinstance(value, dict) and sorted(value) == keys


def _lstat_or_none(file: str):
    try:
        return os.lstat(file)
    except FileNotFoundError:
        return None


def _check_dirs(root: str, dirs: List[str]) -> bool:
    """Returns True when every directory exists, False at the first missing
    one. Anything else, including a symbolic link to a directory, is unsafe."""
    current = root
    for name in dirs:
        current = os.path.join(current, name)
        info = _lstat_or_none(current)
        if info is None:
            return False
        if not stat.S_ISDIR(info.st_mode):
            raise Stop("conflict", "unsafe_path")
    return True


def _ensure_dirs(root: str, dirs: List[str]) -> List[str]:
    """Creates missing directories one level at a time and returns the ones it
    created, deepest last, so a rollback can remove exactly those."""
    created: List[str] = []
    current = root
    try:
        for name in dirs:
            current = os.path.join(current, name)
            try:
                os.mkdir(current)
                created.append(current)
            except FileExistsError:
                if not stat.S_ISDIR(os.lstat(current).st_mode):
                    raise Stop("conflict", "unsafe_path")
    except BaseException:
        _remove_dirs(created)
        raise
    return created


def _remove_dirs(created: List[str]) -> None:
    for path in reversed(created):
        try:
            os.rmdir(path)
        except OSError:
            # Not empty or not removable. An empty directory is harmless.
            pass


def _read_regular(file: str, max_bytes: int) -> Optional[Dict[str, Any]]:
    """Returns {content, mode} for a regular file, {content: None, mode} when
    it is larger than max_bytes, or None when it does not exist."""
    info = _lstat_or_none(file)
    if info is None:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise Stop("conflict", "unsafe_path")
    try:
        fd = os.open(file, os.O_RDONLY | NOFOLLOW | BINARY)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise Stop("conflict", "unsafe_path")
        raise
    with os.fdopen(fd, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if not stat.S_ISREG(opened.st_mode):
            raise Stop("conflict", "unsafe_path")
        mode = stat.S_IMODE(opened.st_mode) & 0o777
        if opened.st_size > max_bytes:
            return {"content": None, "mode": mode}
        return {"content": handle.read(), "mode": mode}


def _replace_file(dest: str, content: bytes, previous: Optional[Dict[str, Any]]) -> None:
    """Writes content to an exclusive temporary file next to dest, then renames
    it into place. Right before the rename, dest must still be exactly what
    inspect saw, so a file created or edited by someone else in the meantime
    is never replaced. An existing file keeps its permission bits."""
    temp = os.path.join(
        os.path.dirname(dest), ".{}.{}.tmp".format(os.path.basename(dest), secrets.token_hex(6))
    )
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | BINARY, 0o666 if previous is None else 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if previous is not None:
            os.chmod(temp, previous["mode"])
        now = _read_regular(dest, MAX_SKILL_BYTES)
        if previous is None:
            unchanged = now is None
        else:
            unchanged = now is not None and now["content"] is not None and now["content"] == previous["content"]
        if not unchanged:
            raise Stop("conflict", "changed_during_install")
        os.replace(temp, dest)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            # Already renamed or never created.
            pass
        raise


def _acquire_lock(lock_path: str) -> None:
    try:
        os.close(os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | BINARY, 0o666))
    except FileExistsError:
        raise Stop("conflict", "locked")


@contextmanager
def _deferred_signals():
    """Ignores SIGINT, SIGTERM and SIGHUP while files are being replaced, so
    the work always finishes or rolls back. Signal handlers can only be
    changed from the main thread; elsewhere this does nothing."""
    saved = []
    if threading.current_thread() is threading.main_thread():
        for name in ("SIGINT", "SIGTERM", "SIGHUP"):
            number = getattr(signal, name, None)
            if number is None:
                continue
            try:
                saved.append((number, signal.signal(number, signal.SIG_IGN)))
            except (OSError, ValueError):
                pass
    try:
        yield
    finally:
        for number, handler in reversed(saved):
            signal.signal(number, handler)


def _next_action(context: Context) -> Dict[str, Any]:
    label = SKILL_CLIENTS[context.client]["label"]
    if context.runtime == "local":
        message = "Start or restart {} in this project, then confirm that it lists the metergraph skill.".format(
            label
        )
    else:
        message = (
            "Make sure the cloud checkout includes {} (commit it if you installed it elsewhere), "
            "then start a new {} cloud session and confirm that it lists the metergraph skill.".format(
                context.target["relative"], label
            )
        )
    return {"kind": "reload_client", "message": message}


def _data(context: Context, status: Optional[str] = None, next_action=None) -> Dict[str, Any]:
    bundle = context.bundle
    return {
        "client": context.client,
        "runtime": context.runtime,
        "path": context.target["relative"] if context.target else None,
        "status": status,
        "source": (
            {"name": bundle.name, "revision": bundle.revision, "sha256": bundle.sha256} if bundle else None
        ),
        "discovery": None if status is None else "pending",
        "authenticated": False,
        "next_action": next_action,
    }


def _success(context: Context, status: str) -> Dict[str, Any]:
    label = SKILL_CLIENTS[context.client]["label"]
    verb = {"installed": "installed", "updated": "updated", "reused": "already installed"}[status]
    return {
        "outcome": "ok",
        "reason": None,
        "message": (
            "Skill {}. Discovery is pending until {} loads it. "
            "This does not sign in, connect a workspace or configure MCP.".format(verb, label)
        ),
        "data": _data(context, status, _next_action(context)),
    }


def _handoff(context: Context, reason: str) -> Dict[str, Any]:
    return {
        "outcome": "unsupported",
        "reason": reason,
        "message": MESSAGES[reason],
        "data": _data(context, next_action={"kind": "connection_guide", "url": CONNECTION_GUIDE_URL}),
    }


def _failure(context: Context, outcome: str, reason: str) -> Dict[str, Any]:
    return {"outcome": outcome, "reason": reason, "message": MESSAGES[reason], "data": _data(context)}
