"""Runs "metergraph-skills" as a subprocess against real temporary projects.

When the package sits inside the metergraph/cli checkout, the tests also check
that the bundled skill is byte-identical to the npm CLI's copy and that the
two installers recognise each other's files.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGE_ROOT.parent.parent
NPM_BIN = REPO_ROOT / "bin" / "metergraph.js"
SHA256 = "57b920677adf62759c7221629327192a2d16b7e6034f7948ffd96cee402d4891"
REVISION = "sha256-57b920677adf"
PATHS = {
    "codex": ".agents/skills/metergraph/SKILL.md",
    "claude": ".claude/skills/metergraph/SKILL.md",
    "cursor": ".cursor/skills/metergraph/SKILL.md",
}
RECEIPT = ".metergraph/skill-installations.json"
LOCK = ".metergraph/skill-installations.lock"
IS_WINDOWS = os.name == "nt"


def run(*args, project=None):
    command = [sys.executable, "-m", "metergraph_skills", *args, "--json"]
    if project is not None:
        command += ["--project", str(project)]
    env = dict(os.environ)
    if os.environ.get("METERGRAPH_SKILLS_TEST_INSTALLED") != "1":
        env["PYTHONPATH"] = str(PACKAGE_ROOT / "src")
    completed = subprocess.run(command, capture_output=True, env=env, check=False)
    result = json.loads(completed.stdout.decode("utf-8"))
    assert completed.returncode == result["exit_code"], completed
    return result


def run_raw(*args):
    env = dict(os.environ)
    if os.environ.get("METERGRAPH_SKILLS_TEST_INSTALLED") != "1":
        env["PYTHONPATH"] = str(PACKAGE_ROOT / "src")
    return subprocess.run([sys.executable, "-m", "metergraph_skills", *args], capture_output=True, env=env, check=False)


# Bad arguments that both CLIs must reject with the same JSON envelope. The
# token-like value checks that no argument value is ever echoed back.
SECRET = "mg_live_do_not_echo_0123456789"
USAGE_CASES = [
    ["install", "--json"],
    ["install", "--client", "codex", "--json"],
    ["install", "--client", SECRET, "--runtime", "local", "--json"],
    ["install", "--client", "codex", "--runtime", SECRET, "--json"],
    ["install", "--client", "codex", "--runtime", "local", "--project", "", "--json"],
    ["update", "--client", "codex", "--client", "claude", "--runtime", "local", "--json"],
    ["update", "--client", "codex", "--runtime", "local", SECRET, "--json"],
    ["install", "--client", "--json"],
]


def bundled_skill():
    env = dict(os.environ)
    if os.environ.get("METERGRAPH_SKILLS_TEST_INSTALLED") != "1":
        env["PYTHONPATH"] = str(PACKAGE_ROOT / "src")
    out = subprocess.run(
        [sys.executable, "-m", "metergraph_skills", "path"], capture_output=True, env=env, check=True
    )
    return (Path(out.stdout.decode("utf-8").strip()) / "SKILL.md").read_bytes()


def snapshot(root):
    result = {}
    for path in sorted(Path(root).rglob("*")):
        if path.is_file() and not path.is_symlink():
            info = path.stat()
            result[path.relative_to(root).as_posix()] = (path.read_bytes(), info.st_ino, info.st_mtime_ns)
    return result


class InstallerTest(unittest.TestCase):
    def setUp(self):
        # The space checks that nothing splits or quotes paths.
        self.project = Path(tempfile.mkdtemp(prefix="metergraph skills test "))
        self.addCleanup(shutil.rmtree, self.project, True)

    def write(self, relative, content):
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def read(self, relative):
        return (self.project / relative).read_bytes()

    def test_install_writes_skill_and_receipt(self):
        result = run("install", "--client", "claude", "--runtime", "local", project=self.project)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["status"], "installed")
        self.assertEqual(result["data"]["source"]["revision"], REVISION)
        self.assertEqual(result["data"]["discovery"], "pending")
        self.assertFalse(result["data"]["authenticated"])
        self.assertEqual(hashlib.sha256(self.read(PATHS["claude"])).hexdigest(), SHA256)
        receipt = json.loads(self.read(RECEIPT))
        self.assertEqual(
            receipt,
            {
                "schema_version": 1,
                "installations": [
                    {
                        "client": "claude",
                        "path": PATHS["claude"],
                        "skill": "metergraph",
                        "revision": REVISION,
                        "sha256": SHA256,
                        "runtimes": ["local"],
                    }
                ],
            },
        )
        self.assertFalse((self.project / LOCK).exists())
        self.assertEqual(
            sorted(p.relative_to(self.project).as_posix() for p in self.project.rglob("*") if p.is_file()),
            sorted([PATHS["claude"], RECEIPT]),
        )

    def test_matching_rerun_writes_nothing(self):
        run("install", "--client", "codex", "--runtime", "local", project=self.project)
        before = snapshot(self.project)
        result = run("install", "--client", "codex", "--runtime", "local", project=self.project)
        self.assertEqual(result["data"]["status"], "reused")
        self.assertEqual(snapshot(self.project), before)

    def test_second_runtime_is_recorded(self):
        run("install", "--client", "cursor", "--runtime", "local", project=self.project)
        result = run("install", "--client", "cursor", "--runtime", "cloud", project=self.project)
        self.assertEqual(result["data"]["status"], "reused")
        entry = json.loads(self.read(RECEIPT))["installations"][0]
        self.assertEqual(entry["runtimes"], ["cloud", "local"])

    def test_unowned_skill_is_not_replaced(self):
        self.write(PATHS["claude"], b"mine\n")
        result = run("install", "--client", "claude", "--runtime", "local", project=self.project)
        self.assertEqual((result["outcome"], result["error"]["reason"]), ("conflict", "not_owned"))
        self.assertEqual(self.read(PATHS["claude"]), b"mine\n")
        self.assertFalse((self.project / RECEIPT).exists())

    def test_modified_skill_is_not_replaced(self):
        run("install", "--client", "claude", "--runtime", "local", project=self.project)
        self.write(PATHS["claude"], b"edited\n")
        for action in ("install", "update"):
            result = run(action, "--client", "claude", "--runtime", "local", project=self.project)
            self.assertEqual(result["error"]["reason"], "modified")
        self.assertEqual(self.read(PATHS["claude"]), b"edited\n")

    def older_install(self):
        old = b"---\nname: metergraph\ndescription: old\n---\n"
        old_sha = hashlib.sha256(old).hexdigest()
        self.write(PATHS["codex"], old)
        receipt = {
            "schema_version": 1,
            "installations": [
                {
                    "client": "codex",
                    "path": PATHS["codex"],
                    "skill": "metergraph",
                    "revision": "sha256-" + old_sha[:12],
                    "sha256": old_sha,
                    "runtimes": ["local"],
                }
            ],
        }
        self.write(RECEIPT, (json.dumps(receipt, indent=2) + "\n").encode())

    def test_install_over_older_revision_requires_update(self):
        self.older_install()
        result = run("install", "--client", "codex", "--runtime", "local", project=self.project)
        self.assertEqual(result["error"]["reason"], "update_required")

    def test_update_replaces_older_revision(self):
        self.older_install()
        result = run("update", "--client", "codex", "--runtime", "local", project=self.project)
        self.assertEqual(result["data"]["status"], "updated")
        self.assertEqual(hashlib.sha256(self.read(PATHS["codex"])).hexdigest(), SHA256)
        self.assertEqual(json.loads(self.read(RECEIPT))["installations"][0]["revision"], REVISION)

    def test_update_without_install(self):
        result = run("update", "--client", "codex", "--runtime", "local", project=self.project)
        self.assertEqual(result["error"]["reason"], "not_installed")
        self.assertEqual(list(self.project.iterdir()), [])

    def test_invalid_receipt_stops(self):
        self.write(RECEIPT, b'{"schema_version": 1, "installations": [], "extra": 1}\n')
        result = run("install", "--client", "codex", "--runtime", "local", project=self.project)
        self.assertEqual(result["error"]["reason"], "receipt_invalid")
        self.assertFalse((self.project / PATHS["codex"]).exists())

    def test_existing_lock_stops(self):
        self.write(LOCK, b"")
        result = run("install", "--client", "codex", "--runtime", "local", project=self.project)
        self.assertEqual((result["outcome"], result["error"]["reason"]), ("conflict", "locked"))
        self.assertFalse((self.project / PATHS["codex"]).exists())
        self.assertFalse((self.project / RECEIPT).exists())

    @unittest.skipIf(IS_WINDOWS, "symbolic links need extra privileges on Windows")
    def test_symbolic_link_is_unsafe(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        os.symlink(outside, self.project / ".claude")
        result = run("install", "--client", "claude", "--runtime", "local", project=self.project)
        self.assertEqual(result["error"]["reason"], "unsafe_path")
        self.assertEqual(list(outside.iterdir()), [])

    def test_handoff_clients_and_runtimes_write_nothing(self):
        for client, runtime, reason in (
            ("chatgpt", "local", "client_not_supported"),
            ("claude", "cloud-no-shell", "runtime_not_supported"),
        ):
            result = run("install", "--client", client, "--runtime", runtime, project=self.project)
            self.assertEqual((result["outcome"], result["error"]["reason"]), ("unsupported", reason))
            self.assertEqual(result["data"]["next_action"]["kind"], "connection_guide")
        self.assertEqual(list(self.project.iterdir()), [])

    def test_usage_errors_return_json_and_never_echo_values(self):
        for argv in USAGE_CASES:
            with self.subTest(argv=argv):
                completed = run_raw(*argv)
                self.assertEqual(completed.returncode, 2)
                result = json.loads(completed.stdout.decode("utf-8"))
                self.assertEqual((result["outcome"], result["exit_code"], result["data"]), ("invalid_input", 2, None))
                self.assertNotIn(SECRET.encode(), completed.stdout + completed.stderr)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_empty_project_is_rejected(self):
        completed = run_raw("install", "--client", "codex", "--runtime", "local", "--project", "", "--json")
        self.assertEqual(json.loads(completed.stdout)["error"]["reason"], "invalid_project")
        sys.path.insert(0, str(PACKAGE_ROOT / "src"))
        try:
            from metergraph_skills.installer import run_skill
        finally:
            sys.path.pop(0)
        result = run_skill("install", "codex", "local", "")
        self.assertEqual(result["reason"], "invalid_project")

    @unittest.skipUnless(IS_WINDOWS, "directory junctions exist only on Windows")
    def test_directory_junction_is_unsafe(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        for name in (".claude", ".metergraph"):
            link = self.project / name
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, check=True)
            result = run("install", "--client", "claude", "--runtime", "local", project=self.project)
            self.assertEqual(result["error"]["reason"], "unsafe_path")
            self.assertEqual(list(outside.iterdir()), [])
            os.rmdir(link)

    def test_missing_project(self):
        result = run("install", "--client", "codex", "--runtime", "local", project=self.project / "missing")
        self.assertEqual((result["outcome"], result["error"]["reason"]), ("invalid_input", "invalid_project"))


@unittest.skipUnless((REPO_ROOT / "assets" / "skill" / "SKILL.md").is_file(), "not inside the CLI checkout")
class NpmParityTest(unittest.TestCase):
    def test_bundled_skill_matches_npm_copy(self):
        self.assertEqual(bundled_skill(), (REPO_ROOT / "assets" / "skill" / "SKILL.md").read_bytes())
        manifest = PACKAGE_ROOT / "src" / "metergraph_skills" / "skill" / "manifest.json"
        self.assertEqual(manifest.read_bytes(), (REPO_ROOT / "assets" / "skill" / "manifest.json").read_bytes())

    def test_pinned_hash_matches_npm_cli(self):
        npm_source = (REPO_ROOT / "src" / "skill-bundle.js").read_text(encoding="utf-8")
        self.assertIn('const PINNED_SHA256 = "{}";'.format(SHA256), npm_source)

    @unittest.skipUnless(shutil.which("node") and NPM_BIN.is_file(), "node is not available")
    def test_usage_errors_match_npm(self):
        for argv in USAGE_CASES:
            with self.subTest(argv=argv):
                python = json.loads(run_raw(*argv).stdout)
                node = subprocess.run(["node", str(NPM_BIN), "skill", *argv], capture_output=True, check=False)
                expected = json.loads(node.stdout)
                # The npm messages name "metergraph"; the reasons and shape match.
                for result in (python, expected):
                    result["error"].pop("message")
                self.assertEqual(python, expected)

    @unittest.skipUnless(shutil.which("node") and NPM_BIN.is_file(), "node is not available")
    def test_installers_share_files_and_receipt(self):
        node_project = Path(tempfile.mkdtemp(prefix="metergraph skills node "))
        python_project = Path(tempfile.mkdtemp(prefix="metergraph skills python "))
        self.addCleanup(shutil.rmtree, node_project, True)
        self.addCleanup(shutil.rmtree, python_project, True)
        for client, runtime in (("claude", "local"), ("codex", "cloud")):
            subprocess.run(
                ["node", str(NPM_BIN), "skill", "install", "--client", client, "--runtime", runtime,
                 "--project", str(node_project), "--json"],
                capture_output=True, check=True,
            )
            run("install", "--client", client, "--runtime", runtime, project=python_project)
        self.assertEqual(snapshot_bytes(node_project), snapshot_bytes(python_project))

        # Each installer reuses what the other one wrote.
        result = run("install", "--client", "claude", "--runtime", "local", project=node_project)
        self.assertEqual(result["data"]["status"], "reused")
        node = subprocess.run(
            ["node", str(NPM_BIN), "skill", "install", "--client", "codex", "--runtime", "cloud",
             "--project", str(python_project), "--json"],
            capture_output=True, check=True,
        )
        self.assertEqual(json.loads(node.stdout)["data"]["status"], "reused")


def snapshot_bytes(root):
    return {key: value[0] for key, value in snapshot(root).items()}


if __name__ == "__main__":
    unittest.main()
