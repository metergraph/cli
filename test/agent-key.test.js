// The read commands with a coding-agent key instead of a saved sign in, as
// an agent in an SSH session, a cloud workspace, CI or a container uses them.
// Every run is a subprocess against the synthetic loopback service in
// test/fixtures/oauth-server.js, which accepts the keys in agentTokens the
// way the service accepts a Metadata coding-agent key. Every value is
// synthetic. This proves the CLI's protocol and output only, not the real
// service.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { classifyEnvironment } from "../src/environment.js";
import { BROWSER, LOCAL_ENV, checked, filesUnder, isWindows, login, sandboxes } from "./auth-helpers.js";
import { runCli } from "./helpers.js";
import { WORKSPACE_A, WORKSPACE_B, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph agent key test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const KEY = "mgak_synthetic_metadata_key_5555555555555555";
const OTHER_KEY = "mgak_synthetic_revoked_key_6666666666666666";
const DEBUG_KEY = "mgak_synthetic_debug_key_4444444444444444";
const SSH = { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" };

const PLAIN_WORKSPACE = (doc) => ({
  ...doc,
  workspace: { ...doc.workspace, slug: "example-workspace", name: "Example Workspace" },
});

async function withServer(behavior, work) {
  const server = await startOAuthServer({ workspace: PLAIN_WORKSPACE, agentTokens: [KEY], ...behavior });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

// Runs a read command and checks, beyond the sign in checks, that neither
// key ever appears in output or in any project or config file.
async function read(box, args, env = {}) {
  const full = ["--json", ...args, "--project", box.project, "--config-dir", box.config];
  const run = await runCli(full, { env: { ...LOCAL_ENV, ...env } });
  const { result } = checked(assert, run, { box });
  for (const secret of [KEY, OTHER_KEY, DEBUG_KEY]) {
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), "a key was printed");
    for (const dir of [box.project, box.config]) {
      for (const file of filesUnder(dir)) {
        assert.ok(!fs.readFileSync(path.join(dir, file), "latin1").includes(secret), "a key was written to a file");
      }
    }
  }
  return { run, result };
}

const keyed = (server, extra = {}) => ({ ...SSH, METERGRAPH_AGENT_TOKEN: KEY, METERGRAPH_URL: server.origin, ...extra });
const sent = (server, before) => server.requests.slice(before).map((request) => `${request.method} ${request.path}`);
const bearerOf = (request) => request.headers.authorization ?? null;

function bindProject(box, origin, workspaceId) {
  fs.mkdirSync(path.join(box.project, ".metergraph"), { recursive: true });
  const binding = {
    schema_version: 1,
    origin,
    workspace_id: workspaceId,
    deployment_profile: "local",
    credential_slot: "0123456789abcdef0123456789abcdef",
  };
  fs.writeFileSync(path.join(box.project, ".metergraph", "project.json"), `${JSON.stringify(binding, null, 2)}\n`);
}

test("the environment matrix tells a local container from a remote or CI session", () => {
  const none = { fileExists: () => false };
  const docker = { fileExists: (file) => file === "/.dockerenv" };
  assert.deepEqual(classifyEnvironment({}, none), { kind: "local_shell", remote: false, reason: null });
  assert.deepEqual(classifyEnvironment({}, docker), { kind: "local_container", remote: false, reason: null });
  assert.deepEqual(classifyEnvironment({ REMOTE_CONTAINERS: "true" }, none), { kind: "local_container", remote: false, reason: null });
  assert.deepEqual(classifyEnvironment({ container: "podman" }, none), { kind: "local_container", remote: false, reason: null });
  // A hosted workspace runs in a container too, and it is still remote.
  assert.deepEqual(classifyEnvironment({ CODESPACES: "true" }, docker), { kind: "cloud_workspace", remote: true, reason: "cloud_workspace" });
  assert.deepEqual(classifyEnvironment({ SSH_TTY: "/dev/pts/1" }, docker), { kind: "ssh_session", remote: true, reason: "ssh_session" });
  assert.deepEqual(classifyEnvironment({ CI: "true" }, none), { kind: "ci", remote: true, reason: "ci_environment" });
  assert.deepEqual(classifyEnvironment({ CI: "false", SSH_CLIENT: "" }, none).kind, "local_shell");
});

test("a remote agent with a Metadata key reads usage after verifying origin, workspace, scope and capabilities", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const before = server.requests.length;
    const { run, result } = await read(box, ["usage"], keyed(server));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.credential, "agent_key");
    assert.equal(result.data.environment, "ssh_session");
    assert.equal(result.data.origin, server.origin);
    assert.deepEqual(result.data.workspace, { id: WORKSPACE_A, slug: "example-workspace", name: "Example Workspace" });
    assert.deepEqual(result.data.scopes, ["agent:metadata"]);
    assert.ok(result.data.notices.includes("workspace_not_pinned"));
    assert.notEqual(result.data.result, null);
    // The unauthenticated probe comes first; the key is sent only afterwards,
    // only as a bearer header, and only to the verified documents and the read.
    assert.deepEqual(sent(server, before), [
      "GET /v1/deployment",
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
      "GET /v1/agent/usage",
    ]);
    const requests = server.requests.slice(before);
    assert.equal(bearerOf(requests[0]), null);
    for (const request of requests.slice(1)) assert.equal(bearerOf(request), `Bearer ${KEY}`);
    // A key path creates nothing: no binding, no config directory, no key.
    assert.deepEqual(filesUnder(box.project), []);
    assert.equal(fs.existsSync(box.config), false);
  });
});

test("routes, traces, context, capabilities and status work with a key, and reruns change nothing", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    for (const command of ["routes", "traces", "context", "capabilities"]) {
      const { run, result } = await read(box, [command, "--workspace", WORKSPACE_A], keyed(server, { CI: "true" }));
      assert.equal(run.code, 0, `${command}: ${run.stdout}`);
      assert.equal(result.data.credential, "agent_key");
      assert.equal(result.data.environment, "ssh_session");
      assert.ok(!result.data.notices.includes("workspace_not_pinned"), command);
    }
    const { run, result } = await read(box, ["status"], keyed(server));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.credential, "agent_key");
    assert.equal(result.data.authenticated, true);
    assert.deepEqual(result.data.workspace, { intended: null, actual: WORKSPACE_A, match: null, slug: "example-workspace", name: "Example Workspace" });
    // A key alone binds nothing, so the project is not configured.
    assert.equal(result.data.configured, false);
    assert.equal(result.data.deployment_profile_verified, true);
    assert.equal(result.data.content_access, false);
    assert.deepEqual(filesUnder(box.project), []);
  });
});

test("a key for another workspace than the pinned or bound one is refused before any read", async () => {
  await withServer({}, async (server) => {
    const pinned = sandbox();
    let before = server.requests.length;
    let { run, result } = await read(pinned, ["usage", "--workspace", WORKSPACE_B], keyed(server));
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "workspace_context_mismatch");
    assert.equal(result.data.next_action.kind, "use_workspace_key");
    assert.deepEqual(result.data.next_action.workspace, { id: WORKSPACE_B });
    assert.ok(!sent(server, before).includes("GET /v1/agent/usage"));

    // A binding committed to the repository pins the workspace on a machine
    // that has no saved sign in.
    const bound = sandbox();
    bindProject(bound, server.origin, WORKSPACE_B);
    before = server.requests.length;
    ({ run, result } = await read(bound, ["usage"], keyed(server)));
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "workspace_context_mismatch");
    assert.ok(!sent(server, before).includes("GET /v1/agent/usage"));

    const right = sandbox();
    bindProject(right, server.origin, WORKSPACE_A);
    ({ run, result } = await read(right, ["usage"], keyed(server)));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.credential, "agent_key");
    assert.ok(!result.data.notices.includes("workspace_not_pinned"));
  });
});

test("unknown, revoked, insufficient and broader keys fail closed with a precise next action", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    let { run, result } = await read(box, ["usage"], keyed(server, { METERGRAPH_AGENT_TOKEN: OTHER_KEY }));
    assert.equal(run.code, 12);
    assert.equal(result.error.reason, "agent_key_rejected");
    assert.equal(result.data.next_action.kind, "replace_agent_key");
    assert.equal(result.data.next_action.url, `${server.origin}/#api-keys`);

    // Revoked between verification and the read.
    server.behavior.readStatus = 401;
    ({ run, result } = await read(box, ["usage"], keyed(server)));
    assert.equal(run.code, 12);
    assert.equal(result.error.reason, "agent_key_rejected");
    server.behavior.readStatus = 200;

    // Valid, but without Metadata access (for example an ingest key).
    server.behavior.bearerStatus = 403;
    ({ run, result } = await read(box, ["usage"], keyed(server)));
    assert.equal(run.code, 15);
    assert.equal(result.error.reason, "agent_key_insufficient_scope");
    assert.equal(result.data.next_action.kind, "replace_agent_key");
    server.behavior.bearerStatus = 200;

    // A Replay key, or one mixing roles, is never used, never "reduced".
    const plain = server.behavior.workspace;
    for (const scopes of [["agent:read", "agent:replay"], ["agent:metadata", "agent:read"]]) {
      server.behavior.workspace = (doc) => ({ ...plain(doc), access: { scopes } });
      const before = server.requests.length;
      ({ run, result } = await read(box, ["usage"], keyed(server)));
      assert.equal(run.code, 11);
      assert.equal(result.error.reason, "scope_mismatch");
      assert.equal(result.data.next_action.kind, "use_metadata_only_key");
      assert.ok(!sent(server, before).includes("GET /v1/agent/usage"));
    }
  });
});

test("a malformed key or origin variable stops before any request and never echoes the value", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const before = server.requests.length;
    for (const value of [`Bearer ${KEY}`, `${KEY}\n${KEY}`, "short"]) {
      const { run, result } = await read(box, ["usage"], keyed(server, { METERGRAPH_AGENT_TOKEN: value }));
      assert.equal(run.code, 2);
      assert.equal(result.error.reason, "agent_token_malformed");
      assert.equal(result.data.next_action.kind, "fix_agent_key");
    }
    // status probes the origin unauthenticated first; a malformed key still
    // stops before that.
    const status = await read(box, ["status"], keyed(server, { METERGRAPH_AGENT_TOKEN: `Bearer ${KEY}` }));
    assert.equal(status.run.code, 2);
    assert.equal(status.result.error.reason, "agent_token_malformed");
    const { run, result } = await read(box, ["usage"], keyed(server, { METERGRAPH_URL: "http://hunter2.example.com" }));
    assert.equal(run.code, 2);
    assert.equal(result.error.reason, "metergraph_url_invalid");
    assert.deepEqual(sent(server, before), []);
  });
});

test("a key is never sent to a non-hosted origin taken only from a committed binding", async () => {
  await withServer({}, async (server) => {
    // The repository names a server; this machine never signed in to it and
    // the person did not confirm it with --url or METERGRAPH_URL.
    const box = sandbox();
    bindProject(box, server.origin, WORKSPACE_A);
    const before = server.requests.length;
    const { run, result } = await read(box, ["usage"], keyed(server, { METERGRAPH_URL: "" }));
    assert.equal(run.code, 8);
    assert.equal(result.error.reason, "agent_key_origin_unconfirmed");
    assert.equal(result.data.next_action.kind, "confirm_origin");
    assert.deepEqual(sent(server, before), []);

    // Confirming the same origin with --url lets the key through.
    const confirmed = await read(box, ["usage", "--url", server.origin], keyed(server, { METERGRAPH_URL: "" }));
    assert.equal(confirmed.run.code, 0, confirmed.run.stdout);
    assert.equal(confirmed.result.data.credential, "agent_key");
  });
});

test("a project bound to another origin is never sent the key", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    bindProject(box, "https://metergraph.example.com", WORKSPACE_A);
    const before = server.requests.length;
    const { run, result } = await read(box, ["usage"], keyed(server));
    assert.equal(run.code, 8);
    assert.equal(result.error.reason, "bound_to_other_origin");
    assert.equal(result.data.next_action.kind, "match_project_binding");
    assert.deepEqual(sent(server, before), []);
  });
});

test("a saved sign in wins over the environment key, and an explicit key file wins over both", { skip: isWindows }, async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const signedIn = await login(assert, box, server);
    assert.equal(signedIn.run.code, 0, signedIn.run.stdout);

    let before = server.requests.length;
    let { run, result } = await read(box, ["usage"], { METERGRAPH_AGENT_TOKEN: KEY });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.credential, "oauth_grant");
    assert.ok(result.data.notices.includes("agent_key_not_used"));
    assert.ok(server.requests.slice(before).every((request) => bearerOf(request) !== `Bearer ${KEY}`));

    const keyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mg-key-")));
    fs.chmodSync(keyDir, 0o700);
    const keyFile = path.join(keyDir, "agent-key");
    fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    try {
      before = server.requests.length;
      ({ run, result } = await read(box, ["usage", "--agent-token-file", keyFile], {}));
      assert.equal(run.code, 0, run.stdout);
      assert.equal(result.data.credential, "agent_key");
      assert.ok(server.requests.slice(before).some((request) => bearerOf(request) === `Bearer ${KEY}`));

      // A key file others can read is refused without showing its path.
      fs.chmodSync(keyFile, 0o644);
      ({ run, result } = await read(box, ["usage", "--agent-token-file", keyFile], {}));
      assert.equal(run.code, 9);
      assert.equal(result.error.reason, "agent_token_file_permissions_unsafe");
      assert.ok(!run.stdout.includes(keyDir));
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });
});

test("with no sign in and no key, the next action follows the environment", async () => {
  const box = sandbox();
  for (const [env, kind, environment] of [
    [{ CI: "true" }, "use_agent_key", "ci"],
    [SSH, "use_agent_key", "ssh_session"],
    [{ CODESPACES: "true" }, "use_agent_key", "cloud_workspace"],
  ]) {
    const run = await runCli(["--json", "usage", "--project", box.project, "--config-dir", box.config], {
      offline: true,
      env: { ...LOCAL_ENV, ...env },
    });
    const { result } = checked(assert, run, { box });
    assert.equal(run.code, 12);
    assert.equal(result.error.reason, "not_signed_in");
    assert.equal(result.data.next_action.kind, kind);
    assert.equal(result.data.next_action.environment, environment);
    assert.equal(result.data.next_action.credential_env, "METERGRAPH_AGENT_TOKEN");
    // The hosted service has a sign up page; the person starts there.
    assert.equal(result.data.next_action.person_steps[0].action, "sign_up_or_sign_in");
    assert.equal(result.data.next_action.person_steps[0].url,
      "https://app.metergraph.dev/v1/auth/signup?return_to=%2F%23api-keys");
  }
  const run = await runCli(["--json", "usage", "--project", box.project, "--config-dir", box.config], {
    offline: true,
    env: LOCAL_ENV,
  });
  const { result } = checked(assert, run, { box });
  assert.equal(result.data.next_action.kind, "login");
  assert.equal(result.data.next_action.alternative.kind, "use_agent_key");
});

test("grouped usage reads with a Metadata key from the environment or a key file", { skip: isWindows }, async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    // From METERGRAPH_AGENT_TOKEN in a remote session: ranking, comparison and
    // metadata grouping all go through the grouped read with the key.
    const before = server.requests.length;
    let { run, result } = await read(box, ["usage", "--group-by", "route", "--today", "--compare", "previous"], keyed(server));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.credential, "agent_key");
    assert.equal(result.data.result.source, "usage_aggregates");
    assert.equal(result.data.result.comparison.mode, "previous");
    assert.deepEqual(sent(server, before), [
      "GET /v1/deployment",
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
      "GET /v1/agent/usage/aggregates",
      "GET /v1/agent/usage/aggregates",
    ]);
    for (const request of server.requests.slice(before + 1)) assert.equal(bearerOf(request), `Bearer ${KEY}`);
    assert.deepEqual(filesUnder(box.project), []);

    // From --agent-token-file, grouped by a metadata key.
    const keyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mg-key-")));
    fs.chmodSync(keyDir, 0o700);
    const keyFile = path.join(keyDir, "agent-key");
    fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    try {
      ({ run, result } = await read(
        box,
        ["usage", "--group-by", "metadata.prompt_id", "--agent-token-file", keyFile],
        { ...SSH, METERGRAPH_URL: server.origin },
      ));
      assert.equal(run.code, 0, run.stdout);
      assert.equal(result.data.credential, "agent_key");
      assert.deepEqual(result.data.result.group_by, ["metadata.prompt_id"]);
      assert.ok(result.data.result.metadata_groups);

      // A refused key on the grouped read gets the key next action, not "run login".
      ({ run, result } = await read(
        box,
        ["usage", "--group-by", "route", "--today"],
        keyed(server, { METERGRAPH_AGENT_TOKEN: OTHER_KEY }),
      ));
      assert.notEqual(run.code, 0);
      assert.equal(result.data.next_action.kind, "replace_agent_key");
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });
});

test("in a local container, login and setup offer the key path when the browser cannot open", async () => {
  await withServer({}, async (server) => {
    const container = { REMOTE_CONTAINERS: "true", METERGRAPH_TEST_BROWSER: "unavailable" };
    const box = sandbox();
    const signIn = await login(assert, box, server, [], { browser: "unavailable", env: { REMOTE_CONTAINERS: "true" } });
    assert.equal(signIn.run.code, 10);
    assert.equal(signIn.result.data.environment, "local_container");
    assert.equal(signIn.result.data.next_action.kind, "no_browser");
    assert.equal(signIn.result.data.next_action.alternative.kind, "use_agent_key");

    // setup's own sign in passes the same next action through.
    const setupBox = sandbox();
    const run = await runCli(["--json", "setup", "--runtime", "local", "--skip-skill", "--deployment", "customer-local",
      "--confirm-prerequisites", "--url", server.origin, "--workspace", WORKSPACE_A,
      "--project", setupBox.project, "--config-dir", setupBox.config],
    { imports: [BROWSER], env: { ...LOCAL_ENV, ...container } });
    const { result } = checked(assert, run, { box: setupBox, server });
    assert.equal(result.error.reason, "browser_unavailable");
    assert.equal(result.data.next_action.kind, "no_browser");
    assert.equal(result.data.next_action.alternative.kind, "use_agent_key");
  });
});

test("handoff commands never carry shell syntax from an origin, binding or option", async () => {
  const { shellArg, agentKeyAction, remoteSetupAction } = await import("../src/environment.js");
  const { parseOrigin } = await import("../src/origin.js");
  // Hosts the URL parser accepts but no deployment uses are refused outright,
  // so they can reach neither a binding nor a command.
  for (const host of ["a;id", "a$(id)", "a`id`", "x&y", "a'b", "a(b)"]) {
    assert.equal(parseOrigin(`https://${host}.example.com`), null, host);
  }
  assert.equal(shellArg("https://metergraph.example.com"), "https://metergraph.example.com");
  assert.equal(shellArg("http://[::1]:8080"), "'http://[::1]:8080'");
  assert.equal(shellArg("a'b;c"), "'a'\\''b;c'");
  const local = agentKeyAction({ kind: "ssh_session", remote: true }, "http://[::1]:8080");
  assert.deepEqual(local.then_run, ["metergraph status --url 'http://[::1]:8080' --json", "metergraph usage --url 'http://[::1]:8080' --json"]);
  // No placeholder with < | > that a shell would treat as redirection.
  const setup = remoteSetupAction({ kind: "ci", remote: true }, "https://app.metergraph.dev", {});
  assert.equal(setup.command, "metergraph setup --runtime local --skip-skill");
});

// A deployment that offers managed evaluations, as hosted and the
// customer-local bundle do.
const WITH_EVALUATIONS = (doc) => ({ ...doc, deployment_capabilities: [...doc.deployment_capabilities, "evaluations"] });

test("a Debug key with every permission reads with Metadata requests only, and status reports them", async () => {
  await withServer({ debugTokens: [DEBUG_KEY], capabilities: WITH_EVALUATIONS }, async (server) => {
    const box = sandbox();
    const env = keyed(server, { METERGRAPH_AGENT_TOKEN: DEBUG_KEY });
    let before = server.requests.length;
    let { run, result } = await read(box, ["usage"], env);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(result.data.scopes, ["agent:analysis-run", "agent:eval-preview", "agent:eval-write", "agent:read"]);
    // The same GETs as with a Metadata key: nothing that reads content.
    assert.deepEqual(sent(server, before), [
      "GET /v1/deployment",
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
      "GET /v1/agent/usage",
    ]);

    ({ run, result } = await read(box, ["status"], env));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.content_access, true);
    assert.deepEqual(result.data.access, {
      role: "debug",
      permissions: { allow_evaluation_writes: true, allow_evaluation_previews: true, allow_analysis_starts: true },
      permissions_offered: true,
    });
    before = server.requests.length;
    const human = await runCli(["status", "--project", box.project, "--config-dir", box.config], {
      env: { ...LOCAL_ENV, ...env },
    });
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /Role +Debug/);
    assert.match(human.stdout, /Permissions +Allow evaluation writes, Allow evaluation previews, Allow analysis starts/);
    assert.match(human.stdout, /the read commands never request it/);
    assert.ok(!human.stdout.includes("Writing and testing evaluations"));
    assert.ok(!human.stdout.includes(DEBUG_KEY));
  });
});

test("with a Metadata key, status reports no permissions and says how to grant them", async () => {
  await withServer({ capabilities: WITH_EVALUATIONS }, async (server) => {
    const box = sandbox();
    const { run, result } = await read(box, ["status"], keyed(server));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(result.data.access, {
      role: "metadata",
      permissions: { allow_evaluation_writes: false, allow_evaluation_previews: false, allow_analysis_starts: false },
      permissions_offered: true,
    });
    const human = await runCli(["status", "--project", box.project, "--config-dir", box.config], {
      env: { ...LOCAL_ENV, ...keyed(server) },
    });
    assert.match(human.stdout, /Role +Metadata/);
    assert.match(human.stdout, /Permissions +none/);
    // The fixture is a customer-local deployment: the bundle's own command.
    assert.match(human.stdout, /need the Debug role with Allow evaluation writes, Allow evaluation previews and Allow analysis starts\. From the bundle directory/);
    assert.match(human.stdout, /\.\/bin\/agent-key create --role debug/);
  });
});
