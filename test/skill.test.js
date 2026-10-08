// Runs "metergraph skill" as a subprocess against real temporary project
// directories. Every run uses the offline guard, so any network attempt fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL = fs.readFileSync(path.join(ROOT, "assets", "skill", "SKILL.md"));
const SHA256 = "c764eb57691e4fa1088a4cfe00a43608b1451bb075a04d03820c92b5148fc0bf";
const REVISION = "sha256-c764eb57691e";
const GUIDE_URL = "https://www.metergraph.dev/docs/guides/agent-access/";
const FAULTS = pathToFileURL(fileURLToPath(new URL("./fixtures/fs-faults.js", import.meta.url))).href;
const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

const PATHS = {
  codex: ".agents/skills/metergraph/SKILL.md",
  claude: ".claude/skills/metergraph/SKILL.md",
  cursor: ".cursor/skills/metergraph/SKILL.md",
};
const RECEIPT = ".metergraph/skill-installations.json";
const LOCK = ".metergraph/skill-installations.lock";

// The space in every path checks that nothing splits or quotes paths.
const workDir = fs.mkdtempSync(path.join(tmpdir(), "metergraph skill test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function project(files = {}) {
  counter += 1;
  const dir = path.join(workDir, `project ${counter}`);
  fs.mkdirSync(dir);
  for (const [relative, content] of Object.entries(files)) write(dir, relative, content);
  return dir;
}

function write(dir, relative, content) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(dir, relative) {
  return fs.readFileSync(path.join(dir, relative));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Every entry below dir, sorted. Directories end in "/", symbolic links in "@".
// Links are never followed.
function listFiles(dir, prefix = "") {
  const entries = [];
  for (const name of fs.readdirSync(path.join(dir, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(path.join(dir, relative));
    if (stat.isSymbolicLink()) entries.push(`${relative}@`);
    else if (stat.isDirectory()) entries.push(`${relative}/`, ...listFiles(dir, relative));
    else entries.push(relative);
  }
  return entries;
}

// Content, inode, modification time and mode of every regular file. Equal
// snapshots mean nothing was rewritten, replaced or re-permissioned.
function snapshot(dir) {
  const result = {};
  for (const relative of listFiles(dir)) {
    if (relative.endsWith("/") || relative.endsWith("@")) continue;
    const full = path.join(dir, relative);
    const stat = fs.lstatSync(full, { bigint: true });
    result[relative] = {
      content: fs.readFileSync(full).toString("base64"),
      ino: stat.ino,
      mtime: stat.mtimeNs,
      mode: stat.mode,
    };
  }
  return result;
}

function assertNoLeftovers(dir) {
  for (const entry of listFiles(dir)) {
    assert.ok(!entry.endsWith(".tmp"), "a temporary file was left behind");
    assert.notEqual(entry, LOCK, "the lock was left behind");
  }
}

function receiptFor(installations) {
  return `${JSON.stringify({ schema_version: 1, installations }, null, 2)}\n`;
}

function entryFor(client, content, runtimes = ["local"]) {
  const hash = sha256(content);
  return {
    client,
    path: PATHS[client],
    skill: "metergraph",
    revision: `sha256-${hash.slice(0, 12)}`,
    sha256: hash,
    runtimes,
  };
}

const OLD_SKILL = Buffer.from(
  "---\nname: metergraph\ndescription: Older synthetic revision used only by tests.\n---\n\nSynthetic.\n",
);

// Lays down what an earlier CLI version would have installed.
function priorInstall(dir, client = "claude") {
  write(dir, PATHS[client], OLD_SKILL);
  write(dir, RECEIPT, receiptFor([entryFor(client, OLD_SKILL)]));
}

async function skill(args, options = {}) {
  // --json goes first so a trailing option without a value stays without one.
  const run = await runCli(["--json", "skill", ...args], { offline: true, ...options });
  assert.equal(run.stderr, "", "JSON mode must keep stderr empty");
  assertNoLeak(assert, run.stdout);
  assert.ok(!run.stdout.includes("SYNTHETIC_FAULT_MARKER"), "raw error text was printed");
  const result = parseJsonLine(run.stdout);
  assert.equal(result.schema_version, 1);
  assert.equal(result.exit_code, run.code);
  return result;
}

function install(dir, { client = "claude", runtime = "local", action = "install", ...options } = {}) {
  return skill([action, "--client", client, "--runtime", runtime, "--project", dir], options);
}

function assertFailure(result, outcome, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.outcome, outcome);
  assert.equal(result.error.code, outcome);
  assert.equal(result.error.reason, reason);
  assert.equal(typeof result.error.message, "string");
  assert.equal(result.data?.status ?? null, null);
}

function trySymlink(target, link, type) {
  try {
    fs.symlinkSync(target, link, isWindows && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (isWindows && error.code === "EPERM") return false;
    throw error;
  }
}

test("the bundled skill matches the pinned hash and its manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "skill", "manifest.json"), "utf8"));
  assert.equal(SKILL.length, 11561);
  assert.equal(sha256(SKILL), SHA256);
  assert.deepEqual(manifest, {
    manifest_version: 1,
    name: "metergraph",
    file: "SKILL.md",
    source_url: "https://www.metergraph.dev/SKILL.md",
    sha256: SHA256,
    size: 11561,
    revision: REVISION,
  });
  assert.ok(SKILL.toString("utf8").startsWith("---\nname: metergraph\ndescription: "));
});

test("installs a fresh skill for each client and records ownership", async () => {
  for (const client of Object.keys(PATHS)) {
    const dir = project();
    const result = await install(dir, { client });
    assert.equal(result.ok, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.command, "skill install");
    assert.equal(result.error, null);
    assert.equal(typeof result.data.next_action.message, "string");
    assert.deepEqual(result.data, {
      client,
      runtime: "local",
      path: PATHS[client],
      status: "installed",
      source: { name: "metergraph", revision: REVISION, sha256: SHA256 },
      discovery: "pending",
      authenticated: false,
      next_action: { kind: "reload_client", message: result.data.next_action.message },
    });
    assert.ok(!result.data.next_action.message.includes(dir), "absolute paths must not be printed");
    assert.deepEqual(read(dir, PATHS[client]), SKILL);

    const receiptText = read(dir, RECEIPT).toString("utf8");
    assertNoLeak(assert, receiptText);
    assert.ok(!receiptText.includes(workDir), "the receipt must hold relative paths only");
    assert.deepEqual(JSON.parse(receiptText), {
      schema_version: 1,
      installations: [entryFor(client, SKILL)],
    });

    const [clientDir] = PATHS[client].split("/");
    assert.deepEqual(listFiles(dir), [
      `${clientDir}/`,
      `${clientDir}/skills/`,
      `${clientDir}/skills/metergraph/`,
      PATHS[client],
      ".metergraph/",
      RECEIPT,
    ]);
  }
});

test("prints a truthful text summary without --json", async () => {
  const dir = project();
  const run = await runCli(
    ["skill", "install", "--client", "cursor", "--runtime", "local", "--project", dir],
    { offline: true },
  );
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /Path: \.cursor\/skills\/metergraph\/SKILL\.md/);
  assert.match(run.stdout, /Discovery: pending until Cursor loads the skill/);
  assert.match(run.stdout, /Authenticated: no/);
  assert.match(run.stdout, /does not sign in, connect a workspace or configure MCP/);
  assert.ok(!run.stdout.includes(dir));
});

test("the cloud runtime is recorded and a second runtime only updates the receipt", async () => {
  const dir = project();
  const cloud = await install(dir, { client: "codex", runtime: "cloud" });
  assert.equal(cloud.data.status, "installed");
  assert.equal(cloud.data.runtime, "cloud");
  assert.match(cloud.data.next_action.message, /cloud session/);
  assert.match(cloud.data.next_action.message, /\.agents\/skills\/metergraph\/SKILL\.md/);
  assert.deepEqual(JSON.parse(read(dir, RECEIPT)).installations[0].runtimes, ["cloud"]);

  const skillBefore = snapshot(dir)[PATHS.codex];
  const local = await install(dir, { client: "codex", runtime: "local" });
  assert.equal(local.data.status, "reused");
  assert.equal(local.data.runtime, "local");
  assert.deepEqual(snapshot(dir)[PATHS.codex], skillBefore, "the skill file must not be rewritten");
  assert.deepEqual(JSON.parse(read(dir, RECEIPT)).installations[0].runtimes, ["cloud", "local"]);
  assertNoLeftovers(dir);
});

test("--project defaults to the working directory and accepts relative paths", async () => {
  const dir = project();
  const implicit = await skill(["install", "--client", "claude", "--runtime", "local"], { cwd: dir });
  assert.equal(implicit.data.status, "installed");
  assert.deepEqual(read(dir, PATHS.claude), SKILL);

  const other = project();
  const relative = await skill(
    ["install", "--client", "codex", "--runtime", "local", `--project=${path.basename(other)}`],
    { cwd: workDir },
  );
  assert.equal(relative.data.status, "installed");
  assert.deepEqual(read(other, PATHS.codex), SKILL);
});

test("unrelated client files and settings are left untouched", async () => {
  const dir = project({
    ".claude/settings.json": '{"permissions":{"allow":[]}}\n',
    ".claude/skills/other/SKILL.md": "---\nname: other\ndescription: Synthetic.\n---\n",
    ".agents/skills/other/SKILL.md": "---\nname: other\ndescription: Synthetic.\n---\n",
    ".cursor/rules/style.mdc": "Synthetic rule.\n",
    ".codex/config.toml": "# synthetic\n",
    "AGENTS.md": "# Synthetic agents file\n",
    "CLAUDE.md": "# Synthetic claude file\n",
    ".gitignore": "node_modules/\n",
  });
  if (!isWindows) fs.chmodSync(path.join(dir, ".claude/settings.json"), 0o600);
  const before = snapshot(dir);

  for (const client of ["claude", "codex", "cursor"]) {
    assert.equal((await install(dir, { client })).data.status, "installed");
  }

  const afterInstall = snapshot(dir);
  for (const [relative, entry] of Object.entries(before)) {
    assert.deepEqual(afterInstall[relative], entry, "an unrelated file changed");
  }
  assert.deepEqual(
    JSON.parse(read(dir, RECEIPT)).installations,
    ["claude", "codex", "cursor"].map((client) => entryFor(client, SKILL)),
  );
  assertNoLeftovers(dir);
});

test("an unchanged rerun of install or update writes nothing", async () => {
  const dir = project();
  await install(dir);
  const before = snapshot(dir);
  const listing = listFiles(dir);
  for (const action of ["install", "update"]) {
    const result = await install(dir, { action });
    assert.equal(result.ok, true);
    assert.equal(result.data.status, "reused");
    assert.equal(result.data.discovery, "pending");
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(listFiles(dir), listing);
  }
  assertNoLeftovers(dir);
});

test("a skill this CLI did not install is refused, even with identical bytes", async () => {
  const cases = [
    { [PATHS.claude]: SKILL },
    { ".claude/skills/metergraph/README.md": "Synthetic.\n" },
  ];
  for (const files of cases) {
    const dir = project(files);
    const before = snapshot(dir);
    for (const action of ["install", "update"]) {
      const result = await install(dir, { action });
      assertFailure(result, "conflict", "not_owned");
      assert.equal(result.exit_code, 8);
    }
    assert.deepEqual(snapshot(dir), before);
    assert.ok(!fs.existsSync(path.join(dir, ".metergraph")));
  }
});

test("update refuses a project where this CLI installed nothing", async () => {
  const dir = project();
  assertFailure(await install(dir, { action: "update" }), "conflict", "not_installed");
  assert.deepEqual(listFiles(dir), []);
});

test("a modified owned skill is never overwritten, including by update", async () => {
  const dir = project();
  await install(dir);
  fs.appendFileSync(path.join(dir, PATHS.claude), "\nLocal synthetic edit.\n");
  const before = snapshot(dir);
  for (const action of ["install", "update"]) {
    assertFailure(await install(dir, { action }), "conflict", "modified");
  }
  assert.deepEqual(snapshot(dir), before);
  assertNoLeftovers(dir);
});

test("update replaces a prior owned revision and keeps permissions and other entries", async () => {
  const dir = project({ [PATHS.cursor]: SKILL });
  write(dir, PATHS.claude, OLD_SKILL);
  const cursorEntry = entryFor("cursor", SKILL, ["cloud"]);
  write(dir, RECEIPT, receiptFor([entryFor("claude", OLD_SKILL), cursorEntry]));
  if (!isWindows) fs.chmodSync(path.join(dir, PATHS.claude), 0o640);
  const before = snapshot(dir);

  const refused = await install(dir);
  assertFailure(refused, "conflict", "update_required");
  assert.deepEqual(snapshot(dir), before);

  const updated = await install(dir, { action: "update", runtime: "cloud" });
  assert.equal(updated.ok, true);
  assert.equal(updated.command, "skill update");
  assert.equal(updated.data.status, "updated");
  assert.equal(updated.data.source.revision, REVISION);
  assert.deepEqual(read(dir, PATHS.claude), SKILL);
  if (!isWindows) assert.equal(fs.statSync(path.join(dir, PATHS.claude)).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(read(dir, RECEIPT)).installations, [
    entryFor("claude", SKILL, ["cloud", "local"]),
    cursorEntry,
  ]);
  assert.deepEqual(snapshot(dir)[PATHS.cursor], before[PATHS.cursor]);
  assertNoLeftovers(dir);
});

test("a missing owned skill is recreated, and an old missing one needs update", async () => {
  const dir = project();
  await install(dir);
  const receiptBefore = snapshot(dir)[RECEIPT];
  fs.rmSync(path.join(dir, ".claude"), { recursive: true });
  const result = await install(dir);
  assert.equal(result.data.status, "installed");
  assert.deepEqual(read(dir, PATHS.claude), SKILL);
  assert.deepEqual(snapshot(dir)[RECEIPT], receiptBefore, "an unchanged receipt is not rewritten");

  const old = project();
  priorInstall(old);
  fs.rmSync(path.join(old, PATHS.claude));
  assertFailure(await install(old), "conflict", "update_required");
  assert.ok(!fs.existsSync(path.join(old, PATHS.claude)));
  assert.equal((await install(old, { action: "update" })).data.status, "updated");
  assert.deepEqual(read(old, PATHS.claude), SKILL);
});

test("symbolic links and non-regular entries are refused without following them", async () => {
  const outside = path.join(workDir, "outside target");
  fs.mkdirSync(outside);
  write(outside, "SKILL.md", SKILL);
  const outsideBefore = snapshot(outside);

  const cases = [
    ["skills directory link", (dir) => {
      fs.mkdirSync(path.join(dir, ".claude"));
      return trySymlink(outside, path.join(dir, ".claude", "skills"), "dir");
    }],
    ["receipt directory link", (dir) => trySymlink(outside, path.join(dir, ".metergraph"), "dir")],
    ["skill file link", (dir) => {
      fs.mkdirSync(path.join(dir, ".claude", "skills", "metergraph"), { recursive: true });
      return trySymlink(path.join(outside, "SKILL.md"), path.join(dir, PATHS.claude), "file");
    }],
    ["receipt file link", (dir) => {
      fs.mkdirSync(path.join(dir, ".metergraph"));
      return trySymlink(path.join(outside, "SKILL.md"), path.join(dir, RECEIPT), "file");
    }],
    ["client directory is a file", (dir) => {
      write(dir, ".claude", "synthetic");
      return true;
    }],
    ["receipt is a directory", (dir) => {
      fs.mkdirSync(path.join(dir, RECEIPT), { recursive: true });
      return true;
    }],
    ["skill path is a directory", (dir) => {
      fs.mkdirSync(path.join(dir, PATHS.claude), { recursive: true });
      return true;
    }],
  ];
  for (const [label, setup] of cases) {
    const dir = project();
    if (!setup(dir)) continue;
    const before = listFiles(dir);
    for (const action of ["install", "update"]) {
      const result = await install(dir, { action });
      assertFailure(result, "conflict", "unsafe_path");
      assert.deepEqual(listFiles(dir), before, `${label}: the project changed`);
    }
  }
  assert.deepEqual(snapshot(outside), outsideBefore, "a file outside the project changed");
});

test("--project must be an existing directory and is never echoed", async () => {
  const file = path.join(project({ "file.txt": "x" }), "file.txt");
  for (const value of [path.join(workDir, "missing hunter2"), file]) {
    const result = await skill(["install", "--client", "claude", "--runtime", "local", "--project", value]);
    assertFailure(result, "invalid_input", "invalid_project");
    assert.equal(result.exit_code, 2);
    assert.ok(!JSON.stringify(result).includes(value));
  }
  const empty = await skill(["install", "--client", "claude", "--runtime", "local", "--project="]);
  assertFailure(empty, "invalid_input", "invalid_project");
  assert.ok(!fs.existsSync(path.join(workDir, "missing hunter2")));
});

test("invalid arguments are rejected before any write and never echoed", async () => {
  const cases = [
    [["install"], "missing_client"],
    [["install", "--client", "hunter2", "--runtime", "local"], "invalid_client"],
    [["install", "--client", "claude", "--runtime", "sk-fake-2222222222222222"], "invalid_runtime"],
    [["install", "--client", "claude"], "missing_runtime"],
    [["--client", "claude", "--runtime", "local"], "missing_subcommand"],
    [["remove", "--client", "claude", "--runtime", "local"], "unknown_subcommand"],
    [["install", "--client", "claude", "--client", "codex", "--runtime", "local"], "duplicate_option"],
    [["install", "--client", "claude", "--runtime", "local", "--force"], "unknown_argument"],
    [["update", "--client", "claude", "--runtime", "local", "--token=hunter2"], "unknown_argument"],
    [["install", "--client", "claude", "--runtime", "local", "--project"], "missing_value"],
  ];
  for (const [args, reason] of cases) {
    const dir = project();
    const result = await skill(args, { cwd: dir });
    assertFailure(result, "invalid_input", reason);
    assert.equal(result.data, null);
    assert.deepEqual(listFiles(dir), []);

    const text = await runCli(["skill", ...args], { offline: true, cwd: dir });
    assert.equal(text.code, 2);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /^Error: /);
    assertNoLeak(assert, text.stderr);
    assert.deepEqual(listFiles(dir), []);
  }
});

test("Desktop, ChatGPT and shell-less cloud runtimes get a guide handoff and no writes", async () => {
  const cases = [
    ["claude-desktop", "local", "client_not_supported"],
    ["chatgpt", "cloud", "client_not_supported"],
    ["claude", "cloud-no-shell", "runtime_not_supported"],
    ["codex", "cloud-no-shell", "runtime_not_supported"],
  ];
  for (const [client, runtime, reason] of cases) {
    const dir = project();
    const result = await install(dir, { client, runtime });
    assertFailure(result, "unsupported", reason);
    assert.equal(result.exit_code, 6);
    assert.deepEqual(result.data.next_action, { kind: "connection_guide", url: GUIDE_URL });
    assert.equal(result.data.path, null);
    assert.equal(result.data.discovery, null);
    assert.equal(result.data.authenticated, false);
    assert.deepEqual(listFiles(dir), []);
  }
});

test("a tampered or malformed receipt is refused and left as it was", async () => {
  const valid = entryFor("claude", SKILL);
  const receipts = [
    "not json SYNTHETIC_BODY_MARKER",
    "[]",
    JSON.stringify({ schema_version: 2, installations: [] }),
    JSON.stringify({ schema_version: 1, installations: [], token: "SYNTHETIC_BODY_MARKER" }),
    receiptFor([{ ...valid, path: ".agents/skills/metergraph/SKILL.md" }]),
    receiptFor([{ ...valid, path: "../outside/SKILL.md" }]),
    receiptFor([valid, valid]),
    receiptFor([{ ...valid, revision: "sha256-000000000000" }]),
    receiptFor([{ ...valid, client: "chatgpt" }]),
    receiptFor([{ ...valid, runtimes: [] }]),
    receiptFor([{ ...valid, runtimes: ["local", "local"] }]),
    receiptFor([{ ...valid, credential: "SYNTHETIC_BODY_MARKER" }]),
    `${receiptFor([])}${" ".repeat(70 * 1024)}`,
  ];
  for (const receipt of receipts) {
    const dir = project({ [RECEIPT]: receipt, [PATHS.claude]: SKILL });
    const before = snapshot(dir);
    for (const action of ["install", "update"]) {
      assertFailure(await install(dir, { action }), "conflict", "receipt_invalid");
    }
    assert.deepEqual(snapshot(dir), before);
  }
});

test("tampered bundled assets are detected before any write", async () => {
  const variants = {
    "skill byte changed": (copy) => {
      const file = path.join(copy, "assets", "skill", "SKILL.md");
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 2] ^= 1;
      fs.writeFileSync(file, bytes);
    },
    "skill and manifest changed together": (copy) => {
      const file = path.join(copy, "assets", "skill", "SKILL.md");
      const bytes = Buffer.concat([fs.readFileSync(file), Buffer.from("Injected.\n")]);
      fs.writeFileSync(file, bytes);
      const manifestFile = path.join(copy, "assets", "skill", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      const hash = sha256(bytes);
      Object.assign(manifest, { sha256: hash, size: bytes.length, revision: `sha256-${hash.slice(0, 12)}` });
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    },
    "manifest source changed": (copy) => {
      const manifestFile = path.join(copy, "assets", "skill", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      manifest.source_url = "https://evil.example.com/SKILL.md";
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    },
    "manifest missing": (copy) => fs.rmSync(path.join(copy, "assets", "skill", "manifest.json")),
    "skill missing": (copy) => fs.rmSync(path.join(copy, "assets", "skill", "SKILL.md")),
  };
  for (const [label, tamper] of Object.entries(variants)) {
    const copy = path.join(workDir, `package copy ${label}`);
    fs.mkdirSync(copy);
    for (const entry of ["bin", "src", "assets", "package.json"]) {
      fs.cpSync(path.join(ROOT, entry), path.join(copy, entry), { recursive: true });
    }
    tamper(copy);
    const dir = project();
    const result = await install(dir, { bin: path.join(copy, "bin", "metergraph.js") });
    assertFailure(result, "internal_error", "bundled_skill_invalid");
    assert.equal(result.exit_code, 1);
    assert.deepEqual(listFiles(dir), [], `${label}: the project changed`);
  }
});

test("a failed receipt write rolls back a fresh install", async () => {
  const dir = project({ ".claude/settings.json": "{}\n" });
  const before = snapshot(dir);
  const result = await install(dir, { imports: [FAULTS], env: { METERGRAPH_TEST_FAULT: "receipt-rename" } });
  assertFailure(result, "filesystem_error", "write_failed");
  assert.equal(result.exit_code, 9);
  assert.deepEqual(listFiles(dir), [".claude/", ".claude/settings.json"]);
  assert.deepEqual(snapshot(dir), before);
});

test("a failed receipt write during update restores the previous revision", async () => {
  const dir = project();
  priorInstall(dir);
  const before = snapshot(dir);
  const result = await install(dir, {
    action: "update",
    imports: [FAULTS],
    env: { METERGRAPH_TEST_FAULT: "receipt-rename" },
  });
  assertFailure(result, "filesystem_error", "write_failed");
  assert.deepEqual(read(dir, PATHS.claude), OLD_SKILL);
  assert.deepEqual(read(dir, RECEIPT), Buffer.from(before[RECEIPT].content, "base64"));
  assertNoLeftovers(dir);
  assert.equal((await install(dir, { action: "update" })).data.status, "updated");
});

test("unwritable directories fail cleanly", { skip: isWindows || isRoot }, async () => {
  const dir = project({ ".claude/skills/other/SKILL.md": "Synthetic.\n" });
  const skills = path.join(dir, ".claude", "skills");
  fs.chmodSync(skills, 0o555);
  try {
    const result = await install(dir);
    assertFailure(result, "filesystem_error", "write_failed");
  } finally {
    fs.chmodSync(skills, 0o755);
  }
  assert.deepEqual(listFiles(dir), [".claude/", ".claude/skills/", ".claude/skills/other/", ".claude/skills/other/SKILL.md"]);

  const locked = project();
  fs.chmodSync(locked, 0o555);
  try {
    assertFailure(await install(locked), "filesystem_error", "write_failed");
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.deepEqual(listFiles(locked), []);
});

test("a crash after the skill write never records ownership", async () => {
  const dir = project();
  const crashed = await runCli(
    ["skill", "install", "--client", "claude", "--runtime", "local", "--project", dir, "--json"],
    { offline: true, imports: [FAULTS], env: { METERGRAPH_TEST_FAULT: "kill-after-skill" } },
  );
  assert.notEqual(crashed.code, 0);
  assert.deepEqual(read(dir, PATHS.claude), SKILL);
  assert.ok(!fs.existsSync(path.join(dir, RECEIPT)), "ownership was recorded for an unfinished install");
  assert.ok(fs.existsSync(path.join(dir, LOCK)));

  // The orphaned skill is refused before the lock is even consulted.
  assertFailure(await install(dir), "conflict", "not_owned");
  // The stale lock still blocks every write until a person removes it.
  assertFailure(await install(dir, { client: "codex" }), "conflict", "locked");
  assert.ok(!fs.existsSync(path.join(dir, PATHS.codex)));
  fs.rmSync(path.join(dir, LOCK));
  assert.equal((await install(dir, { client: "codex" })).data.status, "installed");
  assertFailure(await install(dir), "conflict", "not_owned");
  assert.deepEqual(JSON.parse(read(dir, RECEIPT)).installations, [entryFor("codex", SKILL)]);
});

test("an interrupt during the write phase still finishes consistently", { skip: isWindows }, async () => {
  const dir = project();
  const result = await install(dir, { imports: [FAULTS], env: { METERGRAPH_TEST_FAULT: "signal-after-skill" } });
  assert.equal(result.ok, true);
  assert.equal(result.data.status, "installed");
  assert.deepEqual(JSON.parse(read(dir, RECEIPT)).installations, [entryFor("claude", SKILL)]);
  assertNoLeftovers(dir);
});

test("a held lock blocks writes and is not removed", async () => {
  const dir = project({ [LOCK]: "" });
  const result = await install(dir);
  assertFailure(result, "conflict", "locked");
  assert.deepEqual(listFiles(dir), [".metergraph/", LOCK]);
});
