import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assertNoLeak, parseJsonLine, runCli, startServer } from "./helpers.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ENVELOPE_KEYS = ["command", "data", "error", "exit_code", "ok", "outcome", "schema_version"];

test("help works offline in text and JSON form", async () => {
  const text = await runCli(["--help"], { offline: true });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Usage:/);
  assert.match(text.stdout, /doctor/);
  assert.equal(text.stderr, "");

  const doctorHelp = await runCli(["help", "doctor"], { offline: true });
  assert.equal(doctorHelp.code, 0);
  assert.match(doctorHelp.stdout, /--timeout-ms/);

  const json = await runCli(["--help", "--json"], { offline: true });
  assert.equal(json.code, 0);
  assert.equal(json.stderr, "");
  const result = parseJsonLine(json.stdout);
  assert.deepEqual(Object.keys(result).sort(), ENVELOPE_KEYS);
  assert.equal(result.schema_version, 1);
  assert.equal(result.command, "help");
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  const codes = Object.fromEntries(result.data.exit_codes.map((entry) => [entry.outcome, entry.code]));
  assert.deepEqual(codes, {
    ok: 0,
    internal_error: 1,
    invalid_input: 2,
    authentication_required: 3,
    connection_failed: 4,
    unhealthy: 5,
    unsupported: 6,
    redirect_rejected: 7,
    conflict: 8,
    filesystem_error: 9,
    authorization_failed: 10,
    verification_failed: 11,
    login_required: 12,
    revocation_unconfirmed: 13,
    capability_unavailable: 14,
    permission_denied: 15,
    rate_limited: 16,
    cancelled: 17,
  });
  assert.deepEqual(
    result.data.commands.map((command) => command.name),
    [
      "doctor",
      "skill install",
      "skill update",
      "skills install",
      "skills update",
      "skills list",
      "login",
      "logout",
      "setup",
      "verify",
      "status",
      "context",
      "capabilities",
      "usage",
      "routes",
      "traces",
    ],
  );
  assert.deepEqual(result.data.skill_clients, ["codex", "claude", "cursor"]);
  assert.deepEqual(result.data.skill_runtimes, ["local", "cloud"]);
  assert.deepEqual(result.data.login_runtimes, ["local"]);
  for (const entry of result.data.exit_codes) assert.equal(typeof entry.meaning, "string");
});

test("login and logout help works offline and states what is not done", async () => {
  for (const args of [["help", "login"], ["login", "--help"]]) {
    const run = await runCli(args, { offline: true });
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /metergraph login --runtime local/);
    assert.match(run.stdout, /agent:metadata/);
    assert.match(run.stdout, /does not create an application ingest key/);
    assert.match(run.stdout, /no manual API key is required/);
    assert.doesNotMatch(run.stdout, /creates no API/);
    assert.match(run.stdout, /--no-browser/);
    assert.match(run.stdout, /--reconnect/);
  }
  const logout = await runCli(["help", "logout"], { offline: true });
  assert.equal(logout.code, 0);
  assert.match(logout.stdout, /metergraph logout/);
  assert.match(logout.stdout, /code 13/);
  const json = await runCli(["help", "login", "--json"], { offline: true });
  assert.equal(parseJsonLine(json.stdout).data.topic, "login");
});

test("skill help works offline and states what is not done", async () => {
  for (const args of [["help", "skill"], ["skill", "--help"], ["skill", "install", "--help"]]) {
    const run = await runCli(args, { offline: true });
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /metergraph skill install --client CLIENT \[--runtime RUNTIME\]/);
    assert.match(run.stdout, /metergraph skill update --client CLIENT \[--runtime RUNTIME\]/);
    assert.match(run.stdout, /Discovery stays pending/);
    assert.match(run.stdout, /does not sign in/);
  }
  const json = await runCli(["help", "skill", "--json"], { offline: true });
  assert.equal(parseJsonLine(json.stdout).data.topic, "skill");
});

test("no arguments prints help and exits 0", async () => {
  const run = await runCli([], { offline: true });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Usage:/);
});

test("version works offline in text and JSON form", async () => {
  const text = await runCli(["--version"], { offline: true });
  assert.equal(text.code, 0);
  assert.equal(text.stdout, `${version}\n`);
  assert.equal(text.stderr, "");

  const json = await runCli(["--version", "--json"], { offline: true });
  assert.equal(json.code, 0);
  const result = parseJsonLine(json.stdout);
  assert.deepEqual(Object.keys(result).sort(), ENVELOPE_KEYS);
  assert.equal(result.command, "version");
  assert.deepEqual(result.data, { name: "metergraph-cli", version });
});

test("the offline guard used by these tests really blocks the network", async () => {
  const run = await runCli(["doctor", "--url", "http://127.0.0.1:9", "--json"], { offline: true });
  assert.equal(run.code, 99);
  assert.match(run.stderr, /NETWORK_ACCESS_ATTEMPTED/);
});

test("unsafe URLs are refused before any request and are never echoed", async () => {
  const server = await startServer({});
  try {
    const unsafe = [
      `http://user:hunter2@127.0.0.1:${server.port}`,
      `http://127.0.0.1:${server.port}/app?token=hunter2`,
      `http://127.0.0.1:${server.port}/#hunter2`,
      "http://evil.example.com",
      "https://user:hunter2@evil.example.com",
      "javascript:hunter2",
    ];
    for (const url of unsafe) {
      for (const form of [["--url", url], [`--url=${url}`]]) {
        const json = await runCli(["doctor", ...form, "--json"]);
        assert.equal(json.code, 2);
        assert.equal(json.stderr, "");
        const result = parseJsonLine(json.stdout);
        assert.deepEqual(Object.keys(result).sort(), ENVELOPE_KEYS);
        assert.equal(result.outcome, "invalid_input");
        assert.equal(result.error.code, "invalid_input");
        assert.equal(result.error.reason, "invalid_url");
        assert.ok(!json.stdout.includes(url));
        assertNoLeak(assert, json.stdout, json.stderr);

        const text = await runCli(["doctor", ...form], { offline: true });
        assert.equal(text.code, 2);
        assert.equal(text.stdout, "");
        assert.ok(!text.stderr.includes(url));
        assertNoLeak(assert, text.stdout, text.stderr);
      }
    }
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("unknown commands, arguments and bad timeouts exit 2 without echo", async () => {
  const cases = [
    ["sk-fake-2222222222222222"],
    ["login", "--token", "hunter2"],
    ["doctor", "--api-key=hunter2"],
    ["doctor", "--timeout-ms", "hunter2"],
    ["doctor", "--timeout-ms", "5"],
  ];
  for (const args of cases) {
    const text = await runCli(args, { offline: true });
    assert.equal(text.code, 2);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /^Error: /);
    assertNoLeak(assert, text.stdout, text.stderr);

    const json = await runCli([...args, "--json"], { offline: true });
    assert.equal(json.code, 2);
    assert.equal(json.stderr, "");
    const result = parseJsonLine(json.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "invalid_input");
    assert.equal(typeof result.error.message, "string");
    assertNoLeak(assert, json.stdout, json.stderr);
  }
});
