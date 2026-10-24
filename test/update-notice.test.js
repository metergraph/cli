import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { isNewer, latestVersion, maybeUpdateNotice, refreshUpdateCache, UPDATE_TTL_MS } from "../src/update-notice.js";
import { main } from "../src/cli.js";
import { VERSION } from "../src/constants.js";

const dirs = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-update-"));
  dirs.push(dir);
  return dir;
}
after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function stream(isTTY = true) { return { isTTY, text: "", write(s) { this.text += s; } }; }
function cache(dir, checked_at, latest) { fs.writeFileSync(path.join(dir, "update.json"), JSON.stringify({ checked_at, latest })); }

test("version ordering handles numeric components and stable vs prerelease without printing arbitrary tags", () => {
  for (const [latest, current, expected] of [
    ["0.10.0", "0.9.9", true], ["1.0.0", "0.99.99", true], ["0.2.4", "0.2.3", true],
    ["0.2.3", "0.2.3", false], ["0.2.2", "0.2.3", false], ["0.2.3", "0.2.3-beta.1", true],
    ["0.2.3", "0.2.3+build.1", false], ["0.2.4-next.1", "0.2.3", false],
    ["\u001b[31m9.0.0", "0.2.3", false], ["01.2.3", "0.2.3", false],
    ["999999999999999999999.0.0", "0.2.3", false], ["1.0.0", "unknown", false],
  ]) assert.equal(isNewer(latest, current), expected);
});

test("fresh cache shows a notice only for newer versions and never refreshes", () => {
  const dir = temp();
  const now = Date.now();
  let refreshes = 0;
  for (const latest of ["0.2.4", "0.2.3", "0.2.2", null]) {
    cache(dir, now, latest);
    const stdout = stream(), stderr = stream();
    maybeUpdateNotice({ command: "help", json: false, stdout, stderr },
      { dir, now, current: "0.2.3", env: { NO_COLOR: "1" }, refresh: () => refreshes++ });
    assert.equal(stdout.text, "");
    if (latest === "0.2.4") assert.match(stderr.text, /Update available: 0.2.3 → 0.2.4\nRun npm install -g metergraph-cli@latest/);
    else assert.equal(stderr.text, "");
  }
  assert.equal(refreshes, 0);
});

test("missing, corrupt, expired and future caches schedule a refresh without awaiting it", () => {
  const dir = temp(), now = Date.now();
  let refreshes = 0;
  const stdout = stream(), stderr = stream();
  const show = () => maybeUpdateNotice({ command: "version", stdout, stderr },
    { dir, now, env: {}, refresh: () => { refreshes++; return new Promise(() => {}); } });
  show();
  fs.writeFileSync(path.join(dir, "update.json"), "invalid"); show();
  cache(dir, now - UPDATE_TTL_MS, "9.0.0"); show();
  cache(dir, now + 1000, "9.0.0"); show();
  assert.equal(refreshes, 4);
  assert.equal(stderr.text, "");
});

test("opt-out, CI, JSON, pipes and other commands neither print nor schedule network work", () => {
  let refreshes = 0;
  for (const override of [
    { env: { METERGRAPH_NO_UPDATE_CHECK: "1" } }, { env: { CI: "true" } }, { json: true },
    { stdout: stream(false) }, { stderr: stream(false) }, { command: "status" },
  ]) {
    const args = { command: "help", stdout: stream(), stderr: stream(), ...override };
    maybeUpdateNotice(args, { dir: temp(), env: override.env ?? {}, refresh: () => refreshes++ });
    assert.equal(args.stderr.text, "");
  }
  assert.equal(refreshes, 0);
});

test("successful and failed checks are cached for 24 hours; retries happen after expiry", async () => {
  const dir = temp(), now = Date.now();
  let calls = 0;
  const load = async () => { calls++; return "0.2.4"; };
  await refreshUpdateCache({ dir, now, load });
  await refreshUpdateCache({ dir, now: now + 1, load });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "update.json"))), { checked_at: now, latest: "0.2.4" });
  await refreshUpdateCache({ dir, now: now + UPDATE_TTL_MS, load: async () => { calls++; throw Error("offline"); } });
  await refreshUpdateCache({ dir, now: now + UPDATE_TTL_MS + 1, load });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "update.json"))).latest, null);
  await refreshUpdateCache({ dir, now: now + 2 * UPDATE_TTL_MS, load });
  assert.equal(calls, 3);
});

test("concurrent workers share a lock and stale locks recover", async () => {
  const dir = temp(), now = Date.now();
  let release, calls = 0;
  const first = refreshUpdateCache({ dir, now, load: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  await refreshUpdateCache({ dir, now, load: async () => { calls++; return "0.2.4"; } });
  assert.equal(calls, 1);
  release("0.2.4"); await first;
  const lock = path.join(dir, "update.lock");
  fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date(now - 61000), new Date(now - 61000));
  await refreshUpdateCache({ dir, now: now + UPDATE_TTL_MS, load: async () => "0.2.5" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "update.json"))).latest, "0.2.5");
});

test("the registry request is anonymous, bounded and rejects unsafe latest tags", async () => {
  let request;
  const load = data => latestVersion(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify(data));
  });
  assert.equal(await load({ latest: "0.2.4", next: "1.0.0-next.1" }), "0.2.4");
  assert.equal(request.url, "https://registry.npmjs.org/-/package/metergraph-cli/dist-tags");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, "omit");
  assert.deepEqual(request.options.headers, { accept: "application/json" });
  assert.ok(request.options.signal instanceof AbortSignal);
  for (const latest of ["9.0.0\nmalicious", "0.3.0-beta.1", "bad", null]) assert.equal(await load({ latest }), null);
  assert.equal(await latestVersion(async () => new Response("x".repeat(4097))), null);
  assert.equal(await latestVersion(async () => new Response("", { status: 503 })), null);
  await assert.rejects(latestVersion(async () => new Response("not json")));
});

test("main keeps version and JSON stdout stable while cached notices go only to terminal stderr", async () => {
  const base = temp();
  const saved = { ...process.env };
  try {
    process.env.XDG_CACHE_HOME = base;
    process.env.LOCALAPPDATA = base;
    process.env.CI = "";
    process.env.NO_COLOR = "1";
    delete process.env.METERGRAPH_NO_UPDATE_CHECK;
    const dir = process.platform === "win32" ? path.join(base, "Metergraph", "Cache") : path.join(base, "metergraph");
    fs.mkdirSync(dir, { recursive: true }); cache(dir, Date.now(), "999.0.0");
    const stdout = stream(), stderr = stream();
    assert.equal(await main(["--version"], { stdout, stderr }), 0);
    assert.equal(stdout.text, `${VERSION}\n`);
    assert.match(stderr.text, /Update available:/);
    for (const argv of [["--help", "--json"], ["--version", "--json"]]) {
      const stdout = stream(), stderr = stream();
      assert.equal(await main(argv, { stdout, stderr }), 0);
      assert.equal(JSON.parse(stdout.text).ok, true);
      assert.equal(stderr.text, "");
    }
    const piped = stream(false), quiet = stream();
    assert.equal(await main(["--version"], { stdout: piped, stderr: quiet }), 0);
    assert.equal(piped.text, `${VERSION}\n`); assert.equal(quiet.text, "");
  } finally {
    for (const name of ["XDG_CACHE_HOME", "LOCALAPPDATA", "CI", "NO_COLOR", "METERGRAPH_NO_UPDATE_CHECK"]) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});

test("a stalled response is aborted and cached without surfacing an error", async () => {
  const dir = temp();
  let aborted = false;
  // Keep the test alive: AbortSignal.timeout deliberately does not keep Node up.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await refreshUpdateCache({ dir, load: () => latestVersion(async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => { aborted = true; controller.error(signal.reason); }, { once: true });
      },
    }))) });
    assert.equal(aborted, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "update.json"))).latest, null);
  } finally { clearInterval(keepAlive); }
});

test("broken or unwritable cache paths fail silently without requesting npm", async () => {
  const dir = temp();
  const file = path.join(dir, "not-a-directory");
  fs.writeFileSync(file, "leave alone");
  let calls = 0;
  await refreshUpdateCache({ dir: file, load: async () => { calls++; return "9.0.0"; } });
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "leave alone");
});
