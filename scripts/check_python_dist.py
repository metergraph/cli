"""Check a built Python package before it is released to PyPI.

Usage: python3 scripts/check_python_dist.py PACKAGE_DIR DIST_DIR

DIST_DIR must hold exactly one wheel and one sdist for the name and version in
PACKAGE_DIR/pyproject.toml. Every file in the wheel must be on the allowlist
below. For metergraph-skills, the wheel's SKILL.md and manifest.json must be
byte-identical to the npm CLI's assets/skill/ copies.
"""

import re
import sys
import tarfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def fail(message: str) -> int:
    print("::error::" + message)
    return 1


def project_metadata(package_dir: Path):
    text = (package_dir / "pyproject.toml").read_text(encoding="utf-8")
    name = re.search(r'^name = "([a-z0-9-]+)"$', text, re.M)
    version = re.search(r'^version = "([0-9A-Za-z.+-]+)"$', text, re.M)
    module = re.search(r'^\[tool\.flit\.module\]\nname = "([a-z0-9_]+)"$', text, re.M)
    if not (name and version and module):
        raise ValueError("pyproject.toml is missing name, version or module")
    return name.group(1), version.group(1), module.group(1)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    package_dir, dist_dir = Path(sys.argv[1]), Path(sys.argv[2])
    name, version, module = project_metadata(package_dir)
    stem = name.replace("-", "_") + "-" + version

    files = sorted(path.name for path in dist_dir.iterdir())
    expected = sorted([stem + "-py3-none-any.whl", stem + ".tar.gz"])
    if files != expected:
        return fail("Expected exactly {}, found {}.".format(expected, files))

    dist_info = stem + ".dist-info/"
    allowed = {dist_info + item for item in ("METADATA", "WHEEL", "RECORD", "LICENSE")}
    if name == "metergraph-skills":
        allowed.add(dist_info + "entry_points.txt")
        allowed |= {
            module + "/" + item
            for item in ("__init__.py", "__main__.py", "bundle.py", "cli.py", "installer.py",
                         "skill/SKILL.md", "skill/manifest.json")
        }
    else:
        allowed |= {module + "/__init__.py", module + "/__main__.py"}

    with zipfile.ZipFile(dist_dir / (stem + "-py3-none-any.whl")) as wheel:
        members = set(wheel.namelist())
        if members != allowed:
            return fail(
                "Wheel contents differ from the allowlist. Unexpected: {}. Missing: {}.".format(
                    sorted(members - allowed), sorted(allowed - members)
                )
            )
        if name == "metergraph-skills":
            for item in ("SKILL.md", "manifest.json"):
                bundled = wheel.read(module + "/skill/" + item)
                if bundled != (REPO_ROOT / "assets" / "skill" / item).read_bytes():
                    return fail("The wheel's {} differs from assets/skill/{}.".format(item, item))

    with tarfile.open(dist_dir / (stem + ".tar.gz")) as sdist:
        for member in sdist.getmembers():
            if not member.name.startswith(stem + "/") or ".." in member.name.split("/"):
                return fail("Unexpected sdist path: " + member.name)
            if not (member.isfile() or member.isdir()):
                return fail("Sdist entry is not a regular file or directory: " + member.name)

    print("{} {}: wheel and sdist contents checked.".format(name, version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
