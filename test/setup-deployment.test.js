import assert from "node:assert/strict";
import { after, test } from "node:test";

import { planNonHostedSetup, preflightNonHostedSetup } from "../src/setup-deployment.js";
import { healthyRoutes, startServer } from "./helpers.js";

const WORKSPACE = "00000000-0000-4000-8000-00000000000a";
const servers = [];
after(async () => { for (const server of servers) await server.close(); });
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
