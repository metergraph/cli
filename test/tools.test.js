// tools list and tools call with a coding-agent key, as an agent in an SSH
// session or a container uses them. Every run is a subprocess against the
// synthetic loopback service in test/fixtures/oauth-server.js, whose small
// MCP endpoint offers Metadata tools to a Metadata key and all tools to a
// Debug key with every workflow permission. Every value is synthetic. This proves the CLI's protocol and
// output only, not the real service.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { LOCAL_ENV, checked, isWindows, sandboxes } from "./auth-helpers.js";
import { runCli } from "./helpers.js";
import { startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph tools test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const KEY = "mgak_synthetic_metadata_key_3333333333333333";
const DEBUG_KEY = "mgak_synthetic_debug_key_2222222222222222";
const SSH = { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" };

async function withServer(behavior, work) {
  const server = await startOAuthServer({ agentTokens: [KEY], debugTokens: [DEBUG_KEY], ...behavior });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

async function tools(server, args, { key = KEY, json = true } = {}) {
  const box = sandbox();
  const full = [...(json ? ["--json"] : []), "tools", ...args, "--project", box.project, "--config-dir", box.config];
  const run = await runCli(full, { env: { ...LOCAL_ENV, ...SSH, METERGRAPH_URL: server.origin, METERGRAPH_AGENT_TOKEN: key } });
  const { result } = checked(assert, run, { box, json });
  for (const secret of [KEY, DEBUG_KEY]) {
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), "a key was printed");
  }
  return { run, result };
}

const sent = (server, before) => server.requests.slice(before).map((request) => `${request.method} ${request.path}`);
const rpcMethods = (server, before) =>
  server.requests.slice(before).filter((request) => request.path === "/v1/agent/mcp").map((request) => JSON.parse(request.body));

test("tools list shows a Metadata key only the tools it may use, after the usual checks", () =>
  withServer({}, async (server) => {
    const before = server.requests.length;
    const { run, result } = await tools(server, ["list"]);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.command, "tools list");
    assert.deepEqual(sent(server, before), [
      "GET /v1/deployment",
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
      "POST /v1/agent/mcp",
    ]);
    assert.deepEqual(rpcMethods(server, before).map((message) => message.method), ["tools/list"]);
    assert.deepEqual(result.data.result.tools.map((tool) => [tool.name, tool.read_only, tool.needs_confirmation]), [
      ["metergraph_list_classified_workloads", true, false],
    ]);
    assert.deepEqual(result.data.result.tools[0].input_schema.properties, { limit: { type: "integer" } });
  }));

test("a Debug key with every permission sees the write and start tools, marked as needing --yes", () =>
  withServer({}, async (server) => {
    const { result } = await tools(server, ["list"], { key: DEBUG_KEY });
    assert.deepEqual(result.data.result.tools.map((tool) => [tool.name, tool.read_only, tool.open_world, tool.needs_confirmation]), [
      ["metergraph_list_classified_workloads", true, false, false],
      ["metergraph_save_evaluation_draft", false, false, true],
      ["metergraph_start_analysis", false, true, true],
    ]);
    const human = await tools(server, ["list"], { key: DEBUG_KEY, json: false });
    assert.match(human.run.stdout, /metergraph_start_analysis\s+calls out, needs --yes/);
    assert.match(human.run.stdout, /metergraph_save_evaluation_draft\s+writes, needs --yes/);
    assert.match(human.run.stdout, /metergraph_list_classified_workloads\s+read/);
  }));

test("tools list --name shows one tool, or says it is not offered", () =>
  withServer({}, async (server) => {
    let { result } = await tools(server, ["list", "--name", "metergraph_list_classified_workloads"]);
    assert.deepEqual(result.data.result.tools.map((tool) => tool.name), ["metergraph_list_classified_workloads"]);
    ({ result } = await tools(server, ["list", "--name", "metergraph_start_analysis"]));
    assert.equal(result.outcome, "capability_unavailable");
    assert.equal(result.error.reason, "tool_unavailable");
    assert.equal(result.data.next_action.command, "metergraph tools list --json");
  }));

test("a read-only tool is called without --yes and its result is printed as the service sent it", () =>
  withServer({ toolCall: (params) => ({ items: [{ display_name: "triage", calls: 40 }], asked: params.arguments }) }, async (server) => {
    const before = server.requests.length;
    const { run, result } = await tools(server, ["call", "metergraph_list_classified_workloads", "--args", '{"limit": 5}']);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.command, "tools call");
    assert.deepEqual(result.data.result, {
      tool: "metergraph_list_classified_workloads",
      read_only: true,
      open_world: false,
      result: { items: [{ display_name: "triage", calls: 40 }], asked: { limit: 5 } },
    });
    const calls = rpcMethods(server, before);
    assert.deepEqual(calls.map((message) => message.method), ["tools/list", "tools/call"]);
    assert.deepEqual(calls[1].params, { name: "metergraph_list_classified_workloads", arguments: { limit: 5 } });
    const human = await tools(server, ["call", "metergraph_list_classified_workloads"], { json: false });
    assert.match(human.run.stdout, /"display_name": "triage"/);
  }));

test("a tool that writes or starts work needs --yes, and without it nothing is called", () =>
  withServer({}, async (server) => {
    for (const name of ["metergraph_save_evaluation_draft", "metergraph_start_analysis"]) {
      const before = server.requests.length;
      const { run, result } = await tools(server, ["call", name, "--args", '{"draft": {}}'], { key: DEBUG_KEY });
      assert.equal(run.code, 18);
      assert.equal(result.outcome, "action_required");
      assert.equal(result.error.reason, "confirmation_required");
      assert.equal(result.data.next_action.kind, "confirm_tool_call");
      assert.deepEqual(rpcMethods(server, before).map((message) => message.method), ["tools/list"]);
    }
    const before = server.requests.length;
    const { run, result } = await tools(server, ["call", "metergraph_start_analysis", "--args", "{}", "--yes"], { key: DEBUG_KEY });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.result.tool, "metergraph_start_analysis");
    assert.deepEqual(rpcMethods(server, before).map((message) => message.method), ["tools/list", "tools/call"]);
  }));

test("without annotations, as from an older service, every tool needs --yes", () =>
  withServer({ annotations: false }, async (server) => {
    const { run, result } = await tools(server, ["call", "metergraph_list_classified_workloads"]);
    assert.equal(run.code, 18);
    assert.equal(result.error.reason, "confirmation_required");
  }));

test("a tool the key cannot use is not called", () =>
  withServer({}, async (server) => {
    const before = server.requests.length;
    const { run, result } = await tools(server, ["call", "metergraph_save_evaluation_draft", "--yes"]);
    assert.equal(run.code, 14);
    assert.equal(result.error.reason, "tool_unavailable");
    assert.deepEqual(rpcMethods(server, before).map((message) => message.method), ["tools/list"]);
  }));

test("a tool's refusal is reported with the service's error document", () =>
  withServer({ toolCall: () => ({ error: { code: "invalid_argument", message: "draft.members[0]: required" } }) }, async (server) => {
    const { run, result } = await tools(server, ["call", "metergraph_save_evaluation_draft", "--args", '{"draft": {}}', "--yes"], {
      key: DEBUG_KEY,
    });
    assert.equal(run.code, 19);
    assert.equal(result.outcome, "refused");
    assert.equal(result.error.reason, "tool_error");
    assert.deepEqual(result.data.tool_error, { code: "invalid_argument", message: "draft.members[0]: required" });
    assert.equal(result.data.next_action.kind, "fix_tool_arguments");
  }));

test("arguments must be one JSON object, from --args or --args-file", { skip: isWindows }, () =>
  withServer({ toolCall: (params) => ({ asked: params.arguments }) }, async (server) => {
    for (const args of ["[1, 2]", "not json", "7"]) {
      const before = server.requests.length;
      const { run, result } = await tools(server, ["call", "metergraph_list_classified_workloads", "--args", args]);
      assert.equal(run.code, 2, args);
      assert.equal(result.error.reason, "args_invalid");
      assert.ok(!rpcMethods(server, before).some((message) => message.method === "tools/call"));
    }
    const file = path.join(workDir, "args.json");
    fs.writeFileSync(file, '{"limit": 3}');
    const { result } = await tools(server, ["call", "metergraph_list_classified_workloads", "--args-file", file]);
    assert.deepEqual(result.data.result.result, { asked: { limit: 3 } });
  }));

test("a Replay key is refused before any tool request", () =>
  withServer({ workspace: (doc) => ({ ...doc, access: { scopes: ["agent:read", "agent:replay"] } }) }, async (server) => {
    const before = server.requests.length;
    const { run, result } = await tools(server, ["list"]);
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "scope_mismatch");
    assert.ok(!sent(server, before).includes("POST /v1/agent/mcp"));
  }));

test("a result that echoes the key is not printed", () =>
  withServer({ toolCall: () => ({ echoed: KEY }) }, async (server) => {
    const { run, result } = await tools(server, ["call", "metergraph_list_classified_workloads"]);
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "credential_in_metadata_response");
    assert.equal(result.data.result, null);
  }));

test("tools arguments are checked before anything is sent", async () => {
  for (const [args, reason] of [
    [["tools"], "missing_subcommand"],
    [["tools", "run"], "unknown_subcommand"],
    [["tools", "call"], "missing_tool"],
    [["tools", "call", "rm -rf"], "invalid_tool"],
    [["tools", "call", "Metergraph_get"], "invalid_tool"],
    [["tools", "list", "--yes"], "unknown_argument"],
    [["tools", "list", "--args", "{}"], "unknown_argument"],
    [["tools", "call", "metergraph_get_usage", "--args", "{}", "--args-file", "x"], "conflicting_options"],
  ]) {
    const run = await runCli(["--json", ...args], { env: LOCAL_ENV });
    assert.equal(run.code, 2, args.join(" "));
    assert.equal(JSON.parse(run.stdout).error.reason, reason, args.join(" "));
  }
});

test("control and bidirectional characters in a result never reach the terminal raw", () =>
  withServer({ toolCall: () => ({ note: "a\u009b31mred‮b\u0007c" }) }, async (server) => {
    for (const json of [true, false]) {
      const { run } = await tools(server, ["call", "metergraph_list_classified_workloads"], { json });
      assert.equal(run.code, 0, run.stdout);
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/.test(run.stdout), "a raw control character was printed");
      assert.ok(run.stdout.includes("\\u009b31mred\\u202eb\\u0007c"));
    }
  }));
