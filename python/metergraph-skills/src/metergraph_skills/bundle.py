"""The skill bundled in this package and its integrity check.

The skill file in skill/ is a byte-for-byte copy of the public skill at the
manifest's source_url, and of assets/skill/SKILL.md in the npm CLI. The source
has no version of its own, so the revision is derived from the content hash.
The hash is pinned here as well as in the manifest, so editing either file
alone is detected. Keep PINNED_SHA256 equal to the one in src/skill-bundle.js.
"""

import hashlib
import json
import re
from pathlib import Path
from typing import NamedTuple, Optional

PINNED_SHA256 = "8b81eb27b6159c4447a5c300409c4c64917238b7797f5ee37a35248cba50fcae"
SOURCE_URL = "https://www.metergraph.dev/SKILL.md"

ASSET_DIR = Path(__file__).resolve().parent / "skill"
MANIFEST_KEYS = ["file", "manifest_version", "name", "revision", "sha256", "size", "source_url"]


class Bundle(NamedTuple):
    name: str
    revision: str
    sha256: str
    content: bytes


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def revision_for(sha256: str) -> str:
    return "sha256-" + sha256[:12]


def load_bundled_skill() -> Optional[Bundle]:
    """Returns the bundled skill, or None when the manifest or the skill file
    is missing, malformed or does not match the pinned hash. Never downloads
    anything."""
    try:
        manifest = json.loads((ASSET_DIR / "manifest.json").read_text(encoding="utf-8"))
        content = (ASSET_DIR / "SKILL.md").read_bytes()
    except (OSError, ValueError):
        return None
    if (
        not isinstance(manifest, dict)
        or sorted(manifest) != MANIFEST_KEYS
        or manifest["manifest_version"] != 1
        or manifest["file"] != "SKILL.md"
        or manifest["source_url"] != SOURCE_URL
        or not isinstance(manifest["name"], str)
        or not re.fullmatch(r"[a-z0-9-]{1,64}", manifest["name"])
        or manifest["sha256"] != PINNED_SHA256
        or manifest["revision"] != revision_for(PINNED_SHA256)
        or type(manifest["size"]) is not int
        or manifest["size"] != len(content)
    ):
        return None
    sha256 = sha256_hex(content)
    if sha256 != PINNED_SHA256:
        return None
    prefix = "---\nname: {}\ndescription: ".format(manifest["name"]).encode("utf-8")
    if not content.startswith(prefix):
        return None
    return Bundle(manifest["name"], manifest["revision"], sha256, content)
