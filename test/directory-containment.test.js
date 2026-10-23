import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import anchoredFs from "../src/anchored-fs.js";
import { runSkill } from "../src/skill.js";
import { commitEnv, preflightEnv, rollbackEnv } from "../src/setup-env.js";
import { bindingFor, readBinding, resolveProject, writeBinding } from "../src/auth-binding.js";
import { newSetupState, readSetupState, writeSetupState } from "../src/setup-state.js";
import { newSlot, openStore, writeCredential } from "../src/auth-store.js";
import { waiterRecord } from "../src/setup-refusal.js";

const supported = process.platform === "darwin" && process.arch === "arm64";
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "directory containment ")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
let counter = 0;
function box() {
  const base = path.join(work, String(++counter));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel"), "unchanged");
  return { root, outside, base };
}
function swap(dir, outside) {
  fs.renameSync(dir, `${dir}.held`);
  fs.symlinkSync(outside, dir, "dir");
}
function assertOutside(outside) {
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
}

for (const phase of ["before-lock", "before-temp", "after-skill", "after-receipt"]) {
  test(`skill ancestor substitution ${phase} cannot redirect writes or rollback`, { skip: !supported }, () => {
    const { root, outside } = box();
    fs.mkdirSync(path.join(root, ".metergraph"));
    fs.mkdirSync(path.join(root, ".agents"));
    const originalOpen = anchoredFs.openSync;
    const originalRename = anchoredFs.renameSync;
    let swapped = false;
    const maybeSwap = () => { if (!swapped) { swapped = true; swap(root, outside); } };
    anchoredFs.openSync = (file, flags, mode) => {
      if (phase === "before-lock" && String(file).endsWith("skill-installations.lock")) maybeSwap();
      if (phase === "before-temp" && String(file).endsWith(".tmp")) maybeSwap();
      return originalOpen(file, flags, mode);
    };
    anchoredFs.renameSync = (from, to) => {
      const result = originalRename(from, to);
      if (phase === "after-skill" && String(to).endsWith("SKILL.md")) maybeSwap();
      if (phase === "after-receipt" && String(to).endsWith("skill-installations.json")) maybeSwap();
      return result;
    };
    let result;
    try { result = runSkill({ action: "install", client: "codex", runtime: "local", project: root }); }
    finally { anchoredFs.openSync = originalOpen; anchoredFs.renameSync = originalRename; }
    assert.equal(swapped, true);
    assert.notEqual(result.outcome, "ok");
    assertOutside(outside);
    assert.equal(fs.existsSync(path.join(`${root}.held`, ".agents/skills/metergraph/SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(`${root}.held`, ".metergraph/skill-installations.json")), false);
  });
}

test("env parent substitution after preflight refuses token creation", { skip: !supported }, async () => {
  const { root, outside } = box();
  const plan = preflightEnv({ project: root });
  swap(root, outside);
  await assert.rejects(commitEnv(plan, { token: "mg_fixture_synthetic_app_token_0123456789abcdef" }));
  assertOutside(outside);
  assert.equal(fs.existsSync(path.join(`${root}.held`, ".env")), false);
});

test("rollback stays on pinned directory when project is substituted after commit", { skip: !supported }, async () => {
  const { root, outside } = box();
  const result = await commitEnv(preflightEnv({ project: root }), {
    token: "mg_fixture_synthetic_app_token_0123456789abcdef",
  });
  swap(root, outside);
  await rollbackEnv(result.rollback);
  assertOutside(outside);
  assert.deepEqual(fs.readdirSync(`${root}.held`), []);
});

test("legitimate install remains idempotent", { skip: !supported }, () => {
  const { root, outside } = box();
  const options = { action: "install", client: "codex", runtime: "local", project: root };
  assert.equal(runSkill(options).outcome, "ok");
  const file = path.join(root, ".agents/skills/metergraph/SKILL.md");
  const before = fs.statSync(file, { bigint: true });
  assert.equal(runSkill(options).outcome, "ok");
  assert.equal(fs.statSync(file, { bigint: true }).ino, before.ino);
  assertOutside(outside);
});

for (const boundary of ["binding", "setup-state", "refusal"]) {
  test(`${boundary} cannot write through a substituted metadata directory`, { skip: !supported }, () => {
    const { root, outside } = box();
    const meta = path.join(root, ".metergraph");
    fs.mkdirSync(meta);
    resolveProject(root);
    readBinding(root);
    readSetupState(root);
    const waiter = waiterRecord(root, "11111111-1111-4111-8111-111111111111");
    swap(meta, outside);
    if (boundary === "binding") {
      const binding = bindingFor({ origin: "https://api.example.com", workspaceId: "11111111-1111-4111-8111-111111111111", profile: "managed", slot: "a".repeat(32) });
      assert.throws(() => writeBinding(root, binding, null));
    } else if (boundary === "setup-state") {
      const state = newSetupState("https://api.example.com", "11111111-1111-4111-8111-111111111111", "managed", "codex");
      assert.throws(() => writeSetupState(root, state, null));
    } else assert.equal(waiter.redeeming(), false);
    assertOutside(outside);
    assert.deepEqual(fs.readdirSync(`${meta}.held`), []);
  });
}

for (const replacement of ["symlink", "directory"]) test(`private store ${replacement} substitution cannot redirect credential bytes`, { skip: !supported }, () => {
  const { root, outside } = box();
  const store = openStore(path.join(root, "private"), { create: true });
  if (replacement === "symlink") swap(store.credentials, outside);
  else {
    fs.renameSync(store.credentials, `${store.credentials}.held`);
    fs.renameSync(outside, store.credentials);
  }
  const origin = "https://api.example.com";
  const credential = { schema_version: 1, origin, issuer: `${origin}/v1/oauth`, resource: `${origin}/v1/agent/mcp`,
    deployment_profile: "managed", workspace_id: "11111111-1111-4111-8111-111111111111", client_id: "synthetic-client",
    scope: "agent:metadata", access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token",
    expires_at: Date.now() + 3600000, refresh_pending: false };
  assert.throws(() => writeCredential(store, newSlot(), credential));
  assertOutside(replacement === "symlink" ? outside : store.credentials);
  assert.deepEqual(fs.readdirSync(`${store.credentials}.held`), []);
});
