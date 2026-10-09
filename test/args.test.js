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
  // --runtime defaults to local, the runtime setup installs the skill for,
  // for skill and skills install and update alike. Explicit values still win.
  for (const command of ["skill", "skills"]) {
    for (const action of ["install", "update"]) {
      const defaulted = parseArgs([command, action, "--client", "claude"]);
      assert.equal(defaulted.ok, true, `${command} ${action}`);
      assert.equal(defaulted.runtime, "local", `${command} ${action}`);
      assert.equal(parseArgs([command, action, "--client", "claude", "--runtime", "cloud"]).runtime, "cloud");
      assert.equal(parseArgs([command, action, "--client", "claude", "--runtime", "cloud-no-shell"]).runtime, "cloud-no-shell");
      assert.equal(parseArgs([command, action, "--client", "claude", "--runtime", ""]).code, "invalid_runtime");
    }
  }
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

test("setup requires a selected client or explicit skip and keeps login choices bounded", () => {
  const workspace = "0B5C7C1E-1A2B-4C3D-8E4F-5A6B7C8D9E01";
  const parsed = parseArgs(["setup", "--runtime", "local", "--client", "cursor",
    "--url", "http://127.0.0.1:4000/", "--workspace", workspace, "--signup", "--reconnect"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.origin, "http://127.0.0.1:4000");
  assert.equal(parsed.originExplicit, true);
  assert.equal(parsed.workspace, workspace.toLowerCase());
  assert.equal(parsed.client, "cursor");
  assert.equal(parsed.skipSkill, false);
  assert.equal(parsed.signup, true);
  assert.equal(parsed.reconnect, true);
  const skipped = parseArgs(["setup", "--runtime", "local", "--skip-skill"]);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.client, null);
  assert.equal(skipped.skipSkill, true);
  assert.equal(skipped.originExplicit, false);
  for (const [args, reason] of [
    [["setup", "--runtime", "local"], "client_required"],
    [["setup", "--runtime", "local", "--client", "other"], "invalid_client"],
    [["setup", "--runtime", "local", "--client", "codex", "--skip-skill"], "client_conflict"],
  ]) assert.equal(parseArgs(args).code, reason);
});

test("non-hosted setup requires an explicit origin and workspace and keeps operator inputs separate", () => {
  const workspace = "00000000-0000-4000-8000-00000000000a";
  const parsed = parseArgs(["setup", "--runtime", "local", "--deployment", "customer-local",
    "--url", "http://127.0.0.1:43210", "--workspace", workspace,
    "--confirm-prerequisites", "--agent-token-file", "/tmp/agent-token", "--skip-skill"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.deployment, "customer-local");
  assert.equal(parsed.confirmPrerequisites, true);
  assert.equal(parsed.agentTokenFile, "/tmp/agent-token");
  assert.equal(parsed.originExplicit, true);
  for (const [argv, reason] of [
    [["setup", "--runtime", "local", "--deployment", "local", "--skip-skill"], "invalid_deployment"],
    [["setup", "--runtime", "local", "--deployment", "byoc", "--skip-skill"], "non_hosted_origin_required"],
    [["setup", "--runtime", "local", "--deployment", "oss", "--url", "https://example.com", "--skip-skill"], "non_hosted_workspace_required"],
    [["setup", "--runtime", "local", "--confirm-prerequisites", "--skip-skill"], "managed_route_conflict"],
    [["setup", "--runtime", "local", "--agent-token-file", "secret", "--skip-skill"], "managed_route_conflict"],
  ]) {
    const result = parseArgs(argv);
    assert.equal(result.ok, false);
    assert.equal(result.code, reason);
  }
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

test("parses read commands with bounded defaults and explicit values", () => {
  assert.deepEqual(parseArgs(["status"]), {
    ok: true,
    command: "status",
    project: null,
    configDir: null,
    timeoutMs: 15000,
    days: null,
    limit: null,
    route: null,
    status: null,
    cursor: null,
    json: false,
  });
  const usage = parseArgs(["--json", "usage", "--days=90", "--limit", "200", "--project", "app", "--timeout-ms", "60000"]);
  assert.equal(usage.ok, true);
  assert.equal(usage.days, 90);
  assert.equal(usage.limit, 200);
  assert.equal(usage.timeoutMs, 60000);
  assert.equal(parseArgs(["usage"]).days, 7);
  assert.equal(parseArgs(["usage"]).limit, 50);
  assert.equal(parseArgs(["routes"]).limit, 50);
  assert.equal(parseArgs(["routes"]).days, null);
  const traces = parseArgs(["traces", "--route", "checkout summary", "--status", "error", "--cursor", "page:2"]);
  assert.equal(traces.ok, true);
  assert.equal(traces.limit, 20);
  assert.deepEqual([traces.route, traces.status, traces.cursor], ["checkout summary", "error", "page:2"]);
  assert.equal(parseArgs(["help", "traces"]).topic, "traces");
  assert.equal(parseArgs(["usage", "--help"]).topic, "usage");
});

test("read commands refuse environment, time range, query and content requests as unsupported", () => {
  const cases = [
    [["usage", "--environment", "hunter2"], "environment_selector_unsupported"],
    [["traces", "--workload", "hunter2"], "workload_filter_unsupported"],
    [["traces", "--workload="], "workload_filter_unsupported"],
    [["routes", "--since=hunter2"], "time_range_unsupported"],
    [["traces", "--sql", "hunter2"], "query_unsupported"],
    [["traces", "--content"], "content_access_unsupported"],
  ];
  for (const [argv, code] of cases) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.outcome, "unsupported");
    assert.equal(parsed.code, code);
    assert.ok(!parsed.message.includes("hunter2"));
  }
  // Doctor does not know these options; they stay unknown arguments there.
  assert.equal(parseArgs(["doctor", "--environment", "x"]).code, "unknown_argument");
  assert.equal(parseArgs(["doctor", "--environment", "x"]).outcome, "invalid_input");
});

test("rejects bad input with fixed messages that never contain the input", () => {
  const cases = [
    [["whoami"], "unknown_command"],
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
