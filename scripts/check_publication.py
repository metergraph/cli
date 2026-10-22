"""Check common internal references before a public push or PR.

Usage: python3 scripts/check_publication.py origin/main
This cannot detect all private data. Review the full diff and metadata yourself.
"""

import json
import os
import re
import subprocess
import sys


PATTERNS = {
    "internal issue ID": re.compile(r"\b" + "MET" + r"-[0-9]+\b", re.I),
    "internal tracker URL": re.compile("linear.app/" + "metergraph", re.I),
    "private repository reference": re.compile("PioneerSquareLabs/" + "metergraph-internal", re.I),
}

# Exact strings exempt from PATTERNS. The customer-local release is signed by a
# workflow in the private repository, so verifying it needs that repository's
# name in the anchored cosign certificate identity, which every public release
# page also publishes. Only this whole identity is exempt; any other mention of
# the repository is still reported. Built from parts, like PATTERNS.
ALLOWED = (
    r"^https://github\.com/PioneerSquareLabs/" + "metergraph-internal"
    + r"/\.github/workflows/byoc-release\.yml@refs/(heads/main|tags/v.+)$",
)


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True)


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    try:
        metadata = [
            ("new commits", git("log", "--format=%B", f"{base}..HEAD")),
        ]
        commits = git("rev-list", "--reverse", f"{base}..HEAD").splitlines()
        diffs = [git("diff", "--no-ext-diff", "--no-textconv", "--unified=0", f"{base}...HEAD", "--")]
        for commit in commits:
            diffs.append(git("diff-tree", "--root", "-m", "-p", "--no-ext-diff", "--no-textconv", "--unified=0", commit, "--"))
            metadata.append(("published paths", git("diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z", commit, "--")))
            # Read actual blobs: repository attributes can suppress text hunks.
            changed = git("diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", "-r", "-z", commit, "--")
            for filename in set(changed.split("\0")) - {""}:
                content = subprocess.check_output(["git", "cat-file", "blob", f"{commit}:{filename}"])
                metadata.append(("published file", content.decode("utf-8", errors="replace")))
        metadata.append(("HEAD refs", git("for-each-ref", "--points-at=HEAD", "--format=%(refname)", "refs/heads", "refs/tags")))
        metadata.append(("tag messages", git("for-each-ref", "--points-at=HEAD", "--format=%(contents)", "refs/tags")))
    except subprocess.CalledProcessError as error:
        print(f"Could not compare against {base}: {error}", file=sys.stderr)
        return 2

    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path:
        with open(event_path, encoding="utf-8") as event_file:
            pull_request = json.load(event_file).get("pull_request", {})
        metadata.extend(
            [
                ("PR title", pull_request.get("title") or ""),
                ("PR body", pull_request.get("body") or ""),
            ]
        )

    # Only hunk content has a leading diff marker; a content line beginning
    # with ++ must not be confused with the +++ file header.
    added = []
    for diff in diffs:
        in_hunk = False
        for line in diff.splitlines():
            if line.startswith("diff --git "):
                in_hunk = False
            elif line.startswith("@@ "):
                in_hunk = True
            elif in_hunk and line.startswith("+"):
                added.append(line[1:])
    metadata.append(("added lines", "\n".join(added)))
    branch = git("branch", "--show-current").strip()
    metadata.append(("branch name", branch))
    if event_path:
        metadata.append(("PR head ref", pull_request.get("head", {}).get("ref") or ""))

    for allowed in ALLOWED:
        metadata = [(location, content.replace(allowed, "")) for location, content in metadata]

    findings = [
        f"{location}: {name}"
        for location, content in metadata
        for name, pattern in PATTERNS.items()
        if pattern.search(content)
    ]
    if findings:
        print("Check these public references before publishing:")
        print("\n".join(f"- {finding}" for finding in findings))
        return 1

    print("No known internal references found. Review for other private data before publishing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
