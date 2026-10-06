import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs } from "../src/args.js";

test("defaults doctor to the hosted origin and the default timeout", () => {
  const parsed = parseArgs(["doctor"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.origin, "https://app.metergraph.dev");
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.json, false);
});

test("accepts doctor options in both spellings", () => {
  const spaced = parseArgs(["doctor", "--url", "http://127.0.0.1:4000", "--timeout-ms", "250", "--json"]);
  const joined = parseArgs(["--json", "doctor", "--url=http://127.0.0.1:4000/", "--timeout-ms=250"]);
  for (const parsed of [spaced, joined]) {
    assert.equal(parsed.ok, true);
    assert.equal(parsed.origin, "http://127.0.0.1:4000");
    assert.equal(parsed.timeoutMs, 250);
    assert.equal(parsed.json, true);
  }
});

test("routes help and version", () => {
  assert.equal(parseArgs([]).command, "help");
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
  assert.equal(parseArgs(["help", "doctor"]).topic, "doctor");
  assert.equal(parseArgs(["doctor", "--help"]).topic, "doctor");
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.equal(parseArgs(["--version", "--json"]).json, true);
});

test("parses skill install and update in both spellings", () => {
  const spaced = parseArgs(["skill", "install", "--client", "codex", "--runtime", "cloud", "--project", "my app"]);
  assert.deepEqual(spaced, {
    ok: true,
    command: "skill",
    action: "install",
    client: "codex",
    runtime: "cloud",
    project: "my app",
    json: false,
  });
  const joined = parseArgs(["--json", "skill", "--client=cursor", "update", "--runtime=local"]);
  assert.deepEqual(joined, {
    ok: true,
    command: "skill",
    action: "update",
    client: "cursor",
    runtime: "local",
    project: null,
    json: true,
  });
  assert.equal(parseArgs(["skill", "install", "--client", "chatgpt", "--runtime", "cloud"]).ok, true);
  assert.equal(parseArgs(["skill", "install", "--client", "claude", "--runtime", "cloud-no-shell"]).ok, true);
  assert.equal(parseArgs(["help", "skill"]).topic, "skill");
  assert.equal(parseArgs(["skill", "install", "--help"]).topic, "skill");
});

test("rejects bad skill input with fixed messages that never contain the input", () => {
  const cases = [
    [["skill"], "missing_subcommand"],
    [["skill", "uninstall"], "unknown_subcommand"],
    [["skill", "install", "--runtime", "local"], "missing_client"],
    [["skill", "install", "--client", "hunter2", "--runtime", "local"], "invalid_client"],
    [["skill", "install", "--client", "CODEX", "--runtime", "local"], "invalid_client"],
    [["skill", "install", "--client", "codex"], "missing_runtime"],
    [["skill", "install", "--client", "codex", "--runtime", "sk-fake-2222222222222222"], "invalid_runtime"],
    [["skill", "install", "--client", "codex", "--runtime", "local", "--project="], "invalid_project"],
    [["skill", "install", "--client", "codex", "--runtime", "local", "--force"], "unknown_argument"],
    [["skill", "install", "update", "--client", "codex", "--runtime", "local"], "unknown_argument"],
    [["skill", "install", "--client", "codex", "--runtime", "local", "--url", "x"], "unknown_argument"],
    [["doctor", "--client", "codex"], "unknown_argument"],
  ];
  const fixedWords = new Set(["skill", "install", "update", "--client", "--runtime", "--project", "codex", "local"]);
  for (const [argv, code] of cases) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, code);
    for (const arg of argv) {
      if (fixedWords.has(arg) || arg.length < 4) continue;
      assert.ok(!parsed.message.includes(arg), "error message echoes an argument value");
    }
  }
});

test("parses login and logout with explicit runtime, paths and flags", () => {
  const workspace = "0B5C7C1E-1A2B-4C3D-8E4F-5A6B7C8D9E01";
  const parsed = parseArgs([
    "login",
    "--runtime",
    "local",
    "--url=http://127.0.0.1:4000/",
    "--workspace",
    workspace,
    "--project",
    "my app",
    "--config-dir",
    "my config",
    "--timeout-ms",
    "60000",
    "--no-browser",
    "--reconnect",
  ]);
  assert.deepEqual(parsed, {
    ok: true,
    command: "login",
    runtime: "local",
    origin: "http://127.0.0.1:4000",
    workspace: workspace.toLowerCase(),
    project: "my app",
    configDir: "my config",
    timeoutMs: 60000,
    signup: false,
    noBrowser: true,
    reconnect: true,
    json: false,
  });
  const defaults = parseArgs(["--json", "login", "--runtime", "cloud", "--signup"]);
  assert.equal(defaults.ok, true);
  assert.equal(defaults.origin, "https://app.metergraph.dev");
  assert.equal(defaults.workspace, null);
  assert.equal(defaults.timeoutMs, 300000);
  assert.equal(defaults.signup, true);
  assert.equal(defaults.json, true);
  assert.deepEqual(parseArgs(["logout", "--config-dir=dir", "--json"]), {
    ok: true,
    command: "logout",
    project: null,
    configDir: "dir",
    json: true,
  });
  assert.equal(parseArgs(["help", "login"]).topic, "login");
  assert.equal(parseArgs(["logout", "--help"]).topic, "logout");
});

test("rejects bad login and logout input without echoing it", () => {
  const cases = [
    [["login"], "missing_runtime"],
    [["login", "--runtime", "sk-fake-2222222222222222"], "invalid_runtime"],
    [["login", "--runtime", "local", "--url", "https://user:hunter2@example.com"], "invalid_url"],
    [["login", "--runtime", "local", "--workspace", "hunter2-not-a-uuid"], "invalid_workspace"],
    [["login", "--runtime", "local", "--timeout-ms", "500"], "invalid_timeout"],
    [["login", "--runtime", "local", "--timeout-ms", "900001"], "invalid_timeout"],
    [["login", "--runtime", "local", "--config-dir="], "invalid_config_dir"],
    [["login", "--runtime", "local", "--project="], "invalid_project"],
    [["login", "--runtime", "local", "--no-browser=yes"], "unexpected_value"],
    [["login", "--runtime", "local", "--reconnect", "--reconnect"], "duplicate_option"],
    [["login", "--runtime", "local", "--token", "hunter2"], "unknown_argument"],
    [["login", "--runtime", "local", "--client", "codex"], "unknown_argument"],
    [["logout", "--url", "https://example.com"], "unknown_argument"],
    [["logout", "--reconnect"], "unknown_argument"],
    [["logout", "--config-dir"], "missing_value"],
  ];
  const fixedWords = new Set(["login", "logout", "--runtime", "local", "--url", "--workspace", "--timeout-ms"]);
  for (const [argv, code] of cases) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false, code);
    assert.equal(parsed.code, code);
    for (const arg of argv) {
      if (fixedWords.has(arg) || arg.startsWith("--") || arg.length < 4) continue;
      assert.ok(!parsed.message.includes(arg), "error message echoes an argument value");
    }
  }
});

test("rejects bad input with fixed messages that never contain the input", () => {
  const cases = [
    [["status"], "unknown_command"],
    [["sk-fake-2222222222222222"], "unknown_command"],
    [["doctor", "--token", "hunter2"], "unknown_argument"],
    [["doctor", "--url=https://user:hunter2@example.com"], "invalid_url"],
    [["doctor", "--url", "https://example.com/?key=hunter2"], "invalid_url"],
    [["doctor", "--url", "http://evil.example.com"], "invalid_url"],
    [["doctor", "--url"], "missing_value"],
    [["doctor", "--url", "https://a.example.com", "--url", "https://b.example.com"], "duplicate_option"],
    [["doctor", "--timeout-ms", "0"], "invalid_timeout"],
    [["doctor", "--timeout-ms", "99999999"], "invalid_timeout"],
    [["doctor", "--timeout-ms", "1e3"], "invalid_timeout"],
    [["doctor", "--timeout-ms", "-5"], "invalid_timeout"],
    [["--version", "doctor"], "unknown_argument"],
  ];
  // Option names and very short values may legitimately appear in fixed text.
  const fixedWords = new Set(["doctor", "--url", "--timeout-ms", "--version", "--json"]);
  for (const [argv, code] of cases) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, code);
    for (const arg of argv) {
      if (fixedWords.has(arg) || arg.length < 4) continue;
      assert.ok(!parsed.message.includes(arg), "error message echoes an argument value");
    }
  }
});
