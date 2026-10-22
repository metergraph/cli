// login --role debug with --allow-* and --workspace by slug or name, run as
// subprocesses against the synthetic service in
// test/fixtures/oauth-server.js. A Debug sign in asks for exactly the role
// and permissions named, as bin/agent-key does, which a workspace owner
// approves on the consent page; the reads then use it. A workspace named by
// slug or name is sent to a consent page that can match it and is checked
// against the workspace the service reports. Every value is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { openStore, readCredential } from "../src/auth-store.js";
import { LOCAL_ENV, checked, login, readBindingFile, sandboxes } from "./auth-helpers.js";
import { runCli } from "./helpers.js";
import { WORKSPACE_A, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph login access test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const ALL_FLAGS = ["--role", "debug", "--allow-evaluation-writes", "--allow-evaluation-previews", "--allow-analysis-starts"];
const ALL_SCOPES = ["agent:analysis-run", "agent:eval-preview", "agent:eval-write", "agent:read"];
const ALL_PERMISSIONS = { allow_evaluation_writes: true, allow_evaluation_previews: true, allow_analysis_starts: true };
// A deployment that offers managed evaluations, so the permissions are offered.
const WITH_EVALUATIONS = (doc) => ({ ...doc, deployment_capabilities: [...doc.deployment_capabilities, "evaluations"] });

async function withServer(behavior, work) {
  const server = await startOAuthServer({ capabilities: WITH_EVALUATIONS, ...behavior });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

const authorizeRequests = (server) => server.requestsTo("/v1/oauth/authorize");
const grantFor = (box) => readCredential(openStore(box.config, { create: false }), readBindingFile(box).credential_slot);

async function read(box, server, args) {
  const run = await runCli(["--json", ...args, "--project", box.project, "--config-dir", box.config], { env: LOCAL_ENV });
  return checked(assert, run, { box, server, json: true });
}

test("login --role debug with every --allow-* asks for exactly that and saves the grant", () =>
  withServer({}, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ALL_FLAGS);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(server.state.scopes.at(-1).split(" ").sort(), ALL_SCOPES);
    assert.deepEqual(result.data.access, { role: "debug", permissions: ALL_PERMISSIONS });
    assert.deepEqual(result.data.scopes, ALL_SCOPES);
    assert.match(
      result.data.next_action.message,
      /the Debug role with Allow evaluation writes, Allow evaluation previews and Allow analysis starts/,
    );
    assert.equal(grantFor(box).scope, "agent:read agent:analysis-run agent:eval-preview agent:eval-write");

    // The reads use the grant, and status reports the role and permissions.
    const status = await read(box, server, ["status"]);
    assert.equal(status.run.code, 0, status.run.stdout);
    assert.equal(status.result.data.credential, "oauth_grant");
    assert.deepEqual(status.result.data.scopes, ALL_SCOPES);
    assert.deepEqual(status.result.data.access, { role: "debug", permissions: ALL_PERMISSIONS, permissions_offered: true });
  }));

test("login asks for only the permissions named, and Debug alone without any", () =>
  withServer({}, async (server) => {
    let box = sandbox();
    let { run, result } = await login(assert, box, server, ["--role", "debug", "--allow-evaluation-previews"]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(server.state.scopes.at(-1).split(" ").sort(), ["agent:eval-preview", "agent:read"]);
    assert.deepEqual(result.data.access.permissions, {
      allow_evaluation_writes: false, allow_evaluation_previews: true, allow_analysis_starts: false,
    });
    assert.equal(grantFor(box).scope, "agent:read agent:eval-preview");

    box = sandbox();
    ({ run, result } = await login(assert, box, server, ["--role", "debug"]));
    assert.equal(run.code, 0, run.stdout);
    assert.equal(server.state.scopes.at(-1), "agent:read");
    assert.equal(result.data.access.role, "debug");
    assert.match(result.data.next_action.message, /signed in with the Debug role\./);
    const status = await read(box, server, ["status"]);
    assert.equal(status.run.code, 0, status.run.stdout);
    assert.deepEqual(status.result.data.access.permissions, {
      allow_evaluation_writes: false, allow_evaluation_previews: false, allow_analysis_starts: false,
    });
  }));

test("a permission without --role debug is refused before any request", () =>
  withServer({}, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ["--allow-analysis-starts"]);
    assert.equal(run.code, 2);
    assert.equal(result.error.reason, "permission_needs_debug");
    assert.equal(authorizeRequests(server).length, 0);
  }));

test("a Debug grant is refreshed with its own scope", () =>
  withServer({}, async (server) => {
    const box = sandbox();
    await login(assert, box, server, ALL_FLAGS);
    const slot = readBindingFile(box).credential_slot;
    const store = openStore(box.config, { create: false });
    const { writeCredential } = await import("../src/auth-store.js");
    writeCredential(store, slot, { ...readCredential(store, slot), expires_at: Date.now() - 1000 });
    const { run } = await read(box, server, ["usage"]);
    assert.equal(run.code, 0, run.stdout);
    const refresh = server
      .requestsTo("/v1/oauth/token")
      .map((request) => new URLSearchParams(request.body))
      .find((form) => form.get("grant_type") === "refresh_token");
    assert.deepEqual(refresh.get("scope").split(" ").sort(), ALL_SCOPES);
  }));

test("asking for another role on a signed in project signs in again for the same workspace", () =>
  withServer({}, async (server) => {
    const box = sandbox();
    await login(assert, box, server);
    assert.equal(grantFor(box).scope, "agent:metadata");
    const before = authorizeRequests(server).length;
    // The same role again reuses the grant with no browser.
    let { result } = await login(assert, box, server);
    assert.equal(result.data.status, "reused");
    assert.equal(authorizeRequests(server).length, before);
    ({ result } = await login(assert, box, server, ALL_FLAGS));
    assert.equal(result.data.status, "reconnected");
    assert.equal(authorizeRequests(server).length, before + 1);
    assert.equal(grantFor(box).scope, "agent:read agent:analysis-run agent:eval-preview agent:eval-write");
    // Other permissions on the same role sign in again too.
    ({ result } = await login(assert, box, server, ["--role", "debug", "--allow-evaluation-writes"]));
    assert.equal(result.data.status, "reconnected");
    assert.equal(grantFor(box).scope, "agent:read agent:eval-write");
  }));

test("a workspace named by slug or name is sent as a hint and checked after sign in", () =>
  withServer({ workspaceHint: "match" }, async (server) => {
    for (const named of ["example-workspace", "example workspace", "Example Workspace"]) {
      const box = sandbox();
      const { run, result } = await login(assert, box, server, ["--workspace", named]);
      assert.equal(run.code, 0, run.stdout);
      assert.equal(server.state.hints.at(-1), named);
      assert.deepEqual(result.data.workspace, { id: WORKSPACE_A, slug: "example-workspace", name: "Example Workspace" });
    }
    // A slug the service does not report for the approved workspace is refused.
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ["--workspace", "other-workspace"]);
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "workspace_mismatch");
    assert.ok(!fs.existsSync(path.join(box.project, ".metergraph", "project.json")));
  }));

for (const outcome of ["ambiguous", "unknown"]) {
  test(`a consent page that finds the named workspace ${outcome} ends sign in with the slug to use`, () =>
    withServer({ workspaceHint: outcome }, async (server) => {
      const box = sandbox();
      const { run, result } = await login(assert, box, server, ["--workspace", "Example"]);
      assert.equal(run.code, 2);
      assert.equal(result.error.reason, `workspace_hint_${outcome}`);
      assert.equal(result.data.next_action.kind, "use_workspace_slug");
      assert.equal(server.requestsTo("/v1/oauth/token").length, 0);
    }));
}

test("without hint support, a slug is checked after sign in and a name is refused first", () =>
  withServer({}, async (server) => {
    let box = sandbox();
    let { run, result } = await login(assert, box, server, ["--workspace", "example-workspace"]);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(server.state.hints.at(-1), null);
    box = sandbox();
    const before = authorizeRequests(server).length;
    ({ run, result } = await login(assert, box, server, ["--workspace", "Example Workspace"]));
    assert.equal(run.code, 6);
    assert.equal(result.error.reason, "workspace_name_unsupported");
    assert.equal(authorizeRequests(server).length, before);
  }));

test("the reads check a workspace named by slug or name against the verified one", () =>
  withServer({}, async (server) => {
    const box = sandbox();
    await login(assert, box, server);
    let { run, result } = await read(box, server, ["usage", "--workspace", "Example Workspace"]);
    assert.equal(run.code, 0, run.stdout);
    ({ run, result } = await read(box, server, ["usage", "--workspace", "another-workspace"]));
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "workspace_context_mismatch");
    assert.equal(result.data.result, null);
  }));

test("text output names the workspace by name and slug, never by ID", () =>
  withServer({}, async (server) => {
    const box = sandbox();
    const { run } = await login(assert, box, server, [], { json: false });
    assert.match(run.stdout, /Example Workspace \(example-workspace\)/);
    assert.ok(!run.stdout.includes(WORKSPACE_A));
    for (const command of ["status", "usage", "routes"]) {
      const human = await runCli([command, "--project", box.project, "--config-dir", box.config], { env: LOCAL_ENV });
      assert.equal(human.code, 0, human.stdout);
      assert.match(human.stdout, /Example Workspace \(example-workspace\)/, command);
      assert.ok(!human.stdout.includes(WORKSPACE_A), `${command} printed the workspace ID`);
    }
  }));

test("a workspace name with control characters is never printed", () =>
  withServer({ workspace: (doc) => ({ ...doc, workspace: { ...doc.workspace, name: "Evil\u001b]0;x\u0007" } }) }, async (server) => {
    const box = sandbox();
    const { result } = await login(assert, box, server);
    assert.deepEqual(result.data.workspace, { id: WORKSPACE_A, slug: "example-workspace", name: null });
  }));

test("sign in refuses a workspace whose name, not slug, matches a slug-shaped --workspace", () =>
  withServer({
    workspaceHint: "match",
    workspace: (doc) => ({ ...doc, workspace: { ...doc.workspace, slug: "someone-else", name: "example-workspace" } }),
  }, async (server) => {
    const box = sandbox();
    const { run, result } = await login(assert, box, server, ["--workspace", "example-workspace"]);
    assert.equal(run.code, 11);
    assert.equal(result.error.reason, "workspace_mismatch");
    assert.ok(!fs.existsSync(path.join(box.project, ".metergraph", "project.json")));
  }));

test("the workspace match is strict: a slug matches only the slug, other text only the exact name", async () => {
  const { workspacePinned } = await import("../src/read-contract.js");
  const workspace = { slug: "acme-prod", name: "acme" };
  // Names are chosen by whoever owns a workspace, so a slug-shaped pin never
  // matches one, and no compatibility folding makes look-alikes equal.
  assert.equal(workspacePinned(workspace, "acme-prod"), true);
  assert.equal(workspacePinned(workspace, "acme"), false);
  // Upper case is still slug-shaped, so it never falls back to a name.
  assert.equal(workspacePinned({ slug: "beta", name: "acme-prod" }, "ACME-PROD"), false);
  assert.equal(workspacePinned(workspace, "ACME-PROD"), true);
  assert.equal(workspacePinned({ slug: "acme-prod", name: "Acme Prod" }, "ACME PROD"), true);
  assert.equal(workspacePinned({ slug: "acme-prod", name: "Acme Prod" }, "Ａｃｍｅ Prod"), false);
});

test("a workspace name that holds a credential is not printed by login", () =>
  withServer({}, async (server) => {
    // The service reports the newest refresh token as the workspace's name.
    server.behavior.workspace = (doc) => ({
      ...doc,
      workspace: { ...doc.workspace, name: server.state.issued.filter((value) => value.startsWith("refresh-")).at(-1) },
    });
    const box = sandbox();
    const { run, result } = await login(assert, box, server);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(result.data.workspace, { id: WORKSPACE_A, slug: null, name: null });
  }));
