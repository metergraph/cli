import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { containsKnownCredential, planNonHostedSetup, preflightNonHostedSetup } from "../src/setup-deployment.js";
import { main } from "../src/cli.js";
import { healthyRoutes, json, startServer } from "./helpers.js";

const WORKSPACE = "00000000-0000-4000-8000-00000000000a";
const servers = [];
const dirs = [];
after(async () => {
  for (const server of servers) await server.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
const serve = async (routes) => {
  const server = await startServer(routes);
  servers.push(server);
  return server;
};
const input = (origin, overrides = {}) => ({
  deployment: "customer-local", runtime: "local", origin, originExplicit: true,
  workspace: WORKSPACE, confirmPrerequisites: true, agentTokenFile: null,
  timeoutMs: 3000, signup: false, ...overrides,
});
const oauthFixture = JSON.parse(fs.readFileSync(new URL("./fixtures/deployment-routing/oauth-metadata.json", import.meta.url), "utf8"));
const doc = (origin, name) => JSON.parse(JSON.stringify(oauthFixture[name]).replaceAll("{origin}", origin));
const agentDoc = (name, profile) => {
  const value = JSON.parse(fs.readFileSync(new URL(`./fixtures/deployment-routing/${name}.json`, import.meta.url), "utf8")).body;
  value.provenance.deployment_profile = profile;
  if (name === "agent-capabilities") value.deployment_profile = profile;
  return value;
};
const discoveryRoutes = () => ({
  "/.well-known/oauth-protected-resource/v1/agent/mcp": (request, response) =>
    json(200, doc(`http://${request.headers.host}`, "protected_resource"))(request, response),
  "/.well-known/oauth-authorization-server/v1/oauth": (request, response) =>
    json(200, doc(`http://${request.headers.host}`, "authorization_server"))(request, response),
});
function credentialFile(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph route "));
  dirs.push(dir);
  const file = path.join(dir, "agent-token");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return fs.realpathSync(file);
}

test("non-hosted setup requires explicit origin, workspace and operator prerequisite confirmation", () => {
  const origin = "http://127.0.0.1:43210";
  assert.equal(planNonHostedSetup(input(origin, { originExplicit: false })).reason, "non_hosted_origin_required");
  assert.equal(planNonHostedSetup(input(origin, { workspace: null })).reason, "non_hosted_workspace_required");
  assert.equal(planNonHostedSetup(input(origin, { signup: true })).reason, "signup_hosted_only");
  const waiting = planNonHostedSetup(input(origin, { confirmPrerequisites: false }));
  assert.equal(waiting.proceed, false);
  assert.equal(waiting.reason, "prerequisite_unknown");
  assert.equal(waiting.data.next_action.kind, "complete_prerequisite");
  assert.equal(waiting.data.next_action.prerequisite, "released_signed_bundle");
  assert.equal(planNonHostedSetup(input(origin)).proceed, true);
});

test("BYOC refuses insecure origins and customer-local refuses cloud execution before any request", () => {
  const local = "http://127.0.0.1:43210";
  const byoc = planNonHostedSetup(input(local, { deployment: "byoc" }));
  assert.equal(byoc.proceed, false);
  assert.equal(byoc.reason, "byoc_requires_https");
  assert.equal(byoc.data.next_action.kind, "use_https_origin");
  const cloud = planNonHostedSetup(input(local, { runtime: "cloud" }));
  assert.equal(cloud.proceed, false);
  assert.equal(cloud.data.next_action.kind, "run_on_customer_machine");
});

test("customer-local setup preflights the exact service profile before login or credential access", async () => {
  const server = await serve(healthyRoutes("local"));
  const ready = await preflightNonHostedSetup(input(server.origin));
  assert.equal(ready.proceed, true);
  assert.equal(ready.profile, "local");
  assert.equal(ready.metadataAccess, "pending_login");
  assert.deepEqual(server.requests.map((request) => request.path), ["/healthz", "/v1/deployment", "/v1/agent/capabilities"]);
  assert.ok(server.requests.every((request) => request.headers.authorization === undefined));
});

test("non-hosted setup rejects an unsafe deployment redirect before login", async () => {
  const server = await serve(healthyRoutes("local", {
    "/v1/deployment": (_request, response) => {
      response.writeHead(302, { location: "https://evil.example.com/steal" });
      response.end();
    },
  }));
  const result = await preflightNonHostedSetup(input(server.origin));
  assert.equal(result.proceed, false);
  assert.equal(result.outcome, "redirect_rejected");
  assert.equal(result.reason, "redirect");
  assert.deepEqual(server.requests.map((request) => request.path), ["/healthz", "/v1/deployment"]);
});

test("mismatched profile stops before login and a missing OSS agent token remains an operator handoff", async () => {
  const server = await serve(healthyRoutes("managed"));
  const wrong = await preflightNonHostedSetup(input(server.origin));
  assert.equal(wrong.proceed, false);
  assert.equal(wrong.reason, "deployment_profile_mismatch");
  assert.deepEqual(server.requests.map((request) => request.path), ["/healthz", "/v1/deployment", "/v1/agent/capabilities"]);
  const oss = await preflightNonHostedSetup(input(server.origin, { deployment: "oss" }));
  assert.equal(oss.proceed, false);
  assert.equal(oss.reason, "oss_agent_token_file_required");
  assert.equal(oss.data.metadata_access, "not_checked");
  assert.equal(server.requests.length, 3, "OSS handoff did not contact a hosted origin");
});

test("OSS with an absent Metadata discovery contract stops before reading its separate agent token", async () => {
  const server = await serve(healthyRoutes("oss"));
  const result = await preflightNonHostedSetup(input(server.origin, {
    deployment: "oss", agentTokenFile: "/never-created/agent-token",
  }));
  assert.equal(result.proceed, false);
  assert.equal(result.data.metadata_access, "not_checked");
  assert.equal(result.data.next_action.kind, "oss_operator_handoff");
  assert.deepEqual(server.requests.map((request) => request.path), [
    "/v1/deployment", "/.well-known/oauth-protected-resource/v1/agent/mcp",
    "/.well-known/oauth-protected-resource",
  ]);
});

test("a Metadata failure cannot echo a private token coinciding with a fixed handoff status", { skip: process.platform === "win32" }, async () => {
  const token = "operator_handoff";
  const server = await serve(healthyRoutes("local", {
    ...discoveryRoutes(),
    "/v1/agent/workspace": json(401, { error: "invalid_token" }),
  }));
  const routed = await preflightNonHostedSetup(input(server.origin, { agentTokenFile: credentialFile(token) }));
  assert.equal(routed.proceed, false);
  assert.equal(routed.reason, "credential_echo");
  assert.equal(routed.data, null);
  assert.ok(!JSON.stringify(routed).includes(token));
  assert.equal(containsKnownCredential({ origin: token }, routed), true);
  assert.equal(Object.keys(routed).includes("knownCredentials"), false);
  assert.deepEqual(server.requests.filter((request) => request.headers.authorization).map((request) => request.path),
    ["/v1/agent/workspace"]);
});

test("CLI handoff suppresses a credential that collides with its output", { skip: process.platform === "win32" }, async () => {
  const token = "operator_handoff";
  const server = await serve(healthyRoutes("local", {
    ...discoveryRoutes(),
    "/v1/agent/workspace": json(401, { error: "invalid_token" }),
  }));
  const output = [];
  const errors = [];
  const code = await main(["setup", "--runtime", "local", "--deployment", "customer-local",
    "--confirm-prerequisites", "--url", server.origin, "--workspace", WORKSPACE,
    "--agent-token-file", credentialFile(token), "--skip-skill", "--json"], {
    stdout: { write: (value) => output.push(value) },
    stderr: { write: (value) => errors.push(value) },
  });
  assert.equal(code, 6);
  assert.equal(errors.length, 0);
  assert.equal(output.length, 1);
  assert.ok(!output[0].includes(token));
  assert.equal(JSON.parse(output[0]).error.reason, "credential_echo");
});

test("output guard compares decoded strings and keys, including printable quotes and slashes", () => {
  const token = 'credential "abcdefghij"';
  const routed = { knownCredentials: [token] };
  assert.equal(containsKnownCredential({ message: token }, routed), true);
  assert.equal(containsKnownCredential({ [token]: "value" }, routed), true);
  assert.equal(containsKnownCredential({ message: `safe ${token} suffix` }, routed), true);
  assert.equal(containsKnownCredential({ message: "safe" }, routed), false);
  const slash = String.raw`credential \abcdefghij`;
  assert.equal(containsKnownCredential({ message: slash }, { knownCredentials: [slash] }), true);
});

test("successful local verification keeps the separate agent token guarded without printing it", { skip: process.platform === "win32" }, async () => {
  const token = "operator_handoff";
  const server = await serve(healthyRoutes("local", {
    ...discoveryRoutes(),
    "/v1/agent/workspace": json(200, agentDoc("agent-workspace", "local")),
    "/v1/agent/capabilities": (request, response) => request.headers.authorization
      ? json(200, agentDoc("agent-capabilities", "local"))(request, response)
      : json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" })(request, response),
  }));
  const routed = await preflightNonHostedSetup(input(server.origin, { agentTokenFile: credentialFile(token) }));
  assert.equal(routed.proceed, true);
  assert.equal(routed.metadataAccess, "verified");
  assert.ok(!JSON.stringify(routed).includes(token));
  assert.equal(containsKnownCredential({ status: token }, routed), true);
  assert.deepEqual(server.requests.filter((request) => request.headers.authorization).map((request) => request.path),
    ["/v1/agent/workspace", "/v1/agent/capabilities"]);
});
