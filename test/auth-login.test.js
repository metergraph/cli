// Runs "metergraph login" and "metergraph logout" as subprocesses against the
// synthetic loopback service in test/fixtures/oauth-server.js, with a test
// preload standing in for the person's browser. This is protocol and file
// proof only. It does not prove the real service, a real browser, real
// accounts or real workspace consent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  BROWSER,
  FAULTS,
  LOCAL_ENV,
  browserLog,
  checked,
  completeInBrowser,
  credentialFiles,
  filesUnder,
  isWindows,
  login,
  logout,
  readBindingFile,
  sandboxes,
  startCli,
} from "./auth-helpers.js";
import { runCli } from "./helpers.js";
import { WORKSPACE_A, WORKSPACE_B, startOAuthServer } from "./fixtures/oauth-server.js";

const isRoot = process.getuid?.() === 0;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph login test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const BINDING = ".metergraph/project.json";
const RECEIPT = ".metergraph/skill-installations.json";
const RECEIPT_CONTENT = '{"synthetic":"receipt kept as is"}\n';

async function withServer(behavior, work) {
  const server = await startOAuthServer(behavior);
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

function assertFailure(result, outcome, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.outcome, outcome);
  assert.equal(result.error.code, outcome);
  assert.equal(result.error.reason, reason);
  assert.equal(typeof result.error.message, "string");
  assert.equal(result.data.authenticated, false);
  assert.equal(result.data.configured, false);
  assert.deepEqual(result.data.scopes, []);
}

function assertNothingBound(box) {
  assert.ok(!fs.existsSync(path.join(box.project, BINDING)), "a binding was written");
  assert.deepEqual(
    credentialFiles(box).filter((name) => name.endsWith(".json")),
    [],
    "a grant was saved",
  );
}

const sha256url = (text) => createHash("sha256").update(text).digest("base64url");

test("a fresh login binds the verified workspace with a Metadata-only grant", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    fs.mkdirSync(path.join(box.project, ".metergraph"));
    fs.writeFileSync(path.join(box.project, RECEIPT), RECEIPT_CONTENT);

    const { run, result } = await login(assert, box, server);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.command, "login");
    assert.equal(result.error, null);
    assert.deepEqual(result.data, {
      origin: server.origin,
      runtime: "local",
      deployment_profile: "local",
      workspace: { id: WORKSPACE_A },
      scopes: ["agent:metadata"],
      authenticated: true,
      configured: true,
      status: "signed_in",
      binding: BINDING,
      credential_protection: isWindows ? "dpapi" : "owner_only_file",
      previous_grant_revocation: null,
      next_action: result.data.next_action,
    });
    assert.equal(result.data.next_action.kind, "connected");
    // Both bearer documents were served with the service's contract string,
    // and the CLI's own output kept its numeric schema.
    assert.equal(server.served.workspace.schema_version, "metergraph.agent-access/v1");
    assert.equal(server.served.capabilities.schema_version, "metergraph.agent-access/v1");
    assert.equal(result.schema_version, 1);

    // The binding names the context and a slot, and nothing secret.
    const binding = readBindingFile(box);
    assert.deepEqual(Object.keys(binding).sort(), [
      "credential_slot",
      "deployment_profile",
      "origin",
      "schema_version",
      "workspace_id",
    ]);
    assert.equal(binding.origin, server.origin);
    assert.equal(binding.workspace_id, WORKSPACE_A);
    assert.equal(binding.deployment_profile, "local");
    assert.match(binding.credential_slot, /^[0-9a-f]{32}$/);
    assert.equal(fs.readFileSync(path.join(box.project, RECEIPT), "utf8"), RECEIPT_CONTENT);
    assert.deepEqual(filesUnder(box.project), [BINDING, RECEIPT]);

    // The grant lives only in the private config directory.
    assert.deepEqual(credentialFiles(box), [`${binding.credential_slot}.json`]);
    const stored = path.join(box.config, "credentials", `${binding.credential_slot}.json`);
    if (isWindows) {
      const raw = fs.readFileSync(stored, "utf8");
      for (const secret of server.issued) assert.ok(!raw.includes(secret), "a token is stored without DPAPI");
    } else {
      assert.equal(fs.statSync(box.config).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(box.config, "credentials")).mode & 0o777, 0o700);
      assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
    }

    // The exact protocol, in order, on one origin.
    assert.deepEqual(
      server.requests.map((request) => `${request.method} ${request.path}`),
      [
        "GET /healthz",
        "GET /v1/deployment",
        "GET /v1/agent/capabilities",
        "GET /.well-known/oauth-protected-resource/v1/agent/mcp",
        "GET /.well-known/oauth-authorization-server/v1/oauth",
        "POST /v1/oauth/register",
        "GET /v1/oauth/authorize",
        "POST /v1/oauth/token",
        "GET /v1/agent/workspace",
        "GET /v1/agent/capabilities",
      ],
    );
    for (const request of server.requests) {
      assert.equal(request.headers.cookie, undefined);
      const sentScopes = `${JSON.stringify(request.query)} ${request.body}`;
      assert.ok(!sentScopes.includes("agent:read") && !sentScopes.includes("agent:replay"), "Debug or Replay was requested");
      if (request.headers.authorization !== undefined) {
        assert.ok(["/v1/agent/workspace", "/v1/agent/capabilities"].includes(request.path));
        assert.equal(request.method, "GET");
      }
    }

    // PKCE and state: the browser got the challenge and state, the token
    // request carried the matching verifier, and nothing else carried either.
    const [opened] = browserLog(box);
    assert.equal(opened.argCount, isWindows ? 2 : 1, "the launcher got more than the URL");
    const authorize = new URL(opened.url);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${server.origin}/v1/oauth/authorize`);
    const params = Object.fromEntries(authorize.searchParams);
    assert.equal(params.scope, "agent:metadata");
    assert.equal(params.code_challenge_method, "S256");
    assert.equal(params.resource, server.resource);
    assert.match(params.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(params.redirect_uri, /^http:\/\/127\.0\.0\.1:[0-9]+\/callback$/);
    const form = new URLSearchParams(server.requestsTo("/v1/oauth/token")[0].body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(sha256url(form.get("code_verifier")), params.code_challenge);
    assert.equal(form.get("redirect_uri"), params.redirect_uri);
    assert.equal(form.get("client_id"), params.client_id);
    assert.equal(form.get("resource"), server.resource);
    assert.ok(!opened.url.includes(form.get("code_verifier")));
  });
});

test("a rerun on a signed in project reuses the grant without a browser or new client", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    const binding = fs.readFileSync(path.join(box.project, BINDING));
    const before = server.requests.length;

    const { run, result } = await login(assert, box, server);
    assert.equal(run.code, 0);
    assert.equal(result.data.status, "reused");
    assert.deepEqual(result.data.workspace, { id: WORKSPACE_A });
    assert.deepEqual(
      server.requests.slice(before).map((request) => request.path),
      ["/v1/agent/workspace", "/v1/agent/capabilities"],
    );
    assert.equal(browserLog(box).filter((entry) => entry.url).length, 1, "a browser was opened again");
    assert.deepEqual(fs.readFileSync(path.join(box.project, BINDING)), binding);

    const text = await login(assert, box, server, [], { json: false });
    assert.equal(text.run.code, 0);
    assert.match(text.run.stdout, /Status: already signed in/);
    assert.match(text.run.stdout, /Scopes: agent:metadata/);

    // An agent's JSON rerun needs no URL, so --no-browser is not refused.
    const quiet = await login(assert, box, server, ["--no-browser"]);
    assert.equal(quiet.run.code, 0);
    assert.equal(quiet.result.data.status, "reused");
    const switched = await login(assert, box, server, ["--no-browser", "--reconnect"]);
    assert.equal(switched.run.code, 6);
    assertFailure(switched.result, "unsupported", "no_browser_requires_terminal");
    assert.equal(browserLog(box).filter((entry) => entry.url).length, 1, "a browser was opened again");
    assert.deepEqual(fs.readFileSync(path.join(box.project, BINDING)), binding);
  });
});

test("JSON --no-browser is refused once a saved grant no longer works, without a browser", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    for (const grant of [...server.state.refresh.values(), ...server.state.access.values()]) grant.revoked = true;
    const { run, result } = await login(assert, box, server, ["--no-browser"]);
    assert.equal(run.code, 6);
    assertFailure(result, "unsupported", "no_browser_requires_terminal");
    assert.equal(result.data.next_action.kind, "run_in_terminal");
    assert.equal(browserLog(box).filter((entry) => entry.url).length, 1, "a browser was opened again");
  });
});

test("an expected workspace the browser does not grant is refused, revoked and not saved", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ["--workspace", WORKSPACE_B.toUpperCase()]);
    assert.equal(run.code, 11);
    assertFailure(result, "verification_failed", "workspace_mismatch");
    assertNothingBound(box);
    assert.equal(server.requestsTo("/v1/oauth/revoke").length, 1);
    assert.ok([...server.state.refresh.values()].every((grant) => grant.revoked), "the grant was not revoked");
    assert.equal(server.requestsTo("/v1/agent/workspace").length, 0);

    const matching = await login(assert, sandbox(), server, ["--workspace", WORKSPACE_A]);
    assert.equal(matching.run.code, 0);
  });
});

test("a bound project is never switched silently, only with --reconnect", async () => {
  await withServer({}, async (server) => {
    const other = await startOAuthServer();
    try {
      const box = sandbox();
      assert.equal((await login(assert, box, server)).run.code, 0);
      const original = fs.readFileSync(path.join(box.project, BINDING));
      const oldSlot = readBindingFile(box).credential_slot;

      const otherOrigin = await login(assert, box, other);
      assert.equal(otherOrigin.run.code, 8);
      assertFailure(otherOrigin.result, "conflict", "bound_to_other_origin");
      assert.equal(otherOrigin.result.data.next_action.kind, "reconnect");
      assert.equal(other.requests.length, 0, "the other origin was contacted");

      const before = server.requests.length;
      const otherWorkspace = await login(assert, box, server, ["--workspace", WORKSPACE_B]);
      assert.equal(otherWorkspace.run.code, 8);
      assertFailure(otherWorkspace.result, "conflict", "bound_to_other_workspace");
      assert.equal(server.requests.length, before, "a request was made before refusing");

      // The saved grant stops working and the browser now picks another workspace.
      for (const grant of [...server.state.refresh.values(), ...server.state.access.values()]) grant.revoked = true;
      server.behavior.workspaceId = WORKSPACE_B;
      const revokesBefore = server.requestsTo("/v1/oauth/revoke").length;
      const switched = await login(assert, box, server);
      assert.equal(switched.run.code, 8);
      assertFailure(switched.result, "conflict", "bound_to_other_workspace");
      assert.deepEqual(fs.readFileSync(path.join(box.project, BINDING)), original);
      assert.deepEqual(credentialFiles(box), [`${oldSlot}.json`]);
      assert.equal(server.requestsTo("/v1/oauth/revoke").length, revokesBefore + 1, "the unwanted grant was kept");

      const reconnected = await login(assert, box, server, ["--reconnect"]);
      assert.equal(reconnected.run.code, 0);
      assert.equal(reconnected.result.data.status, "reconnected");
      assert.deepEqual(reconnected.result.data.workspace, { id: WORKSPACE_B });
      assert.equal(reconnected.result.data.previous_grant_revocation, "accepted");
      const binding = readBindingFile(box);
      assert.equal(binding.workspace_id, WORKSPACE_B);
      assert.notEqual(binding.credential_slot, oldSlot);
      assert.deepEqual(credentialFiles(box), [`${binding.credential_slot}.json`]);
    } finally {
      await other.close();
    }
  });
});

test("cloud runtimes, remote sessions and JSON without a browser get a handoff before anything else", async () => {
  const cases = [
    [["--runtime", "cloud"], {}, "runtime_not_supported", "connection_guide"],
    [["--runtime", "cloud-no-shell"], {}, "runtime_not_supported", "connection_guide"],
    [["--runtime", "local"], { SSH_CONNECTION: "SYNTHETIC_HEADER_MARKER 22" }, "ssh_session", "connection_guide"],
    [["--runtime", "local"], { CODESPACES: "true" }, "cloud_workspace", "connection_guide"],
    [["--runtime", "local"], { CI: "true" }, "ci_environment", "connection_guide"],
    [["--runtime", "local", "--no-browser"], {}, "no_browser_requires_terminal", "run_in_terminal"],
  ];
  for (const [flags, env, reason, next] of cases) {
    const box = sandbox();
    const args = ["--json", "login", ...flags, "--url", "http://127.0.0.1:9", "--project", box.project, "--config-dir", box.config];
    const run = await runCli(args, { offline: true, env: { ...LOCAL_ENV, ...env } });
    const { result } = checked(assert, run, { box });
    assert.equal(run.code, 6, reason);
    assertFailure(result, "unsupported", reason);
    assert.equal(result.data.next_action.kind, next);
    assert.equal(fs.existsSync(box.config), false, "the config directory was created");
    assert.deepEqual(filesUnder(box.project), []);
  }
});

test("--no-browser prints the URL for a person on stderr and waits for the callback", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const cli = startCli([
      "login",
      "--runtime",
      "local",
      "--no-browser",
      "--url",
      server.origin,
      "--project",
      box.project,
      "--config-dir",
      box.config,
    ]);
    const url = await cli.waitFor(({ stderr }) =>
      stderr.split("\n").find((line) => line.startsWith(`${server.origin}/v1/oauth/authorize?`)),
    );
    assert.equal(await completeInBrowser(url), 200);
    const run = await cli.done;
    checked(assert, run, { box, server, json: false });
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stderr, /Open this URL in a browser on this machine/);
    assert.match(run.stdout, /Status: signed in/);
    assert.match(run.stdout, /Binding: \.metergraph\/project\.json/);
    assert.equal(readBindingFile(box).workspace_id, WORKSPACE_A);
  });
});

test("denied, abandoned and unopenable browser sign ins save nothing", async () => {
  await withServer({ authorize: "deny" }, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server);
    assert.equal(run.code, 10);
    assertFailure(result, "authorization_failed", "access_denied");
    assert.equal(server.requestsTo("/v1/oauth/token").length, 0);
    assertNothingBound(box);
  });
  await withServer({}, async (server) => {
    const box = sandbox();
    const started = Date.now();
    const { run, result } = await login(assert, box, server, ["--timeout-ms", "1000"], { browser: "idle" });
    assert.equal(run.code, 10);
    assertFailure(result, "authorization_failed", "timeout");
    assert.ok(Date.now() - started < 10000);
    assertNothingBound(box);

    // The wait is armed before the launcher runs. With the default five
    // minute timeout, a launcher failure must still end the process at once:
    // a timer or listener left behind would keep it alive past the harness
    // limit.
    const failedAt = Date.now();
    const unavailableBox = sandbox();
    const unavailable = await login(assert, unavailableBox, server, [], { browser: "unavailable" });
    assert.equal(unavailable.run.code, 10);
    assertFailure(unavailable.result, "authorization_failed", "browser_unavailable");
    assert.equal(unavailable.result.data.next_action.kind, "no_browser");
    assert.ok(Date.now() - failedAt < 10000, "work was left pending after the launcher failed");
    assertNothingBound(unavailableBox);
    assert.equal(server.requestsTo("/v1/oauth/authorize").length, 0, "no browser reached the service");
    assert.equal(server.requestsTo("/v1/oauth/token").length, 0);
  });
});

test("a callback that arrives before the launcher reports success is accepted, not refused", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    // The synthetic browser finishes the whole round trip, callback included,
    // before the launcher's spawn event, so a listener armed only after the
    // browser opened would answer 503 and then time out.
    const { run, result } = await login(assert, box, server, ["--timeout-ms", "5000"], { browser: "callback-first" });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.status, "signed_in");
    assert.deepEqual(browserLog(box).find((entry) => entry.statuses)?.statuses, [200]);
    assert.equal(server.requestsTo("/v1/oauth/token").length, 1);
  });
});

test("forged, misaddressed and repeated callbacks cannot end or reuse the flow", async () => {
  for (const browser of ["wrong-host-first", "forged-first", "duplicate"]) {
    await withServer({}, async (server) => {
      const box = sandbox();
      const { run } = await login(assert, box, server, [], { browser });
      assert.equal(run.code, 0, browser);
      assert.equal(server.requestsTo("/v1/oauth/token").length, 1, "the code was exchanged more than once");
      const statuses = browserLog(box).find((entry) => entry.statuses)?.statuses;
      if (statuses && browser !== "duplicate") assert.deepEqual(statuses, [400, 200]);
      if (statuses && browser === "duplicate") {
        assert.equal(statuses[0], 200);
        assert.notEqual(statuses[1], 200);
      }
    });
  }
});

test("Ctrl+C while waiting for the browser cancels cleanly with one JSON result", { skip: isWindows }, async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const cli = startCli(
      ["--json", "login", "--runtime", "local", "--url", server.origin, "--project", box.project, "--config-dir", box.config],
      { imports: [BROWSER], env: { METERGRAPH_TEST_BROWSER: "idle", METERGRAPH_TEST_BROWSER_LOG: box.log } },
    );
    await cli.waitFor(() => browserLog(box).length > 0);
    cli.child.kill("SIGINT");
    const run = await cli.done;
    const { result } = checked(assert, run, { box, server });
    assert.equal(run.code, 10);
    assertFailure(result, "authorization_failed", "cancelled");
    assertNothingBound(box);
  });
});

test("--signup uses the hosted sign up page and is refused for other profiles", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ["--signup"]);
    assert.equal(run.code, 6);
    assertFailure(result, "unsupported", "signup_unsupported");
    assert.equal(server.requestsTo("/v1/oauth/register").length, 0);
    assert.equal(fs.existsSync(path.join(box.config, "credentials")), true, "the store is checked before the network");
  });
  await withServer({ profile: "managed" }, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ["--signup"]);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.deployment_profile, "managed");
    const opened = new URL(browserLog(box)[0].url);
    assert.equal(`${opened.origin}${opened.pathname}`, `${server.origin}/v1/auth/signup`);
    assert.ok(opened.searchParams.get("return_to").startsWith("/v1/oauth/authorize?"));
  });
});

test("unsupported or tampered metadata stops before registration and never falls back", async () => {
  const cases = [
    [{ prm: () => null, asm: () => null }, "oauth_metadata_missing"],
    [{ asm: (doc) => ({ ...doc, authorization_endpoint: "https://evil.example.com/authorize" }) }, "endpoint_not_allowed"],
    [{ asm: (doc) => ({ ...doc, scopes_supported: ["agent:read"] }) }, "metadata_scope_unsupported"],
  ];
  for (const [behavior, reason] of cases) {
    await withServer(behavior, async (server) => {
      const box = sandbox();
      const { run, result } = await login(assert, box, server);
      assert.equal(run.code, 6, reason);
      assertFailure(result, "unsupported", reason);
      assert.equal(server.requestsTo("/v1/oauth/register").length, 0);
      assert.equal(browserLog(box).length, 0, "a browser was opened");
      assertNothingBound(box);
    });
  }
});

test("grants with the wrong scope, client, resource or issuer are not saved", async () => {
  const cases = [
    [{ token: (doc) => ({ ...doc, scope: "agent:metadata agent:read" }) }, "scope_mismatch"],
    [{ claims: (claims) => ({ ...claims, client_id: "client-someone-else" }) }, "client_mismatch"],
    [{ claims: (claims) => ({ ...claims, aud: "https://evil.example.com/v1/agent/mcp" }) }, "resource_mismatch"],
    [{ claims: (claims) => ({ ...claims, iss: "https://evil.example.com/v1/oauth" }) }, "issuer_mismatch"],
  ];
  for (const [behavior, reason] of cases) {
    await withServer(behavior, async (server) => {
      const box = sandbox();
      const { run, result } = await login(assert, box, server);
      assert.equal(run.code, 11, reason);
      assertFailure(result, "verification_failed", reason);
      assert.equal(server.requestsTo("/v1/agent/workspace").length, 0);
      assertNothingBound(box);
    });
  }
});

test("server-verified context must match exactly, and a refused grant is revoked", async () => {
  const cases = [
    // The service sends its contract string. A numeric version, such as the
    // CLI's own output schema number, is a different contract.
    [{ workspace: (doc) => ({ ...doc, schema_version: 1 }) }, "workspace_response_invalid"],
    [{ capabilities: (doc) => ({ ...doc, schema_version: 1 }) }, "capabilities_response_invalid"],
    [{ workspace: (doc) => ({ ...doc, workspace: { ...doc.workspace, id: WORKSPACE_B } }) }, "workspace_context_mismatch"],
    [{ workspace: (doc) => ({ ...doc, access: { scopes: ["agent:metadata", "agent:read"] } }) }, "scope_mismatch"],
    [{ workspace: (doc) => ({ ...doc, content: { captured: true, included: true } }) }, "content_access_granted"],
    [
      { workspace: (doc) => ({ ...doc, provenance: { ...doc.provenance, deployment_profile: "managed" } }) },
      "profile_mismatch",
    ],
    [
      {
        capabilities: (doc) => ({
          ...doc,
          agent: { ...doc.agent, trace_replay: { ...doc.agent.trace_replay, available: true } },
        }),
      },
      "content_access_granted",
    ],
    [{ capabilities: (doc) => ({ ...doc, deployment_profile: "byoc-core" }) }, "profile_mismatch"],
  ];
  for (const [behavior, reason] of cases) {
    await withServer(behavior, async (server) => {
      const box = sandbox();
      const { run, result } = await login(assert, box, server);
      assert.equal(run.code, 11, reason);
      assertFailure(result, "verification_failed", reason);
      assert.equal(server.requestsTo("/v1/oauth/revoke").length, 1, `${reason}: the grant was not revoked`);
      assertNothingBound(box);
    });
  }
});

test("an unsafe config directory or project binding stops login before any request", async () => {
  await withServer({}, async (server) => {
    if (!isWindows && !isRoot) {
      const open = sandbox();
      fs.mkdirSync(open.config, { mode: 0o755 });
      fs.chmodSync(open.config, 0o755);
      const { run, result } = await login(assert, open, server);
      assert.equal(run.code, 8);
      assertFailure(result, "conflict", "credential_permissions_unsafe");
      assert.equal(fs.statSync(open.config).mode & 0o777, 0o755, "permissions were changed");
    }
    if (!isWindows) {
      const linked = sandbox();
      const real = path.join(linked.base, "real config");
      fs.mkdirSync(real, { mode: 0o700 });
      fs.symlinkSync(real, linked.config, "dir");
      const { run, result } = await login(assert, linked, server);
      assert.equal(run.code, 8);
      assertFailure(result, "conflict", "credential_path_unsafe");
      assert.deepEqual(fs.readdirSync(real), []);
    }

    const invalid = sandbox();
    fs.mkdirSync(path.join(invalid.project, ".metergraph"));
    const tampered = JSON.stringify({ schema_version: 1, origin: server.origin, token: "SYNTHETIC_BODY_MARKER" });
    fs.writeFileSync(path.join(invalid.project, BINDING), tampered);
    const { run, result } = await login(assert, invalid, server);
    assert.equal(run.code, 8);
    assertFailure(result, "conflict", "binding_invalid");
    assert.equal(fs.readFileSync(path.join(invalid.project, BINDING), "utf8"), tampered);
    assert.equal(server.requests.length, 0, "a request was made before refusing");
  });
});

test("logout revokes the grant, removes local sign in and keeps unrelated files", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    fs.writeFileSync(path.join(box.project, RECEIPT), RECEIPT_CONTENT);
    const unrelated = `${"f".repeat(32)}.json`;
    fs.writeFileSync(path.join(box.config, "credentials", unrelated), "{}", { mode: 0o600 });

    const { run, result } = await logout(assert, box, server);
    assert.equal(run.code, 0);
    assert.equal(result.command, "logout");
    assert.deepEqual(result.data, {
      origin: server.origin,
      workspace: { id: WORKSPACE_A },
      local_credentials: "removed",
      binding: "removed",
      revocation: "accepted",
      authenticated: false,
    });
    assert.ok([...server.state.refresh.values()].every((grant) => grant.revoked));
    const form = new URLSearchParams(server.requestsTo("/v1/oauth/revoke")[0].body);
    assert.equal(form.get("token_type_hint"), "refresh_token");
    assert.ok(form.get("client_id"));
    assert.deepEqual(filesUnder(box.project), [RECEIPT]);
    assert.deepEqual(credentialFiles(box), [unrelated]);

    // Nothing left to sign out of: no request at all.
    const again = await logout(assert, box, null, { offline: true });
    assert.equal(again.run.code, 0);
    assert.equal(again.result.data.binding, "none");
    assert.equal(again.result.data.revocation, "not_attempted");
  });
});

test("logout reports unconfirmed revocation separately from local removal", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    server.behavior.revokeStatus = 503;
    const { run, result } = await logout(assert, box, server);
    assert.equal(run.code, 13);
    assert.equal(result.outcome, "revocation_unconfirmed");
    assert.equal(result.data.local_credentials, "removed");
    assert.equal(result.data.binding, "removed");
    assert.equal(result.data.revocation, "unconfirmed");
    assert.deepEqual(credentialFiles(box), []);
  });

  const box = sandbox();
  const server = await startOAuthServer();
  assert.equal((await login(assert, box, server)).run.code, 0);
  await server.close();
  const text = await logout(assert, box, server, { json: false });
  assert.equal(text.run.code, 13);
  assert.match(text.run.stdout, /Server revocation: unconfirmed/);
  assert.match(text.run.stdout, /did not confirm/);
  assert.ok(!fs.existsSync(path.join(box.project, BINDING)));
});

test("logout with a dropped revocation, or a grant already gone, still cleans up truthfully", async () => {
  await withServer({}, async (server) => {
    const dropped = sandbox();
    assert.equal((await login(assert, dropped, server)).run.code, 0);
    server.behavior.revokeStatus = "drop";
    const { run, result } = await logout(assert, dropped, server);
    assert.equal(run.code, 13);
    assert.equal(result.data.revocation, "unconfirmed");
    assert.equal(result.data.local_credentials, "removed");
    assert.deepEqual(credentialFiles(dropped), []);
    assert.deepEqual(filesUnder(dropped.project), []);

    server.behavior.revokeStatus = 200;
    const missing = sandbox();
    assert.equal((await login(assert, missing, server)).run.code, 0);
    const slot = readBindingFile(missing).credential_slot;
    fs.rmSync(path.join(missing.config, "credentials", `${slot}.json`));
    const revokes = server.requestsTo("/v1/oauth/revoke").length;
    const gone = await logout(assert, missing, server);
    assert.equal(gone.run.code, 0);
    assert.equal(gone.result.data.local_credentials, "none");
    assert.equal(gone.result.data.revocation, "not_attempted");
    assert.equal(gone.result.data.binding, "removed");
    assert.equal(server.requestsTo("/v1/oauth/revoke").length, revokes, "a revocation was sent without a grant");
  });
});

test("a binding that cannot be removed is reported, and logout can be run again", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    const { run, result } = await logout(assert, box, server, {
      imports: [FAULTS],
      env: { METERGRAPH_TEST_FAULT: "binding-unlink" },
    });
    assert.equal(run.code, 9);
    assert.equal(result.outcome, "filesystem_error");
    assert.equal(result.error.reason, "binding_remove_failed");
    assert.equal(result.data.local_credentials, "removed");
    assert.equal(result.data.revocation, "accepted");
    assert.equal(result.data.binding, "kept");
    assert.ok(fs.existsSync(path.join(box.project, BINDING)));
    assert.ok(!fs.existsSync(path.join(box.project, ".metergraph", "project.lock")), "the project lock was left");

    const again = await logout(assert, box, server);
    assert.equal(again.run.code, 0);
    assert.equal(again.result.data.binding, "removed");
    assert.equal(again.result.data.revocation, "not_attempted");
    assert.deepEqual(filesUnder(box.project), []);
  });
});

test("a grant that cannot be saved or bound is removed and revoked, and nothing claims success", async () => {
  const cases = [
    ["credential-rename", "credential_write_failed", { credentialKept: false }],
    ["binding-rename", "binding_write_failed", { credentialKept: false }],
    ["binding-partial", "binding_partial_write", { credentialKept: true }],
  ];
  for (const [fault, reason, { credentialKept }] of cases) {
    await withServer({}, async (server) => {
      const box = sandbox();
      const { run, result } = await login(assert, box, server, [], {
        imports: [FAULTS],
        env: { METERGRAPH_TEST_FAULT: fault },
      });
      assert.equal(run.code, 9, fault);
      assertFailure(result, "filesystem_error", reason);
      assert.equal(result.data.binding, null);
      assert.ok(!fs.existsSync(path.join(box.project, BINDING)), `${fault}: a binding was written`);
      assert.deepEqual(filesUnder(box.project), [], `${fault}: project files were left`);
      const saved = credentialFiles(box).filter((name) => name.endsWith(".json"));
      assert.equal(saved.length, credentialKept ? 1 : 0, `${fault}: saved grants`);
      assert.deepEqual(
        credentialFiles(box).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
        [],
        `${fault}: temporary or lock files were left`,
      );
      assert.equal(server.requestsTo("/v1/oauth/revoke").length, 1, `${fault}: the grant was not revoked`);
      assert.ok([...server.state.refresh.values()].every((grant) => grant.revoked), `${fault}: grant still live`);
    });
  }
});

test("a rerun after the service revoked the grant signs in again and replaces it", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    const oldSlot = readBindingFile(box).credential_slot;
    for (const grant of [...server.state.refresh.values(), ...server.state.access.values()]) grant.revoked = true;

    const { run, result } = await login(assert, box, server);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.status, "reconnected");
    assert.deepEqual(result.data.workspace, { id: WORKSPACE_A });
    const binding = readBindingFile(box);
    assert.notEqual(binding.credential_slot, oldSlot);
    assert.deepEqual(credentialFiles(box), [`${binding.credential_slot}.json`]);
    assert.equal(browserLog(box).filter((entry) => entry.url).length, 2);
  });
});

test("a rerun after losing workspace access fails closed and changes nothing", async () => {
  await withServer({}, async (server) => {
    const box = sandbox();
    assert.equal((await login(assert, box, server)).run.code, 0);
    const original = fs.readFileSync(path.join(box.project, BINDING));
    const files = credentialFiles(box);
    // Membership removed: the service still knows the token but refuses it.
    server.behavior.bearerStatus = 403;

    const { run, result } = await login(assert, box, server);
    assert.equal(run.code, 11);
    assertFailure(result, "verification_failed", "access_rejected");
    assert.deepEqual(fs.readFileSync(path.join(box.project, BINDING)), original);
    assert.deepEqual(credentialFiles(box), files);
    // The grant issued by the second browser round trip was not kept.
    const live = [...server.state.refresh.values()].filter((grant) => !grant.revoked);
    assert.equal(live.length, 1, "the refused new grant was not revoked");
  });
});
