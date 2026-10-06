// The private credential store, on real temporary directories. Nothing here
// touches the user's real config directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  PROTECTION,
  Stop,
  deleteCredential,
  dpapi,
  newSlot,
  openStore,
  readCredential,
  resolveConfigDir,
  withSlotLock,
  writeCredential,
} from "../src/auth-store.js";
import { WORKSPACE_A } from "./fixtures/oauth-server.js";

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph store test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const ACCESS = "synthetic-access-token-SYNTHETIC_BODY_MARKER-0001";
const REFRESH = "synthetic-refresh-token-SYNTHETIC_BODY_MARKER-0001";

let counter = 0;
function freshDir() {
  counter += 1;
  return path.join(workDir, `config ${counter}`);
}

function record(overrides = {}) {
  const origin = "http://127.0.0.1:4000";
  return {
    schema_version: 1,
    origin,
    issuer: `${origin}/v1/oauth`,
    resource: `${origin}/v1/agent/mcp`,
    deployment_profile: "local",
    workspace_id: WORKSPACE_A,
    client_id: "client-synthetic",
    scope: "agent:metadata",
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_at: Date.now() + 3600 * 1000,
    refresh_pending: false,
    ...overrides,
  };
}

function stopWith(outcome, reason) {
  return (error) => error instanceof Stop && error.outcome === outcome && error.reason === reason;
}

const mode = (file) => fs.statSync(file).mode & 0o777;

test("a new store and grant are owner-only and round trip exactly", () => {
  const dir = freshDir();
  assert.equal(openStore(dir, { create: false }), null);
  assert.equal(fs.existsSync(dir), false, "opening without create must not create anything");
  const store = openStore(dir, { create: true });
  const slot = newSlot();
  assert.match(slot, /^[0-9a-f]{32}$/);
  const saved = record();
  writeCredential(store, slot, saved);
  assert.deepEqual(readCredential(store, slot), saved);
  assert.deepEqual(fs.readdirSync(store.credentials), [`${slot}.json`], "no temporary files are left");
  if (!isWindows) {
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(store.credentials), 0o700);
    assert.equal(mode(path.join(store.credentials, `${slot}.json`)), 0o600);
    assert.equal(PROTECTION, "owner_only_file");
  }
  assert.equal(deleteCredential(store, slot), true);
  assert.equal(deleteCredential(store, slot), false);
  assert.equal(readCredential(store, slot), null);
});

test("on Windows the grant is encrypted with DPAPI for the current user", { skip: !isWindows }, () => {
  assert.equal(PROTECTION, "dpapi");
  const secret = Buffer.from("synthetic DPAPI round trip SYNTHETIC_BODY_MARKER");
  const blob = dpapi("protect", secret);
  assert.ok(!blob.equals(secret));
  assert.ok(!blob.toString("latin1").includes("SYNTHETIC_BODY_MARKER"));
  assert.deepEqual(dpapi("unprotect", blob), secret);

  const store = openStore(freshDir(), { create: true });
  const slot = newSlot();
  writeCredential(store, slot, record());
  const raw = fs.readFileSync(path.join(store.credentials, `${slot}.json`), "utf8");
  assert.ok(!raw.includes(ACCESS) && !raw.includes(REFRESH) && !raw.includes("SYNTHETIC_BODY_MARKER"));
  assert.equal(JSON.parse(raw).protection, "dpapi");
  assert.equal(readCredential(store, slot).refresh_token, REFRESH);

  // A blob that is not valid DPAPI output for this user is unreadable, not guessed at.
  const wrapper = JSON.parse(raw);
  wrapper.credential = Buffer.from("not a dpapi blob").toString("base64");
  fs.writeFileSync(path.join(store.credentials, `${slot}.json`), JSON.stringify(wrapper));
  assert.throws(() => readCredential(store, slot), (error) => error instanceof Stop);
});

test("existing directories and files with unsafe permissions are refused, not changed", { skip: isWindows || isRoot }, () => {
  const open = freshDir();
  fs.mkdirSync(open, { mode: 0o755 });
  fs.chmodSync(open, 0o755);
  assert.throws(() => openStore(open, { create: true }), stopWith("conflict", "credential_permissions_unsafe"));
  assert.equal(mode(open), 0o755, "permissions were changed");
  assert.equal(fs.existsSync(path.join(open, "credentials")), false);

  const dir = freshDir();
  const store = openStore(dir, { create: true });
  fs.chmodSync(store.credentials, 0o750);
  assert.throws(() => openStore(dir, { create: false }), stopWith("conflict", "credential_permissions_unsafe"));
  fs.chmodSync(store.credentials, 0o700);

  const slot = newSlot();
  writeCredential(store, slot, record());
  const file = path.join(store.credentials, `${slot}.json`);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readCredential(store, slot), stopWith("conflict", "credential_permissions_unsafe"));
  assert.equal(mode(file), 0o644);

  const shared = path.join(workDir, `shared ${counter}`);
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  assert.throws(
    () => openStore(path.join(shared, "config"), { create: true }),
    stopWith("conflict", "credential_permissions_unsafe"),
  );
  assert.equal(fs.existsSync(path.join(shared, "config")), false);
});

test("symbolic links in the store are refused and never followed", { skip: isWindows }, () => {
  const target = freshDir();
  openStore(target, { create: true });
  const link = freshDir();
  fs.symlinkSync(target, link, "dir");
  assert.throws(() => openStore(link, { create: true }), stopWith("conflict", "credential_path_unsafe"));

  const dir = freshDir();
  fs.mkdirSync(dir, { mode: 0o700 });
  const elsewhere = freshDir();
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(dir, "credentials"), "dir");
  assert.throws(() => openStore(dir, { create: true }), stopWith("conflict", "credential_path_unsafe"));

  const store = openStore(freshDir(), { create: true });
  const slot = newSlot();
  const outside = path.join(workDir, `outside ${counter}.json`);
  fs.writeFileSync(outside, "SYNTHETIC_BODY_MARKER", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(store.credentials, `${slot}.json`));
  assert.throws(() => readCredential(store, slot), stopWith("conflict", "credential_path_unsafe"));
  assert.throws(() => writeCredential(store, slot, record()), stopWith("conflict", "credential_path_unsafe"));
  assert.throws(() => deleteCredential(store, slot), stopWith("conflict", "credential_path_unsafe"));
  assert.equal(fs.readFileSync(outside, "utf8"), "SYNTHETIC_BODY_MARKER", "the link target was changed");
});

test("corrupt, foreign or oversized grant files are unreadable rather than guessed", () => {
  const store = openStore(freshDir(), { create: true });
  const slot = newSlot();
  const file = path.join(store.credentials, `${slot}.json`);
  const cases = [
    "not json",
    JSON.stringify({ schema_version: 1, protection: isWindows ? "owner_only_file" : "dpapi", credential: record() }),
    JSON.stringify({ schema_version: 1, protection: PROTECTION, credential: { ...record(), scope: "agent:read" } }),
    JSON.stringify({ schema_version: 1, protection: PROTECTION, credential: { ...record(), extra: true } }),
    "x".repeat(70 * 1024),
  ];
  for (const content of cases) {
    fs.writeFileSync(file, content, { mode: 0o600 });
    assert.throws(() => readCredential(store, slot), stopWith("login_required", "credential_unreadable"));
  }
});

test("a failed write keeps the previous grant and leaves no temporary file", () => {
  const store = openStore(freshDir(), { create: true });
  const slot = newSlot();
  writeCredential(store, slot, record());
  const renameSync = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("SYNTHETIC_FAULT_MARKER"), { code: "EIO" });
  };
  try {
    assert.throws(
      () => writeCredential(store, slot, record({ access_token: "replacement-access-token-0000000" })),
      stopWith("filesystem_error", "credential_write_failed"),
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(readCredential(store, slot).access_token, ACCESS);
  assert.deepEqual(fs.readdirSync(store.credentials), [`${slot}.json`]);
});

test("the slot lock serializes work and reports a held lock as a conflict", async () => {
  const store = openStore(freshDir(), { create: true });
  const slot = newSlot();
  const order = [];
  const first = withSlotLock(store, slot, async () => {
    order.push("first start");
    await new Promise((resolve) => setTimeout(resolve, 150));
    order.push("first end");
  }, { waitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = withSlotLock(store, slot, async () => order.push("second"), { waitMs: 5000 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first start", "first end", "second"]);
  assert.equal(fs.existsSync(path.join(store.credentials, `${slot}.lock`)), false);

  fs.writeFileSync(path.join(store.credentials, `${slot}.lock`), "");
  await assert.rejects(
    withSlotLock(store, slot, async () => assert.fail("ran without the lock"), { waitMs: 100 }),
    stopWith("conflict", "credential_locked"),
  );
  assert.equal(fs.existsSync(path.join(store.credentials, `${slot}.lock`)), true, "a held lock was removed");
});

test("a cancel signal stops the wait for a held lock and never touches that lock", async () => {
  const store = openStore(freshDir(), { create: true });
  const slot = newSlot();
  const lock = path.join(store.credentials, `${slot}.lock`);
  fs.writeFileSync(lock, "held by another process");
  const before = fs.statSync(lock).mtimeMs;

  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    withSlotLock(store, slot, async () => assert.fail("ran without the lock"), {
      waitMs: 20000,
      signal: controller.signal,
    }),
    stopWith("authorization_failed", "cancelled"),
  );
  assert.ok(Date.now() - started < 2000, "the wait ignored the cancel signal");
  assert.equal(fs.readFileSync(lock, "utf8"), "held by another process");
  assert.equal(fs.statSync(lock).mtimeMs, before);

  // Already cancelled: no attempt at all, and the lock stays.
  await assert.rejects(
    withSlotLock(store, slot, async () => assert.fail("ran"), { waitMs: 20000, signal: AbortSignal.abort() }),
    stopWith("authorization_failed", "cancelled"),
  );
  assert.equal(fs.existsSync(lock), true);

  // Without a held lock, a cancelled signal still stops before work and
  // leaves no lock behind.
  fs.unlinkSync(lock);
  await assert.rejects(
    withSlotLock(store, slot, async () => assert.fail("ran"), { waitMs: 100, signal: AbortSignal.abort() }),
    stopWith("authorization_failed", "cancelled"),
  );
  assert.equal(fs.existsSync(lock), false);
});

test("the config directory comes from the flag, then METERGRAPH_CONFIG_DIR, then the home directory", () => {
  const flag = resolveConfigDir("relative dir", {});
  assert.equal(flag, path.resolve("relative dir"));
  const absolute = path.join(workDir, "from env");
  assert.equal(resolveConfigDir(null, { METERGRAPH_CONFIG_DIR: absolute }), absolute);
  assert.throws(
    () => resolveConfigDir(null, { METERGRAPH_CONFIG_DIR: "relative" }),
    stopWith("invalid_input", "invalid_config_dir"),
  );
  const fallback = resolveConfigDir(null, { METERGRAPH_CONFIG_DIR: "", CODEX_HOME: absolute, HOME: absolute });
  assert.ok(fallback.startsWith(os.homedir()));
  assert.ok(!fallback.startsWith(absolute));
});
