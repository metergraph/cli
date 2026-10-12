// Credential and profile boundaries of non-hosted setup, end to end through
// the CLI against the synthetic service. Each deployment keeps its own
// credentials apart: the registry pull credential never reaches this CLI, the
// local admin signs in only in the browser, the ingest key comes only from
// setup redemption and lives only in the env file, and a separate Agent
// Access token is read from a private file and sent only to the agent
// documents. These are source fixtures, not a released bundle.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BROWSER, LOCAL_ENV, filesUnder, sandboxes } from "./auth-helpers.js";
import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";
import { WORKSPACE_B, startOAuthServer } from "./fixtures/oauth-server.js";

const unix = process.platform !== "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph boundary test "));
const servers = [];
after(async () => {
  for (const server of servers) await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const boxFor = sandboxes(dir);
const serve = async (behavior = {}) => {
  const server = await startOAuthServer({ setup: true, ...behavior });
  servers.push(server);
  return server;
};
const AGENT_TOKEN = "agent-read-token-synthetic-0123456789";

// The canonical path of a private token file, as an operator would make it.
function tokenFile(token) {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph agent token "));
  const file = path.join(holder, "agent-token");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return fs.realpathSync(file);
}

async function cli(box, args, { json = true } = {}) {
  const run = await runCli([...(json ? ["--json"] : []), "setup", "--runtime", "local", "--project", box.project,
    "--config-dir", box.config, "--client", "codex", ...args], { imports: [BROWSER],
    env: { ...LOCAL_ENV, METERGRAPH_TEST_BROWSER: "follow", METERGRAPH_TEST_BROWSER_LOG: box.log } });
  assertNoLeak(assert, run.stdout, run.stderr);
  return { ...run, result: json ? parseJsonLine(run.stdout) : null };
}
const route = (server, extra = []) => ["--deployment", "customer-local", "--confirm-prerequisites",
  "--url", server.origin, "--workspace", server.behavior.workspaceId, ...extra];
const projectFiles = (box) => filesUnder(box.project);
const read = (box, name) => fs.readFileSync(path.join(box.project, name));
const signInRequests = (server) => server.requests.filter((request) =>
  request.path.startsWith("/v1/oauth/authorize") || request.path === "/v1/oauth/register" ||
  request.path.startsWith("/v1/cli/setup/"));
const bearerOf = (request) => request.headers.authorization?.replace(/^Bearer /, "") ?? null;

test("a customer-local rerun resumes its saved route without route flags and checks the service again", async () => {
  const server = await serve();
  const box = boxFor();
  const first = await cli(box, route(server));
  assert.equal(first.result.outcome, "ok", first.stdout);
  const env = read(box, ".env");
  const probes = server.requestsTo("/v1/deployment").length;
  const approvals = server.requestsTo("/v1/cli/setup/authorize").length;

  for (const args of [[], ["--url", server.origin], route(server).filter((arg) => arg !== "--confirm-prerequisites")]) {
    const rerun = await cli(box, args);
    assert.equal(rerun.result.outcome, "ok", rerun.stdout);
    assert.equal(rerun.result.data.env, "unchanged");
    assert.equal(rerun.result.data.receipt.deployment_profile, "local");
    assert.deepEqual(rerun.result.data.receipt.completed_steps, ["login", "credential", "skill"]);
  }
  assert.ok(server.requestsTo("/v1/deployment").length >= probes + 3, "each rerun probed the live profile again");
  assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, approvals, "no rerun asked for another approval");
  assert.deepEqual(read(box, ".env"), env);
});

test("a rerun cannot move a customer-local project to another deployment, origin or workspace", async () => {
  const server = await serve();
  const other = await serve();
  const box = boxFor();
  assert.equal((await cli(box, route(server))).result.outcome, "ok");
  const env = read(box, ".env");
  const state = read(box, ".metergraph/setup.json");
  const binding = read(box, ".metergraph/project.json");

  const attempts = [
    [["--deployment", "managed", "--url", server.origin], null],
    [["--url", other.origin], "setup_binding_changed"],
    [route(server).map((arg) => arg === server.behavior.workspaceId ? WORKSPACE_B : arg), "setup_binding_changed"],
    [["--deployment", "byoc", "--confirm-prerequisites", "--url", server.origin,
      "--workspace", server.behavior.workspaceId], "byoc_requires_https"],
  ];
  for (const [args, reason] of attempts) {
    const run = await cli(box, args);
    assert.equal(run.result.ok, false, JSON.stringify(args));
    if (reason !== null) assert.equal(run.result.error.reason, reason);
    assert.deepEqual(read(box, ".env"), env);
    assert.deepEqual(read(box, ".metergraph/setup.json"), state);
    assert.deepEqual(read(box, ".metergraph/project.json"), binding);
  }
  assert.equal(signInRequests(other).length, 0, "the other origin saw no sign in or setup request");
});

test("an env key this setup does not own is refused before any sign in", async () => {
  const server = await serve();
  const box = boxFor();
  const unowned = "METERGRAPH_APP_TOKEN=someone-elses-key-0123456789\n";
  fs.writeFileSync(path.join(box.project, ".env"), unowned, { mode: 0o600 });
  const run = await cli(box, route(server));
  assert.equal(run.result.outcome, "conflict");
  assert.equal(run.result.error.reason, "existing_ingest_key_unowned");
  assert.equal(run.result.data.receipt, null);
  assert.equal(signInRequests(server).length, 0, "no approval was requested");
  assert.deepEqual(projectFiles(box), [".env"], "no binding or setup state was written");
  assert.equal(read(box, ".env").toString(), unowned);
  assert.ok(!run.stdout.includes("someone-elses-key"));
});

test("the separate Agent Access token stays out of files, output and every non-agent request", { skip: !unix }, async () => {
  const server = await serve({ agentTokens: [AGENT_TOKEN] });
  const box = boxFor();
  const run = await cli(box, route(server, ["--agent-token-file", tokenFile(AGENT_TOKEN)]));
  assert.equal(run.result.outcome, "ok", run.stdout);
  assert.ok(!run.stdout.includes(AGENT_TOKEN) && !run.stderr.includes(AGENT_TOKEN));
  for (const root of [box.project, box.config]) {
    for (const file of filesUnder(root)) {
      assert.ok(!fs.readFileSync(path.join(root, file), "utf8").includes(AGENT_TOKEN), `${file} holds the agent token`);
    }
  }

  const ingestKey = /^METERGRAPH_APP_TOKEN=(.+)$/m.exec(read(box, ".env").toString())[1];
  const agentUse = server.requests.filter((request) => bearerOf(request) === AGENT_TOKEN);
  assert.deepEqual(agentUse.map((request) => request.path), ["/v1/agent/workspace", "/v1/agent/capabilities"]);
  const firstApproval = server.requests.findIndex((request) => request.path === "/v1/oauth/authorize");
  assert.ok(server.requests.indexOf(agentUse.at(-1)) < firstApproval, "the agent token was checked before sign in");
  const ingestUse = server.requests.filter((request) => bearerOf(request) === ingestKey);
  assert.ok(ingestUse.length > 0);
  assert.ok(ingestUse.every((request) => request.path === "/v1/cli/setup/credential"),
    "the ingest key is only sent to the setup credential check");
  assert.ok(server.requests.filter((request) => request.path === "/v1/cli/setup/credential")
    .every((request) => bearerOf(request) === ingestKey), "no other credential reached the ingest credential check");
});

test("an agent token with content or replay access stops setup before sign in", { skip: !unix }, async () => {
  for (const name of ["trace_content", "trace_replay", "report_evidence"]) {
    const server = await serve({ agentTokens: [AGENT_TOKEN], capabilities: (doc) => {
      doc.agent[name].available = true;
      return doc;
    } });
    const box = boxFor();
    const run = await cli(box, route(server, ["--agent-token-file", tokenFile(AGENT_TOKEN)]));
    assert.equal(run.result.outcome, "verification_failed", name);
    assert.ok(["content_access_granted", "sensitive_capability_available"].includes(run.result.error.reason),
      run.result.error.reason);
    assert.equal(run.result.data.next_action.kind, "use_metadata_only_credential");
    assert.equal(typeof run.result.data.next_action.message, "string");
    assert.equal(signInRequests(server).length, 0);
    assert.deepEqual(projectFiles(box), []);
  }
});

test("an ingest key offered as the agent token is refused and goes nowhere else", { skip: !unix }, async () => {
  const server = await serve();
  const box = boxFor();
  const ingestLike = "mg_app_ingest_key_synthetic_0123456789";
  const run = await cli(box, route(server, ["--agent-token-file", tokenFile(ingestLike)]));
  assert.equal(run.result.ok, false);
  assert.equal(run.result.data.next_action.kind, "use_metadata_only_credential");
  assert.ok(!run.stdout.includes(ingestLike));
  assert.ok(server.requests.filter((request) => bearerOf(request) === ingestLike)
    .every((request) => request.path === "/v1/agent/workspace"));
  assert.equal(signInRequests(server).length, 0);
  assert.deepEqual(projectFiles(box), []);
});

test("each deployment refuses a service reporting another profile before any credential is sent", { skip: !unix }, async () => {
  const cells = [
    ["customer-local", "managed"], ["customer-local", "byoc-core"], ["customer-local", "oss"],
    ["oss", "managed"], ["oss", "local"], ["oss", "byoc-core"],
  ];
  for (const [deployment, profile] of cells) {
    const server = await serve({ profile, agentTokens: [AGENT_TOKEN] });
    const box = boxFor();
    const run = await cli(box, ["--deployment", deployment, "--confirm-prerequisites", "--url", server.origin,
      "--workspace", server.behavior.workspaceId, "--agent-token-file", tokenFile(AGENT_TOKEN)]);
    assert.equal(run.result.ok, false, `${deployment} against ${profile}`);
    assert.equal(run.result.data.status, "operator_handoff");
    assert.equal(server.requests.filter((request) => request.headers.authorization).length, 0,
      `${deployment} against ${profile} sent a credential`);
    assert.equal(signInRequests(server).length, 0);
    assert.deepEqual(projectFiles(box), []);
  }
});

test("OSS checks the MG_AGENT_TOKENS credential and hands ingest to the operator", { skip: !unix }, async () => {
  const server = await serve({ profile: "oss", agentTokens: [AGENT_TOKEN] });
  const box = boxFor();
  const args = ["--deployment", "oss", "--confirm-prerequisites", "--url", server.origin,
    "--workspace", server.behavior.workspaceId, "--agent-token-file", tokenFile(AGENT_TOKEN)];
  const run = await cli(box, args);
  assert.equal(run.result.outcome, "unsupported");
  assert.equal(run.result.error.reason, "oss_ingest_operator_handoff");
  assert.equal(run.result.data.metadata_access, "verified");
  assert.equal(run.result.data.ingest_credential, "not_checked");
  assert.equal(run.result.data.next_action.kind, "oss_operator_handoff");
  assert.equal(signInRequests(server).length, 0, "no hosted sign in, registration or ingest bootstrap");
  assert.deepEqual(projectFiles(box), [], "no env file, binding or setup state");

  const human = await cli(box, args, { json: false });
  assert.match(human.stdout, /Metergraph setup: operator_handoff/);
  assert.match(human.stdout, /Next: Ask the open source server operator/);
  assert.ok(!human.stdout.includes(AGENT_TOKEN));
});

test("a handoff names each unconfirmed prerequisite with fixed guidance and sends nothing", async () => {
  const server = await serve();
  const box = boxFor();
  const args = ["--deployment", "customer-local", "--url", server.origin, "--workspace", server.behavior.workspaceId];
  const run = await cli(box, args);
  assert.equal(run.result.error.reason, "prerequisite_unknown");
  assert.deepEqual(run.result.data.pending_prerequisites, ["released_signed_bundle", "registry_invitation",
    "bundle_started_verified", "local_admin_configured", "metadata_agent_credential"]);
  assert.equal(run.result.data.next_action.prerequisite, "released_signed_bundle");
  assert.match(run.result.data.next_action.message, /signed manifest/);

  const human = await cli(box, args, { json: false });
  assert.match(human.stdout, /Confirm each prerequisite, then rerun with --confirm-prerequisites:/);
  assert.match(human.stdout, /registry_invitation: .*never give it to this CLI/);
  assert.match(human.stdout, /bundle_started_verified: Start the bundle with bin\/start/);
  assert.match(human.stdout, /Guide: https:\/\//);
  assert.equal(server.requests.length, 0);
  assert.deepEqual(projectFiles(box), []);
});
