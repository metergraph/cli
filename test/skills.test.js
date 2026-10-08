// Runs "metergraph skills" as a subprocess against real temporary project
// directories. Every run uses the offline guard, so any network attempt fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "skills", "manifest.json"), "utf8"));
const NAMES = MANIFEST.skills.map((skill) => skill.name);
const DIRS = { codex: ".agents", claude: ".claude", cursor: ".cursor" };
const MARKETPLACE_URL = "https://github.com/metergraph/skills";
const isWindows = process.platform === "win32";

const workDir = fs.mkdtempSync(path.join(tmpdir(), "metergraph skills test "));
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

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const skillPath = (client, name) => `${DIRS[client]}/skills/${name}/SKILL.md`;
const receiptPath = (name) => `.metergraph/skills/${name}.json`;
const bundled = (name) => fs.readFileSync(path.join(ROOT, "assets", "skills", name, "SKILL.md"));

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

function snapshot(dir) {
  const result = {};
  for (const relative of listFiles(dir)) {
    if (relative.endsWith("/") || relative.endsWith("@")) continue;
    const stat = fs.lstatSync(path.join(dir, relative), { bigint: true });
    result[relative] = { content: fs.readFileSync(path.join(dir, relative)).toString("base64"), ino: stat.ino, mtime: stat.mtimeNs };
  }
  return result;
}

async function skills(args, options = {}) {
  const run = await runCli(["skills", ...args, "--json"], { offline: true, ...options });
  assert.equal(run.stderr, "");
  assertNoLeak(run.stdout);
  const result = parseJsonLine(run.stdout);
  assert.equal(result.exit_code, run.code);
  return result;
}

const install = (dir, client = "claude", options) =>
  skills(["install", "--client", client, "--runtime", "local", "--project", dir], options);
const update = (dir, client = "claude") => skills(["update", "--client", client, "--runtime", "local", "--project", dir]);
const statuses = (result) => Object.fromEntries(result.data.skills.map((skill) => [skill.name, skill.status]));

test("the bundled pack excludes the setup skill and matches its manifest", () => {
  assert.equal(MANIFEST.repository, "metergraph/skills");
  assert.match(MANIFEST.commit, /^[0-9a-f]{40}$/);
  assert.ok(NAMES.includes("metergraph-model-swap"));
  assert.ok(!NAMES.includes("metergraph"));
  for (const skill of MANIFEST.skills) {
    const content = bundled(skill.name);
    assert.equal(sha256(content), skill.sha256);
    assert.equal(content.length, skill.size);
    assert.ok(content.toString("utf8").startsWith(`---\nname: ${skill.name}\ndescription: `));
  }
});

test("installs every pack skill for each client with its own receipt", async () => {
  for (const client of Object.keys(DIRS)) {
    const dir = project();
    const result = await install(dir, client);
    assert.equal(result.ok, true);
    assert.equal(result.command, "skills install");
    assert.deepEqual(result.data.source, { repository: MANIFEST.repository, commit: MANIFEST.commit });
    assert.equal(result.data.discovery, "pending");
    assert.equal(result.data.authenticated, false);
    assert.equal(result.data.next_action.kind, "reload_client");
    for (const skill of result.data.skills) {
      assert.equal(skill.status, "installed");
      assert.equal(skill.path, skillPath(client, skill.name));
      assert.deepEqual(fs.readFileSync(path.join(dir, skill.path)), bundled(skill.name));
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, receiptPath(skill.name)), "utf8"));
      assert.deepEqual(receipt, {
        schema_version: 1,
        installations: [{ client, path: skill.path, skill: skill.name, revision: skill.revision,
          sha256: sha256(bundled(skill.name)), runtimes: ["local"] }],
      });
    }
    assert.deepEqual(result.data.skills.map((skill) => skill.name), NAMES);
    // Only skill files and receipts; the setup skill receipt is not created.
    assert.ok(!fs.existsSync(path.join(dir, ".metergraph", "skill-installations.json")));
    assert.ok(!listFiles(dir).some((entry) => entry.endsWith(".lock")));
  }
});

test("an unchanged rerun of install or update writes nothing", async () => {
  const dir = project();
  await install(dir);
  const before = snapshot(dir);
  for (const run of [install, update]) {
    const result = await run(dir);
    assert.equal(result.ok, true);
    assert.ok(Object.values(statuses(result)).every((status) => status === "reused"));
    assert.deepEqual(snapshot(dir), before);
  }
});

test("the setup skill and the pack keep separate receipts", async () => {
  const dir = project();
  const core = await runCli(["skill", "install", "--client", "claude", "--runtime", "local", "--project", dir, "--json"], { offline: true });
  assert.equal(core.code, 0);
  const coreReceipt = fs.readFileSync(path.join(dir, ".metergraph", "skill-installations.json"));
  assert.equal((await install(dir)).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, ".metergraph", "skill-installations.json")), coreReceipt);
  assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "metergraph", "SKILL.md")));
});

test("update installs skills added since and replaces older owned revisions", async () => {
  const dir = project();
  await install(dir);
  const [added, older] = NAMES;
  // A skill that did not exist at the last install.
  fs.rmSync(path.dirname(path.join(dir, skillPath("claude", added))), { recursive: true });
  fs.rmSync(path.join(dir, receiptPath(added)));
  // An older revision this CLI installed and that is unchanged since.
  const old = Buffer.from(`---\nname: ${older}\ndescription: An older revision.\n---\n`);
  write(dir, skillPath("claude", older), old);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, receiptPath(older)), "utf8"));
  Object.assign(receipt.installations[0], { sha256: sha256(old), revision: `sha256-${sha256(old).slice(0, 12)}` });
  write(dir, receiptPath(older), `${JSON.stringify(receipt, null, 2)}\n`);

  const refused = await install(dir);
  assert.equal(refused.outcome, "conflict");
  assert.equal(refused.error.reason, "update_required");
  assert.equal(statuses(refused)[added], "installed");

  const result = await update(dir);
  assert.equal(result.ok, true);
  assert.equal(statuses(result)[older], "updated");
  assert.deepEqual(fs.readFileSync(path.join(dir, skillPath("claude", older))), bundled(older));
});

test("a modified skill is left alone and the other skills still install", async () => {
  const dir = project();
  await install(dir);
  const [first, ...rest] = NAMES;
  const edited = Buffer.from("edited by a person\n");
  write(dir, skillPath("claude", first), edited);
  fs.rmSync(path.join(dir, skillPath("claude", rest[0])));
  for (const run of [install, update]) {
    const result = await run(dir);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "conflict");
    assert.equal(result.exit_code, 8);
    assert.equal(result.error.reason, "modified");
    const entry = result.data.skills.find((skill) => skill.name === first);
    assert.deepEqual([entry.status, entry.reason], ["failed", "modified"]);
    assert.deepEqual(fs.readFileSync(path.join(dir, skillPath("claude", first))), edited);
    assert.deepEqual(fs.readFileSync(path.join(dir, skillPath("claude", rest[0]))), bundled(rest[0]));
  }
});

test("a skill this CLI did not install is refused, even with identical bytes", async () => {
  const name = NAMES.at(-1);
  const dir = project({ [skillPath("claude", name)]: bundled(name) });
  const result = await install(dir);
  assert.equal(result.outcome, "conflict");
  assert.equal(result.error.reason, "not_owned");
  assert.ok(!fs.existsSync(path.join(dir, receiptPath(name))));
  assert.equal(statuses(result)[NAMES[0]], "installed");
});

test("a symbolic link on the receipt path is refused without following it", { skip: isWindows }, async () => {
  const dir = project();
  const elsewhere = path.join(workDir, `elsewhere ${counter}`);
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(dir, ".metergraph"));
  fs.symlinkSync(elsewhere, path.join(dir, ".metergraph", "skills"));
  const result = await install(dir);
  assert.equal(result.outcome, "conflict");
  assert.equal(result.error.reason, "unsafe_path");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("list reports each client's state and writes nothing", async () => {
  const dir = project();
  await install(dir, "codex");
  write(dir, skillPath("codex", NAMES[0]), "edited\n");
  write(dir, skillPath("cursor", NAMES[1]), "someone else's\n");
  const before = snapshot(dir);
  const result = await skills(["list", "--project", dir]);
  assert.equal(result.ok, true);
  assert.equal(result.command, "skills list");
  assert.deepEqual(snapshot(dir), before);
  const byName = Object.fromEntries(result.data.skills.map((skill) => [skill.name, skill.installs]));
  assert.deepEqual(byName[NAMES[0]], { codex: "modified", claude: "not_installed", cursor: "not_installed" });
  assert.deepEqual(byName[NAMES[1]], { codex: "installed", claude: "not_installed", cursor: "not_owned" });

  const text = await runCli(["skills", "list", "--project", dir], { offline: true });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /changed since install; left alone/);

  const rejected = await skills(["list", "--client", "codex"]);
  assert.equal(rejected.outcome, "invalid_input");
});

test("Claude Desktop gets the plugin marketplace and nothing is written", async () => {
  const dir = project();
  const result = await skills(["install", "--client", "claude-desktop", "--runtime", "local", "--project", dir]);
  assert.equal(result.outcome, "unsupported");
  assert.equal(result.exit_code, 6);
  assert.equal(result.error.reason, "client_not_supported");
  assert.equal(result.data.next_action.kind, "plugin_marketplace");
  assert.equal(result.data.next_action.url, MARKETPLACE_URL);
  assert.match(result.data.next_action.message, /Add marketplace and enter metergraph\/skills/);
  assert.deepEqual(listFiles(dir), []);

  for (const args of [["--client", "chatgpt", "--runtime", "local"], ["--client", "claude", "--runtime", "cloud-no-shell"]]) {
    const handoff = await skills(["install", ...args, "--project", dir]);
    assert.equal(handoff.outcome, "unsupported");
    assert.equal(handoff.data.next_action.kind, "connection_guide");
  }
  assert.deepEqual(listFiles(dir), []);
});

test("tampered bundled pack assets are detected before any write", async () => {
  const variants = {
    "skill byte changed": (copy) => {
      const file = path.join(copy, "assets", "skills", NAMES[0], "SKILL.md");
      const bytes = fs.readFileSync(file);
      bytes[bytes.length - 2] ^= 1;
      fs.writeFileSync(file, bytes);
    },
    "skill and manifest changed together": (copy) => {
      const file = path.join(copy, "assets", "skills", NAMES[0], "SKILL.md");
      const bytes = Buffer.concat([fs.readFileSync(file), Buffer.from("Injected.\n")]);
      fs.writeFileSync(file, bytes);
      const manifestFile = path.join(copy, "assets", "skills", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      Object.assign(manifest.skills[0], { sha256: sha256(bytes), size: bytes.length, revision: `sha256-${sha256(bytes).slice(0, 12)}` });
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    },
    "manifest missing": (copy) => fs.rmSync(path.join(copy, "assets", "skills", "manifest.json")),
    "skill missing": (copy) => fs.rmSync(path.join(copy, "assets", "skills", NAMES[0], "SKILL.md")),
  };
  for (const [label, tamper] of Object.entries(variants)) {
    const copy = path.join(workDir, `package copy ${label}`);
    fs.mkdirSync(copy);
    for (const entry of ["bin", "src", "assets", "package.json"]) {
      fs.cpSync(path.join(ROOT, entry), path.join(copy, entry), { recursive: true });
    }
    tamper(copy);
    const dir = project();
    const result = await install(dir, "claude", { bin: path.join(copy, "bin", "metergraph.js") });
    assert.equal(result.outcome, "internal_error", label);
    assert.equal(result.error.reason, "bundled_skill_invalid", label);
    assert.equal(result.exit_code, 1);
    assert.deepEqual(listFiles(dir), [], `${label}: the project changed`);
  }
});

test("skills help works offline and names what it does not do", async () => {
  for (const args of [["help", "skills"], ["skills", "--help"]]) {
    const run = await runCli(args, { offline: true });
    assert.equal(run.code, 0);
    assert.match(run.stdout, /metergraph skills install --client CLIENT --runtime RUNTIME/);
    assert.match(run.stdout, /metergraph skills list \[--project DIR\]/);
    assert.match(run.stdout, /plugin marketplace/);
  }
  const missing = await skills([]);
  assert.equal(missing.outcome, "invalid_input");
  assert.equal(missing.error.reason, "missing_subcommand");
});
