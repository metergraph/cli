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
import { LOCAL_ENV, checked, filesUnder, isWindows, login, sandboxes } from "./auth-helpers.js";
import { runCli } from "./helpers.js";
import { WORKSPACE_A, WORKSPACE_B, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph agent key test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const KEY = "mgak_synthetic_metadata_key_5555555555555555";
const OTHER_KEY = "mgak_synthetic_revoked_key_6666666666666666";
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
  for (const secret of [KEY, OTHER_KEY]) {
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
    assert.deepEqual(result.data.workspace, { id: WORKSPACE_A });
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
    assert.deepEqual(result.data.workspace, { intended: null, actual: WORKSPACE_A, match: null });
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

    // A Debug key is broader than Metadata. It is never used, never "reduced".
    const plain = server.behavior.workspace;
    server.behavior.workspace = (doc) => ({ ...plain(doc), access: { scopes: ["agent:metadata", "agent:read"] } });
    const before = server.requests.length;
    ({ run, result } = await read(box, ["usage"], keyed(server)));
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "scope_mismatch");
    assert.equal(result.data.next_action.kind, "use_metadata_only_key");
    assert.ok(!sent(server, before).includes("GET /v1/agent/usage"));
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
    const { run, result } = await read(box, ["usage"], keyed(server, { METERGRAPH_URL: "http://hunter2.example.com" }));
    assert.equal(run.code, 2);
    assert.equal(result.error.reason, "metergraph_url_invalid");
    assert.deepEqual(sent(server, before), []);
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
