import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  CONFIG_PATH,
  ensureRepositoryIdentity,
  envRepository,
  parseRepository,
  repositoryFromRemote,
} from "../src/repository-identity.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph repository identity test "));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
// Stop git and the walk from seeing a repository that holds the temp dir.
process.env.GIT_CEILING_DIRECTORIES = dir;
let count = 0;

// An empty global config: Git for Windows cannot read os.devNull as one.
const GIT_CONFIG = path.join(dir, "gitconfig");
fs.writeFileSync(GIT_CONFIG, "");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

// A fresh git repository with the given remotes ({ name: url }).
function repo(remotes = {}) {
  const root = path.join(dir, `repo-${count += 1}`);
  fs.mkdirSync(root);
  git(root, "init", "-q");
  for (const [name, url] of Object.entries(remotes)) git(root, "remote", "add", name, url);
  return root;
}

const readConfig = (root) => JSON.parse(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8"));

test("owner/name is parsed from https, ssh and scp-style remotes", () => {
  for (const url of [
    "https://example.com/example-org/example-app.git",
    "https://example.com/example-org/example-app",
    "https://example.com/example-org/example-app/",
    "ssh://git@example.com/example-org/example-app.git",
    "ssh://git@example.com:2222/example-org/example-app.git",
    "git@example.com:example-org/example-app.git",
    "git://example.com/example-org/example-app.git",
    "https://example.com/example-org/example-app.GIT",
  ]) {
    assert.equal(repositoryFromRemote(url), "example-org/example-app", url);
  }
});

test("nested groups, local paths and odd segments are not guessed", () => {
  for (const url of [
    "https://example.com/group/subgroup/example-app.git",
    "/srv/git/example-app.git",
    "file:///srv/git/example-org/example-app.git",
    "https://example.com/example-app.git",
    "https://example.com/../example-app.git",
    "",
    null,
  ]) {
    assert.equal(repositoryFromRemote(url), null, String(url));
  }
  assert.equal(parseRepository("example-org/example-app"), "example-org/example-app");
  for (const value of ["example-app", "a/b/c", "a b/c", "../x", "owner/", "/name"]) {
    assert.equal(parseRepository(value), null, value);
  }
});

test("a remote URL with credentials yields only owner/name", () => {
  const secret = "s3cret-token-value";
  const parsed = repositoryFromRemote(`https://user:${secret}@example.com/example-org/example-app.git`);
  assert.equal(parsed, "example-org/example-app");
  const root = repo({ origin: `https://user:${secret}@example.com/example-org/example-app.git` });
  const result = ensureRepositoryIdentity(root);
  assert.equal(result.status, "written");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!fs.readFileSync(path.join(root, CONFIG_PATH), "utf8").includes(secret));
});

test("the origin remote is recorded once as a committed config", () => {
  const root = repo({ origin: "git@example.com:example-org/example-app.git" });
  const first = ensureRepositoryIdentity(root);
  assert.deepEqual(first, { status: "written", repository: "example-org/example-app", source: "git_remote",
    path: ".metergraph/config.json", reason: null });
  assert.deepEqual(readConfig(root), { version: 2, repository: "example-org/example-app" });
  const before = fs.readFileSync(path.join(root, CONFIG_PATH));
  const second = ensureRepositoryIdentity(root);
  assert.equal(second.status, "existing");
  assert.equal(second.source, "config");
  assert.ok(fs.readFileSync(path.join(root, CONFIG_PATH)).equals(before));
});

test("an existing identity that differs from the remote is reported, not overwritten", () => {
  const root = repo({ origin: "https://example.com/example-org/new-name.git" });
  fs.mkdirSync(path.join(root, ".metergraph"));
  const original = `${JSON.stringify({ version: 2, repository: "example-org/old-name", extra: true })}\n`;
  fs.writeFileSync(path.join(root, CONFIG_PATH), original);
  const result = ensureRepositoryIdentity(root);
  assert.equal(result.status, "mismatch");
  assert.equal(result.repository, "example-org/old-name");
  assert.equal(result.expected, "example-org/new-name");
  assert.equal(result.reason, "git_remote_differs");
  assert.equal(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8"), original);
});

test("identity comparison ignores case, as the service does", () => {
  const root = repo({ origin: "https://example.com/Example-Org/Example-App.git" });
  fs.mkdirSync(path.join(root, ".metergraph"));
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify({ repository: "example-org/example-app" }));
  assert.equal(ensureRepositoryIdentity(root).status, "existing");
});

test("--repository is recorded when none exists and reported when one differs", () => {
  const fresh = repo();
  const written = ensureRepositoryIdentity(fresh, { requested: "example-org/example-app" });
  assert.equal(written.status, "written");
  assert.equal(written.source, "flag");
  assert.equal(readConfig(fresh).repository, "example-org/example-app");
  const differs = ensureRepositoryIdentity(fresh, { requested: "example-org/other-app" });
  assert.equal(differs.status, "mismatch");
  assert.equal(differs.reason, "flag_differs");
  assert.equal(readConfig(fresh).repository, "example-org/example-app");
});

test("an identity in the env file is respected and no config is written", () => {
  const root = repo({ origin: "https://example.com/example-org/example-app.git" });
  fs.writeFileSync(path.join(root, ".env"), "OTHER=1\nexport METERGRAPH_REPOSITORY=\"example-org/env-app\" \n");
  const value = envRepository(root, ".env");
  assert.equal(value, "example-org/env-app");
  const result = ensureRepositoryIdentity(root, { envValue: value });
  assert.equal(result.status, "mismatch");
  assert.equal(result.source, "env_file");
  assert.equal(result.repository, "example-org/env-app");
  assert.ok(!fs.existsSync(path.join(root, CONFIG_PATH)));
  assert.equal(envRepository(root, "missing.env"), null);
});

test("an ancestor config is found as the SDK finds it", () => {
  const root = repo({ origin: "https://example.com/example-org/monorepo.git" });
  fs.mkdirSync(path.join(root, ".metergraph"));
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify({ version: 2, repository: "example-org/monorepo" }));
  const pkg = path.join(root, "packages", "api");
  fs.mkdirSync(pkg, { recursive: true });
  const result = ensureRepositoryIdentity(pkg);
  assert.equal(result.status, "existing");
  assert.equal(result.path, "../../.metergraph/config.json");
  assert.ok(!fs.existsSync(path.join(pkg, CONFIG_PATH)));
});

test("an unusable config is never rewritten", () => {
  for (const content of ["not json", JSON.stringify({ version: 1, repository: "example-org/example-app" }),
    JSON.stringify({ environment: "staging" }), JSON.stringify(["example-org/example-app"])]) {
    const root = repo({ origin: "https://example.com/example-org/example-app.git" });
    fs.mkdirSync(path.join(root, ".metergraph"));
    fs.writeFileSync(path.join(root, CONFIG_PATH), content);
    const result = ensureRepositoryIdentity(root);
    assert.equal(result.status, "invalid_config", content);
    assert.equal(result.expected, "example-org/example-app");
    assert.equal(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8"), content);
  }
});

test("without a usable remote nothing is written and the reason is given", () => {
  const plain = path.join(dir, "not-a-repository");
  fs.mkdirSync(plain);
  assert.deepEqual(ensureRepositoryIdentity(plain), { status: "not_inferred", repository: null, source: null,
    path: null, reason: "not_a_git_repository" });
  assert.equal(ensureRepositoryIdentity(repo()).reason, "no_remote");
  assert.equal(ensureRepositoryIdentity(repo({ upstream: "https://example.com/a/b.git",
    fork: "https://example.com/c/d.git" })).reason, "remote_ambiguous");
  assert.equal(ensureRepositoryIdentity(repo({ origin: "https://example.com/a/b/c.git" })).reason,
    "remote_unrecognized");
  const single = repo({ upstream: "https://example.com/example-org/example-app.git" });
  assert.equal(ensureRepositoryIdentity(single).repository, "example-org/example-app");
  assert.ok(!fs.existsSync(path.join(plain, CONFIG_PATH)));
});

test("--no-repository changes nothing", () => {
  const root = repo({ origin: "https://example.com/example-org/example-app.git" });
  assert.equal(ensureRepositoryIdentity(root, { skip: true }).status, "skipped");
  assert.ok(!fs.existsSync(path.join(root, ".metergraph")));
});


test("a FIFO named config.json is never opened", { skip: process.platform === "win32" }, () => {
  const parent = path.join(dir, "fifo-parent");
  fs.mkdirSync(path.join(parent, ".metergraph"), { recursive: true });
  const made = spawnSync("mkfifo", [path.join(parent, CONFIG_PATH)]);
  if (made.status !== 0) return;
  const project = path.join(parent, "project");
  fs.mkdirSync(project);
  const result = ensureRepositoryIdentity(project, { requested: "example-org/example-app" });
  assert.equal(result.status, "invalid_config");
});

test("an env value is never echoed unless it is a plain owner/name", () => {
  const root = repo();
  fs.writeFileSync(path.join(root, ".env"),
    "METERGRAPH_REPOSITORY=https://user:tok123@example.com/o/r\x1b[31m\n");
  const value = envRepository(root, ".env");
  const result = ensureRepositoryIdentity(root, { envValue: value });
  assert.equal(result.status, "existing");
  assert.equal(result.repository, null);
  assert.equal(result.reason, "env_value_unrecognized");
  assert.ok(!JSON.stringify(result).includes("tok123"));
  assert.ok(!fs.existsSync(path.join(root, CONFIG_PATH)));
  fs.writeFileSync(path.join(root, ".env"), 'METERGRAPH_REPOSITORY="example-org/example-app" # note\n');
  assert.equal(envRepository(root, ".env"), "example-org/example-app");
});

test("a config value the SDK accepts is kept even when it is not owner/name", () => {
  const root = repo({ origin: "https://example.com/example-org/example-app.git" });
  fs.mkdirSync(path.join(root, ".metergraph"));
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify({ repository: "group/sub/app" }));
  const result = ensureRepositoryIdentity(root);
  assert.equal(result.status, "existing");
  assert.equal(result.repository, null);
  assert.equal(result.reason, "config_value_unrecognized");
});

test("a failed write leaves no partial config and no temporary file", () => {
  const root = repo({ origin: "https://example.com/example-org/example-app.git" });
  fs.writeFileSync(path.join(root, ".metergraph"), "not a directory");
  const result = ensureRepositoryIdentity(root);
  assert.equal(result.status, "write_failed");
  assert.equal(fs.readFileSync(path.join(root, ".metergraph"), "utf8"), "not a directory");
});
