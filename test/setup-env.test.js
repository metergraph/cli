// The setup env writer, on real temporary projects. Repositories are created
// with git inside the test directory only, and git never reads the user's
// global or system config. No network is used. Every token is synthetic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import { Stop } from "../src/auth-store.js";
import { aclStatus } from "../src/setup-env-acl.js";
import {
  ENV_MESSAGES,
  MAX_ENV_BYTES,
  PROTECTION_KIND,
  commitEnv,
  currentEnvValues,
  isAppToken,
  parseIngestUrl,
  preflightEnv,
  rollbackEnv,
} from "../src/setup-env.js";
import { clearFault, setFault } from "./fixtures/setup-env-faults.js";

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metergraph setup env ")));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
afterEach(() => clearFault());

const emptyConfig = path.join(workDir, "empty gitconfig");
fs.writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const TOKEN = "mg_fixture_synthetic_app_token_0123456789abcdef";
const TOKEN_2 = "mg_fixture_synthetic_app_token_fedcba9876543210";
const INGEST = "https://ingest.example.com/v1/ingest";
const OTHER_SECRET = "synthetic-other-provider-value-SYNTHETIC_BODY_MARKER";
const ENV = ".env";

function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c", "user.name=Synthetic Test",
      "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false",
      "-c", "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) throw new Error(`test git ${args[0]} failed`);
  return result.stdout;
}

function gitIgnores(cwd, rel) {
  return spawnSync("git", ["check-ignore", "-q", "--no-index", "--", rel], { cwd, shell: false }).status === 0;
}

let counter = 0;
function project({ repo = false, files = {}, dirs = [] } = {}) {
  counter += 1;
  const root = path.join(workDir, `project ${counter}`);
  fs.mkdirSync(root);
  if (repo) git(root, "init", "-q");
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, { mode: 0o600 });
  }
  return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const mode = (file) => fs.statSync(file).mode & 0o777;

// No temporary files or locks are ever left behind.
function assertClean(dir) {
  for (const name of fs.readdirSync(dir)) {
    assert.ok(!name.startsWith(".metergraph-"), "a temporary file or lock was left behind");
  }
}

function assertPrivate(file) {
  if (isWindows) assert.equal(aclStatus(file), "private");
  else assert.equal(mode(file), 0o600);
}

// Public results never carry a token, other values, absolute paths or
// markers, and every Stop has a fixed message.
function assertPublic(...values) {
  for (const value of values) {
    const text = JSON.stringify(value) ?? String(value);
    for (const secret of [TOKEN, TOKEN_2, OTHER_SECRET, "SYNTHETIC", workDir, workDir.replaceAll("\\", "\\\\")]) {
      assert.ok(!text.includes(secret), "a public result contains a private value");
    }
  }
}

function stopWith(outcome, reason) {
  return (error) => {
    assert.ok(error instanceof Stop, "expected a Stop");
    assert.equal(error.outcome, outcome);
    assert.equal(error.reason, reason);
    assert.equal(error.message, reason);
    assert.ok(Object.hasOwn(ENV_MESSAGES, reason), "every reason has a fixed message");
    return true;
  };
}

test("tokens and ingest URLs are validated without echoing input", () => {
  assert.equal(isAppToken(TOKEN), true);
  for (const bad of ["short", `${TOKEN}\n`, `${TOKEN}\r`, `${TOKEN}"`, `${TOKEN} x`, `${TOKEN}#x`, `${TOKEN}$X`, "", null, 42]) {
    assert.equal(isAppToken(bad), false);
  }
  assert.equal(parseIngestUrl(INGEST), INGEST);
  assert.equal(parseIngestUrl("HTTPS://Ingest.Example.COM/v1/ingest"), INGEST);
  assert.equal(parseIngestUrl("https://ingest.example.com:8443/v1/ingest"), "https://ingest.example.com:8443/v1/ingest");
  assert.equal(parseIngestUrl("http://127.0.0.1:8080/v1/ingest"), "http://127.0.0.1:8080/v1/ingest");
  assert.equal(parseIngestUrl("http://[::1]:8080/v1/ingest"), "http://[::1]:8080/v1/ingest");
  for (const bad of [
    "http://ingest.example.com/v1/ingest",
    "https://user:hunter2@ingest.example.com/v1/ingest",
    "https://ingest.example.com/v1/ingest?token=hunter2",
    "https://ingest.example.com/v1/ingest#hunter2",
    "https://ingest.example.com/v1/ingest/",
    "https://ingest.example.com/v1/other",
    "https://ingest.example.com",
    "https://ingest.example.com/v1/ingest\nOTHER=1",
    "https://ingest.example.com/v1/ingest x",
    "javascript:alert(1)",
    "",
    null,
  ]) {
    assert.equal(parseIngestUrl(bad), null);
  }
});

test("a new env file is private, holds exactly the two values, and records the ignore rule without a repository", async () => {
  const root = project();
  const plan = preflightEnv({ project: root });
  assert.deepEqual(plan, {
    path: ".env",
    location: "project",
    exists: false,
    fields: { METERGRAPH_APP_TOKEN: "absent", METERGRAPH_INGEST_URL: "absent" },
    protection: { kind: PROTECTION_KIND, status: "will_create_private" },
    git: { status: "not_applicable", ignore_rule: "needed", verified: false },
  });
  assert.ok(Object.isFrozen(plan));
  assert.deepEqual(currentEnvValues(plan), { token: null, ingestUrl: null });

  const { receipt, rollback } = await commitEnv(plan, { token: TOKEN, ingestUrl: "HTTPS://Ingest.Example.com/v1/ingest" });
  assert.equal(read(root, ENV), `METERGRAPH_APP_TOKEN=${TOKEN}\nMETERGRAPH_INGEST_URL=${INGEST}\n`);
  assert.equal(read(root, ".gitignore"), "/.env\n");
  assert.deepEqual(receipt, {
    path: ".env",
    location: "project",
    file: "created",
    fields: { METERGRAPH_APP_TOKEN: "added", METERGRAPH_INGEST_URL: "added" },
    protection: { kind: PROTECTION_KIND, status: "created_private" },
    git: { status: "not_applicable", ignore_rule: "added", verified: false },
  });
  assertPrivate(path.join(root, ENV));
  assert.deepEqual(fs.readdirSync(root).sort(), [".env", ".gitignore"]);
  assert.equal(JSON.stringify(rollback), "{}");
  assertPublic(plan, receipt, rollback);

  // A plan is used once.
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("internal_error", "invalid_plan"));
  assert.throws(() => currentEnvValues(plan), stopWith("internal_error", "invalid_plan"));
});

test("inside a repository the rule is appended, Git confirms it, and the index and config are untouched", async () => {
  const root = project({ repo: true, files: { "README.md": "synthetic\n", ".gitignore": "# Synthetic rules\r\nnode_modules/\r\n" } });
  git(root, "add", "README.md", ".gitignore");
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  const config = fs.readFileSync(path.join(root, ".git", "config"));

  const plan = preflightEnv({ project: root });
  assert.deepEqual(plan.git, { status: "needs_ignore_rule", ignore_rule: "needed", verified: false });
  const { receipt } = await commitEnv(plan, { token: TOKEN, ingestUrl: INGEST });
  assert.deepEqual(receipt.git, { status: "ignored", ignore_rule: "added", verified: true });
  assert.equal(read(root, ".gitignore"), "# Synthetic rules\r\nnode_modules/\r\n/.env\r\n");
  assert.equal(gitIgnores(root, ENV), true);
  assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index, "the index changed");
  assert.deepEqual(fs.readFileSync(path.join(root, ".git", "config")), config, "the repository config changed");
  assert.equal(git(root, "ls-files", "--cached"), ".gitignore\nREADME.md\n");
  assertClean(root);
  assertPublic(plan, receipt);
});

test("a path Git already ignores gets no new rule", async () => {
  const root = project({ repo: true, files: { ".gitignore": ".env*\n" } });
  const plan = preflightEnv({ project: root, envFile: ".env.local" });
  assert.deepEqual(plan.git, { status: "ignored", ignore_rule: "not_needed", verified: true });
  const { receipt } = await commitEnv(plan, { token: TOKEN });
  assert.deepEqual(receipt.git, { status: "ignored", ignore_rule: "not_needed", verified: true });
  assert.equal(read(root, ".gitignore"), ".env*\n");
  assert.equal(read(root, ".env.local"), `METERGRAPH_APP_TOKEN=${TOKEN}\n`);
});

test("a negation in the same .gitignore is overridden; one in a deeper .gitignore stops and rolls back", async () => {
  const same = project({ repo: true, files: { ".gitignore": ".env\n!.env\n" } });
  const plan = preflightEnv({ project: same });
  assert.equal(plan.git.status, "needs_ignore_rule");
  await commitEnv(plan, { token: TOKEN });
  assert.equal(read(same, ".gitignore"), ".env\n!.env\n/.env\n");
  assert.equal(gitIgnores(same, ENV), true);

  const deeper = project({ repo: true, files: { "config/.gitignore": "!.env\n" } });
  const deeperPlan = preflightEnv({ project: deeper, envFile: "config/.env" });
  await assert.rejects(
    commitEnv(deeperPlan, { token: TOKEN }),
    stopWith("conflict", "git_ignore_ineffective"),
  );
  assert.equal(exists(deeper, ".gitignore"), false, "the added rule was not rolled back");
  assert.equal(exists(deeper, "config/.env"), false, "a credential was written to a path Git does not ignore");
  assert.equal(read(deeper, "config/.gitignore"), "!.env\n");
  assertClean(deeper);
  assertClean(path.join(deeper, "config"));
});

test("a tracked env file is refused even when an ignore rule matches it", async () => {
  const root = project({ repo: true, files: { ".env": "OTHER=1\n" } });
  git(root, "add", ".env");
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  assert.throws(() => preflightEnv({ project: root }), stopWith("conflict", "env_tracked"));

  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n");
  assert.throws(() => preflightEnv({ project: root }), stopWith("conflict", "env_tracked"));
  assert.equal(read(root, ".env"), "OTHER=1\n");
  assert.equal(read(root, ".gitignore"), ".env\n");
  assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index);

  // Tracked after preflight: the recheck under the lock refuses it.
  const later = project({ repo: true });
  const plan = preflightEnv({ project: later });
  fs.writeFileSync(path.join(later, ".env"), "OTHER=1\n", { mode: 0o600 });
  git(later, "add", ".env");
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("conflict", "env_changed"));
  assert.equal(exists(later, ".gitignore"), false);
});

test("an upsert keeps CRLF, comments, quotes, export and other variables byte for byte", async () => {
  const original = [
    "# Synthetic provider settings",
    `export OTHER_PROVIDER_KEY='${OTHER_SECRET}'  # keep`,
    `  METERGRAPH_APP_TOKEN = "${TOKEN}" # Metergraph`,
    'MULTI_LINE="first line',
    "# METERGRAPH_APP_TOKEN mentioned in a comment line is fine",
    'second line"',
    "",
    "PLAIN=value with spaces",
    "INTERPOLATED=${OTHER_PROVIDER_KEY}",
  ].join("\r\n") + "\r\n";
  // The comment-like line inside MULTI_LINE mentions a Metergraph name, so
  // this file must be refused; the version below without it is accepted.
  const ambiguousRoot = project({ files: { ".env": original } });
  assert.throws(() => preflightEnv({ project: ambiguousRoot }), stopWith("conflict", "env_syntax_ambiguous"));

  const accepted = original.replace("# METERGRAPH_APP_TOKEN mentioned in a comment line is fine\r\n", "");
  const root = project({ files: { ".env": `# METERGRAPH_APP_TOKEN=old commented value\r\n${accepted}` } });
  const plan = preflightEnv({ project: root });
  assert.deepEqual(plan.fields, { METERGRAPH_APP_TOKEN: "present", METERGRAPH_INGEST_URL: "absent" });
  assert.deepEqual(currentEnvValues(plan), { token: TOKEN, ingestUrl: null });
  const { receipt } = await commitEnv(plan, { token: TOKEN_2, ingestUrl: INGEST });
  const expected =
    `# METERGRAPH_APP_TOKEN=old commented value\r\n` +
    accepted.replace(`"${TOKEN}" # Metergraph`, `"${TOKEN_2}" # Metergraph`) +
    `METERGRAPH_INGEST_URL=${INGEST}\r\n`;
  assert.equal(read(root, ENV), expected);
  assert.equal(receipt.file, "updated");
  assert.deepEqual(receipt.fields, { METERGRAPH_APP_TOKEN: "updated", METERGRAPH_INGEST_URL: "added" });
  assertPublic(plan, receipt);
});

test("a byte order mark, export prefix and missing final newline are kept", async () => {
  const root = project({ files: { ".env": "\uFEFFexport METERGRAPH_INGEST_URL='https://old.example.com/v1/ingest'\nOTHER=1" } });
  const plan = preflightEnv({ project: root });
  assert.deepEqual(plan.fields, { METERGRAPH_APP_TOKEN: "absent", METERGRAPH_INGEST_URL: "present" });
  await commitEnv(plan, { token: TOKEN, ingestUrl: INGEST });
  assert.equal(
    read(root, ENV),
    `\uFEFFexport METERGRAPH_INGEST_URL='${INGEST}'\nOTHER=1\nMETERGRAPH_APP_TOKEN=${TOKEN}\n`,
  );
});

test("matching values leave the file byte for byte, and omitted values are never touched", async () => {
  const content = `METERGRAPH_APP_TOKEN=${TOKEN}\nMETERGRAPH_INGEST_URL=${INGEST}\n`;
  const root = project({ files: { ".env": content, ".gitignore": "/.env\n" } });
  const before = fs.statSync(path.join(root, ENV));
  const plan = preflightEnv({ project: root });
  assert.equal(plan.git.ignore_rule, "present");
  const { receipt } = await commitEnv(plan, { token: TOKEN, ingestUrl: INGEST });
  const now = fs.statSync(path.join(root, ENV));
  assert.equal(read(root, ENV), content);
  assert.equal(now.ino, before.ino, "the file was rewritten");
  assert.equal(now.mtimeMs, before.mtimeMs, "the file was rewritten");
  assert.equal(read(root, ".gitignore"), "/.env\n");
  assert.equal(receipt.file, "unchanged");
  assert.deepEqual(receipt.fields, { METERGRAPH_APP_TOKEN: "unchanged", METERGRAPH_INGEST_URL: "unchanged" });
  assert.deepEqual(receipt.git, { status: "not_applicable", ignore_rule: "present", verified: false });
  if (!isWindows) assert.equal(receipt.protection.status, "already_private");

  const second = preflightEnv({ project: root });
  const result = await commitEnv(second, { ingestUrl: "https://other.example.com/v1/ingest" });
  assert.equal(read(root, ENV), `METERGRAPH_APP_TOKEN=${TOKEN}\nMETERGRAPH_INGEST_URL=https://other.example.com/v1/ingest\n`);
  assert.deepEqual(result.receipt.fields, { METERGRAPH_APP_TOKEN: "unchanged", METERGRAPH_INGEST_URL: "updated" });

  // Nothing to write and no file: nothing is created.
  const empty = project();
  const noop = await commitEnv(preflightEnv({ project: empty }), {});
  assert.equal(noop.receipt.file, "absent");
  assert.deepEqual(fs.readdirSync(empty), []);
});

test("duplicate, ambiguous, binary and oversized env files are refused and left alone", () => {
  const cases = [
    ["METERGRAPH_APP_TOKEN=a\nMETERGRAPH_APP_TOKEN=b\n", "env_duplicate_assignment"],
    ["export METERGRAPH_INGEST_URL=a\nMETERGRAPH_INGEST_URL=b\n", "env_duplicate_assignment"],
    ["METERGRAPH_APP_TOKEN=$OTHER\n", "env_syntax_ambiguous"],
    ["METERGRAPH_APP_TOKEN=${OTHER}\n", "env_syntax_ambiguous"],
    ["METERGRAPH_APP_TOKEN=`printf synthetic`\n", "env_syntax_ambiguous"],
    ['METERGRAPH_APP_TOKEN="abc\n', "env_syntax_ambiguous"],
    ['METERGRAPH_APP_TOKEN="a\\"b"\n', "env_syntax_ambiguous"],
    ["METERGRAPH_APP_TOKEN=abc#def\n", "env_syntax_ambiguous"],
    ["METERGRAPH_APP_TOKEN=abc def\n", "env_syntax_ambiguous"],
    ["metergraph_app_token=abc\n", "env_syntax_ambiguous"],
    ["METERGRAPH_APP_TOKEN: abc\n", "env_syntax_ambiguous"],
    ['OTHER="start\nMETERGRAPH_APP_TOKEN=hidden\nend"\n', "env_syntax_ambiguous"],
    ['OTHER="never closed\nA=1\n', "env_syntax_ambiguous"],
    ['OTHER="closed" trailing\n', "env_syntax_ambiguous"],
    ["UNRECOGNIZED 'line\n", "env_syntax_ambiguous"],
    ["A=1\rMETERGRAPH_APP_TOKEN=x\n", "env_syntax_ambiguous"],
    [Buffer.from("A=1\0\n"), "env_file_invalid"],
    [Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a]), "env_file_invalid"],
    [`A=${"x".repeat(MAX_ENV_BYTES)}\n`, "env_too_large"],
  ];
  for (const [content, reason] of cases) {
    const root = project({ files: { ".env": content } });
    const before = fs.readFileSync(path.join(root, ENV));
    assert.throws(() => preflightEnv({ project: root }), stopWith("conflict", reason));
    assert.deepEqual(fs.readFileSync(path.join(root, ENV)), before);
    assert.deepEqual(fs.readdirSync(root), [".env"]);
  }
});

test("values that could inject lines or syntax are refused before anything is written", async () => {
  const root = project({ files: { ".env": "OTHER=1\n" } });
  const plan = preflightEnv({ project: root });
  for (const token of [`${TOKEN}\nOTHER=2`, `${TOKEN}\r`, `${TOKEN}'`, `${TOKEN}"`, `${TOKEN} #`, `${TOKEN}\u0000`, "short", 7]) {
    await assert.rejects(commitEnv(plan, { token }), stopWith("invalid_input", "token_invalid"));
  }
  for (const ingestUrl of [`${INGEST}\nOTHER=2`, "http://ingest.example.com/v1/ingest", `${INGEST}?a=1`]) {
    await assert.rejects(commitEnv(plan, { ingestUrl }), stopWith("invalid_input", "ingest_url_invalid"));
  }
  assert.equal(read(root, ENV), "OTHER=1\n");
  assert.equal(exists(root, ".gitignore"), false);
  // The plan was not used by the refused calls.
  await commitEnv(plan, { token: TOKEN });
  assert.equal(read(root, ENV), `OTHER=1\nMETERGRAPH_APP_TOKEN=${TOKEN}\n`);
});

test("unsafe, protected and non-env paths are refused with a fixed reason", () => {
  const root = project({ dirs: ["sub", ".claude", ".github", ".metergraph"] });
  const invalid = [
    "",
    "../.env",
    "sub/../.env",
    "./.env",
    "sub//.env",
    "sub/",
    ".git/.env",
    ".GIT/.env",
    "sub/.git/.env",
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "notes.txt",
    ".env.example",
    ".env.Sample",
    "sub\\.env",
    ".env\n",
    "line\nbreak/.env",
    "C:.env",
    ".env ",
    ".env.",
    ".claude/.env",
    ".metergraph/.env",
    ".github/.env",
    "nul/.env",
    "GIT~1/.env",
    "a*b/.env",
    "a?b/.env",
    `${"x".repeat(300)}.env`,
    42,
  ];
  for (const envFile of invalid) {
    assert.throws(() => preflightEnv({ project: root, envFile }), stopWith("invalid_input", "env_path_invalid"));
  }
  assert.throws(() => preflightEnv({ project: root, envFile: "missing/.env" }), stopWith("invalid_input", "env_dir_missing"));
  assert.throws(
    () => preflightEnv({ project: root, envFile: path.join(workDir, "elsewhere.env") }),
    stopWith("invalid_input", "env_path_outside_project"),
  );
  assert.throws(
    () => preflightEnv({ project: root, envFile: path.join(root, "sub", ".env"), allowOutsideProject: true }),
    stopWith("invalid_input", "env_path_invalid"),
  );
  assert.throws(
    () => preflightEnv({ project: path.join(root, "no such dir") }),
    stopWith("invalid_input", "invalid_project"),
  );
  assert.deepEqual(fs.readdirSync(root).sort(), [".claude", ".github", ".metergraph", "sub"]);
});

test("names with spaces, a leading dash and ignore pattern characters get a literal rule Git honors", async () => {
  const dir = "-lead dash [x] !neg #hash";
  const root = project({ repo: true, dirs: [dir] });
  const rel = `${dir}/.env.local`;
  // A sibling the rule must not match by accident.
  fs.mkdirSync(path.join(root, "-lead dash x !neg #hash"));
  const plan = preflightEnv({ project: root, envFile: rel });
  assert.equal(plan.path, rel);
  const { receipt } = await commitEnv(plan, { token: TOKEN });
  assert.deepEqual(receipt.git, { status: "ignored", ignore_rule: "added", verified: true });
  assert.equal(read(root, ".gitignore"), "/-lead dash \\[x\\] \\!neg \\#hash/.env.local\n");
  assert.equal(gitIgnores(root, rel), true);
  assert.equal(gitIgnores(root, "-lead dash x !neg #hash/.env.local"), false);
  assertPrivate(path.join(root, rel));
});

test("symbolic links, hard links and unsafe ignore files are refused and never followed", { skip: isWindows }, async () => {
  const outside = path.join(workDir, `outside ${counter}.env`);
  fs.writeFileSync(outside, "OTHER=1\n", { mode: 0o600 });

  const linked = project();
  fs.symlinkSync(outside, path.join(linked, ENV));
  assert.throws(() => preflightEnv({ project: linked }), stopWith("conflict", "env_path_unsafe"));

  const linkedDir = project();
  fs.symlinkSync(workDir, path.join(linkedDir, "config"), "dir");
  assert.throws(() => preflightEnv({ project: linkedDir, envFile: "config/.env" }), stopWith("conflict", "env_path_unsafe"));

  const hard = project();
  fs.linkSync(outside, path.join(hard, ENV));
  assert.throws(() => preflightEnv({ project: hard }), stopWith("conflict", "env_path_unsafe"));

  const ignoreLink = project();
  const ignoreTarget = path.join(workDir, `ignore target ${counter}`);
  fs.writeFileSync(ignoreTarget, "# synthetic\n");
  fs.symlinkSync(ignoreTarget, path.join(ignoreLink, ".gitignore"));
  assert.throws(() => preflightEnv({ project: ignoreLink }), stopWith("conflict", "ignore_path_unsafe"));

  // Swapped for a link between preflight and commit.
  const swapped = project({ files: { ".env": "OTHER=1\n" } });
  const plan = preflightEnv({ project: swapped });
  fs.rmSync(path.join(swapped, ENV));
  fs.symlinkSync(outside, path.join(swapped, ENV));
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("conflict", "env_path_unsafe"));

  assert.equal(fs.readFileSync(outside, "utf8"), "OTHER=1\n");
  assert.equal(fs.readFileSync(ignoreTarget, "utf8"), "# synthetic\n");
});

test("a readable env file is tightened to 0600 and a rollback restores its mode and content", { skip: isWindows || isRoot }, async () => {
  const content = `OTHER=${OTHER_SECRET}\n`;
  const root = project({ files: { ".env": content } });
  const file = path.join(root, ENV);
  fs.chmodSync(file, 0o644);
  const plan = preflightEnv({ project: root });
  assert.deepEqual(plan.protection, { kind: "posix_mode", status: "needs_tightening" });
  const { receipt, rollback } = await commitEnv(plan, { token: TOKEN });
  assert.equal(receipt.protection.status, "tightened");
  assert.equal(mode(file), 0o600);
  assert.deepEqual(await rollbackEnv(rollback), { status: "restored" });
  assert.equal(read(root, ENV), content);
  assert.equal(mode(file), 0o644);
  assert.equal(exists(root, ".gitignore"), false);
  await assert.rejects(rollbackEnv(rollback), stopWith("internal_error", "invalid_plan"));

  // Values already match: only the mode changes, and rollback restores it.
  const same = project({ files: { ".env": `METERGRAPH_APP_TOKEN=${TOKEN}\n`, ".gitignore": "/.env\n" } });
  const sameFile = path.join(same, ENV);
  fs.chmodSync(sameFile, 0o640);
  const samePlan = preflightEnv({ project: same });
  const result = await commitEnv(samePlan, { token: TOKEN });
  assert.equal(result.receipt.file, "unchanged");
  assert.equal(result.receipt.protection.status, "tightened");
  assert.equal(mode(sameFile), 0o600);
  await rollbackEnv(result.rollback);
  assert.equal(mode(sameFile), 0o640);
  assert.equal(read(same, ENV), `METERGRAPH_APP_TOKEN=${TOKEN}\n`);

  // A world-writable directory without the sticky bit is refused.
  const shared = project({ dirs: ["shared"] });
  fs.chmodSync(path.join(shared, "shared"), 0o777);
  assert.throws(() => preflightEnv({ project: shared, envFile: "shared/.env" }), stopWith("conflict", "env_dir_unsafe"));
  assert.deepEqual(fs.readdirSync(path.join(shared, "shared")), []);
});

test("an edit between preflight and commit is never overwritten", async () => {
  const root = project({ files: { ".env": "OTHER=1\n" } });
  const plan = preflightEnv({ project: root });
  fs.appendFileSync(path.join(root, ENV), "EDITED=1\n");
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("conflict", "env_changed"));
  assert.equal(read(root, ENV), "OTHER=1\nEDITED=1\n");
  assert.equal(exists(root, ".gitignore"), false);

  const ignore = project({ files: { ".gitignore": "node_modules/\n" } });
  const ignorePlan = preflightEnv({ project: ignore });
  fs.appendFileSync(path.join(ignore, ".gitignore"), "dist/\n");
  await assert.rejects(commitEnv(ignorePlan, { token: TOKEN }), stopWith("conflict", "ignore_changed"));
  assert.equal(read(ignore, ".gitignore"), "node_modules/\ndist/\n");
  assert.equal(exists(ignore, ENV), false);
  assertClean(ignore);
});

test("an edit during the write is detected before the rename and nothing is replaced", async () => {
  const root = project({ files: { ".env": "OTHER=1\n", ".gitignore": "/.env\n" } });
  const plan = preflightEnv({ project: root });
  setFault("edit-during-commit", { file: path.join(root, ENV) });
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("conflict", "env_changed"));
  assert.equal(read(root, ENV), "OTHER=1\nSYNTHETIC_CONCURRENT_EDIT=1\n");
  assert.equal(read(root, ".gitignore"), "/.env\n");
  assertClean(root);
});

test("a held lock is waited on, then reported, and never removed; a cancel signal stops the wait", async () => {
  const root = project();
  const lock = path.join(root, ".metergraph-env.lock");
  fs.writeFileSync(lock, "held by another process");
  const plan = preflightEnv({ project: root });
  await assert.rejects(commitEnv(plan, { token: TOKEN, waitMs: 100 }), stopWith("conflict", "env_locked"));
  assert.equal(fs.readFileSync(lock, "utf8"), "held by another process");
  assert.equal(exists(root, ENV), false);

  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  const second = preflightEnv({ project: root });
  await assert.rejects(
    commitEnv(second, { token: TOKEN, waitMs: 20000, signal: controller.signal }),
    stopWith("cancelled", "cancelled"),
  );
  assert.ok(Date.now() - started < 2000, "the wait ignored the cancel signal");
  assert.equal(fs.readFileSync(lock, "utf8"), "held by another process");

  // Already cancelled: nothing is read or written, and the plan stays usable.
  assert.throws(() => preflightEnv({ project: root, signal: AbortSignal.abort() }), stopWith("cancelled", "cancelled"));
  fs.unlinkSync(lock);
  const third = preflightEnv({ project: root });
  await assert.rejects(commitEnv(third, { token: TOKEN, signal: AbortSignal.abort() }), stopWith("cancelled", "cancelled"));
  assert.deepEqual(fs.readdirSync(root), []);
  await commitEnv(third, { token: TOKEN });
  assert.equal(read(root, ENV), `METERGRAPH_APP_TOKEN=${TOKEN}\n`);
  assertClean(root);
});

test("a failed env write rolls back the ignore rule and leaves no temporary file", async () => {
  for (const [fault, reason] of [["env-rename-denied", "env_write_denied"], ["env-rename-readonly", "env_write_denied"]]) {
    const root = project({ files: { ".gitignore": "node_modules/\n" } });
    const plan = preflightEnv({ project: root });
    setFault(fault);
    await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("filesystem_error", reason));
    clearFault();
    assert.equal(read(root, ".gitignore"), "node_modules/\n");
    assert.equal(exists(root, ENV), false);
    assertClean(root);
  }

  const existing = project({ files: { ".env": `OTHER=${OTHER_SECRET}\n`, ".gitignore": "/.env\n" } });
  const plan = preflightEnv({ project: existing });
  setFault("env-rename-denied");
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("filesystem_error", "env_write_denied"));
  assert.equal(read(existing, ENV), `OTHER=${OTHER_SECRET}\n`);
  assertClean(existing);

  const ignoreFails = project();
  const ignorePlan = preflightEnv({ project: ignoreFails });
  setFault("ignore-rename");
  await assert.rejects(commitEnv(ignorePlan, { token: TOKEN }), stopWith("filesystem_error", "env_write_denied"));
  assert.deepEqual(fs.readdirSync(ignoreFails), []);
});

test("a rollback that cannot finish is reported, not called success", async () => {
  const root = project();
  const plan = preflightEnv({ project: root });
  setFault("rollback-blocked");
  await assert.rejects(commitEnv(plan, { token: TOKEN }), stopWith("filesystem_error", "rollback_incomplete"));
  clearFault();
  assert.equal(exists(root, ENV), false, "no credential was written");
  assert.equal(read(root, ".gitignore"), "/.env\n", "the rule that could not be removed is still there");
  assertClean(root);
});

test("rollback restores both files, but keeps a concurrent edit and its ignore rule", async () => {
  const root = project({ repo: true, files: { ".env": "OTHER=1\n" } });
  const { rollback } = await commitEnv(preflightEnv({ project: root }), { token: TOKEN, ingestUrl: INGEST });
  assert.equal(gitIgnores(root, ENV), true);
  await rollbackEnv(rollback);
  assert.equal(read(root, ENV), "OTHER=1\n");
  assert.equal(exists(root, ".gitignore"), false);

  const edited = project({ files: { ".gitignore": "# synthetic\n" } });
  const result = await commitEnv(preflightEnv({ project: edited }), { token: TOKEN });
  fs.appendFileSync(path.join(edited, ENV), "EDITED=1\n");
  await assert.rejects(rollbackEnv(result.rollback), stopWith("conflict", "rollback_conflict"));
  assert.equal(read(edited, ENV), `METERGRAPH_APP_TOKEN=${TOKEN}\nEDITED=1\n`);
  assert.equal(read(edited, ".gitignore"), "# synthetic\n/.env\n", "the ignore rule was removed from a file that still holds a token");
  assertClean(edited);
});

test("a private path outside the project is written without claiming any Git check", async () => {
  const root = project({ repo: true });
  const privateDir = path.join(workDir, `private config ${counter}`);
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const plan = preflightEnv({ project: root, envFile: path.join(privateDir, "metergraph.env"), allowOutsideProject: true });
  assert.equal(plan.path, null);
  assert.equal(plan.location, "outside_project");
  assert.deepEqual(plan.git, { status: "outside_project", ignore_rule: null, verified: false });
  const { receipt } = await commitEnv(plan, { token: TOKEN, ingestUrl: INGEST });
  assert.equal(receipt.location, "outside_project");
  assert.deepEqual(receipt.git, { status: "outside_project", ignore_rule: null, verified: false });
  assert.equal(fs.readFileSync(path.join(privateDir, "metergraph.env"), "utf8"), `METERGRAPH_APP_TOKEN=${TOKEN}\nMETERGRAPH_INGEST_URL=${INGEST}\n`);
  assertPrivate(path.join(privateDir, "metergraph.env"));
  assert.equal(exists(root, ".gitignore"), false);
  assertClean(privateDir);
  assertPublic(plan, receipt);
});

test("on Windows the env file gets a protected DACL for the current user, SYSTEM and Administrators", { skip: !isWindows }, async () => {
  const root = project({ files: { ".env": "OTHER=1\n" } });
  const file = path.join(root, ENV);
  assert.equal(aclStatus(file), "open");
  const plan = preflightEnv({ project: root });
  assert.deepEqual(plan.protection, { kind: "windows_acl", status: "needs_protection" });
  const { receipt, rollback } = await commitEnv(plan, { token: TOKEN });
  assert.equal(receipt.protection.status, "protected");
  assert.equal(aclStatus(file), "private");

  // An independent look at the DACL: protected, and only the allowed SIDs.
  const script = [
    "$acl = Get-Acl -LiteralPath $env:SYNTHETIC_ACL_PATH",
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$sids = $acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }",
    "[Console]::Out.Write(($acl.AreAccessRulesProtected, $me, ($sids -join ',')) -join ';')",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, SYNTHETIC_ACL_PATH: file },
  });
  const [isProtected, me, sids] = result.stdout.trim().split(";");
  assert.equal(isProtected, "True");
  const allowed = new Set([me, "S-1-5-18", "S-1-5-32-544"]);
  for (const sid of sids.split(",")) assert.ok(allowed.has(sid), "another principal can access the env file");
  assert.ok(sids.split(",").includes(me));

  await rollbackEnv(rollback);
  assert.equal(read(root, ENV), "OTHER=1\n");
  assert.equal(aclStatus(file), "open", "the original ACL was not restored");

  const fresh = project();
  await commitEnv(preflightEnv({ project: fresh }), { token: TOKEN });
  assert.equal(aclStatus(path.join(fresh, ENV)), "private");
});

test("fixed messages contain no em dash and name no value", () => {
  for (const message of Object.values(ENV_MESSAGES)) {
    assert.ok(!message.includes("\u2014"));
    assert.ok(!/mg_|example\.com/.test(message));
  }
});
