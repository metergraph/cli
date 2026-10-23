import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import anchored, { hasVerifiedHelper } from "../src/anchored-fs.js";
import { resolveProject, writeBinding } from "../src/auth-binding.js";
import { openStore } from "../src/auth-store.js";
import { preflightEnv } from "../src/setup-env.js";
import { newSetupState, writeSetupState } from "../src/setup-state.js";
import { runSkill, runSkillPack } from "../src/skill.js";
import { waiterRecord } from "../src/setup-refusal.js";

const unsupported = !hasVerifiedHelper();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "unsupported-filesystem-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = "11111111-1111-4111-8111-111111111111";

test("an unavailable helper refuses filesystem operations without a pathname fallback", { skip: !unsupported }, () => {
  for (const operation of [
    () => anchored.mkdirSync(path.join(root, "created")),
    () => anchored.openSync(path.join(root, "token"), "wx", 0o600),
    () => anchored.unlinkSync(path.join(root, "existing")),
    () => anchored.renameSync(path.join(root, "existing"), path.join(root, "renamed")),
  ]) assert.throws(operation, { code: "ENOTSUP" });
  assert.deepEqual(fs.readdirSync(root), []);
});

test("unsupported platforms refuse install, env, state, binding and credential-store writes", { skip: !unsupported }, () => {
  const options = { action: "install", client: "codex", runtime: "local", project: root };
  for (const install of [runSkill, runSkillPack]) {
    const result = install(options);
    assert.equal(result.outcome, "unsupported");
    assert.equal(result.reason, "secure_writes_unavailable");
  }
  assert.throws(() => resolveProject(root), error => error.reason === "secure_writes_unavailable");
  const unavailable = error => error.outcome === "unsupported" && error.reason === "secure_writes_unavailable";
  assert.throws(() => preflightEnv({ project: root }), unavailable);
  assert.throws(() => openStore(path.join(root, "private"), { create: true }), unavailable);
  assert.throws(() => writeSetupState(root, newSetupState("https://api.example.com", workspace, "managed", "codex"), null), unavailable);
  assert.throws(() => writeBinding(root, { schema_version: 1, origin: "https://api.example.com",
    workspace_id: workspace, deployment_profile: "managed", credential_slot: "a".repeat(32) }, null), unavailable);
  assert.equal(waiterRecord(root, workspace).redeeming(), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("public CLI JSON names unavailable secure writes before setup or login side effects", { skip: !unsupported }, () => {
  const env = { ...process.env };
  for (const name of ["NODE_TEST_CONTEXT", "CI", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CODESPACES", "GITPOD_WORKSPACE_ID", "CLOUD_SHELL"]) delete env[name];
  env.METERGRAPH_CONFIG_DIR = path.join(root, "private");
  env.METERGRAPH_AGENT_TOKEN = "";
  env.METERGRAPH_URL = "";
  const bin = fileURLToPath(new URL("../bin/metergraph.js", import.meta.url));
  for (const command of [
    ["skill", "install", "--client", "codex"],
    ["skills", "install", "--client", "codex"],
    ["setup", "--client", "codex"],
    ["login"],
  ]) {
    const child = spawnSync(process.execPath, [bin, ...command, "--runtime", "local", "--project", root, "--json"], { env, encoding: "utf8", timeout: 10000 });
    assert.notEqual(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.outcome, "unsupported", child.stdout);
    assert.equal(result.error.reason, "secure_writes_unavailable", child.stdout);
    assert.equal(fs.readdirSync(root).length, 0);
  }
});

test("the no-helper contract also runs in an isolated package on a supported host", { skip: unsupported }, () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "missing-helper-package-"));
  try {
    for (const name of ["src", "assets", "bin", "package.json"]) {
      fs.cpSync(path.join(source, name), path.join(fixture, name), { recursive: true });
    }
    fs.mkdirSync(path.join(fixture, "test"));
    fs.copyFileSync(fileURLToPath(import.meta.url), path.join(fixture, "test", "unsupported-filesystem.test.js"));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--test", "test/unsupported-filesystem.test.js"], {
      cwd: fixture, encoding: "utf8", timeout: 15000, env,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /pass 3/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
