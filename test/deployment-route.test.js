import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { inspect } from "node:util";

import { CONNECTION_GUIDE_URL, EXIT_CODES } from "../src/constants.js";
import { planDeploymentRoute, verifyDeploymentRoute } from "../src/deployment-route.js";
import { MARKERS, json, startServer } from "./helpers.js";

const WORKSPACE = "00000000-0000-4000-8000-00000000000a";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-00000000000b";
const FIXTURES = new URL("./fixtures/deployment-routing/", import.meta.url);
const isWindows = process.platform === "win32";

const PRM = "/.well-known/oauth-protected-resource/v1/agent/mcp";
const PRM_BARE = "/.well-known/oauth-protected-resource";
const ASM = "/.well-known/oauth-authorization-server/v1/oauth";
const ASM_BARE = "/.well-known/oauth-authorization-server";
const PREFLIGHT_PATHS = Object.freeze(["/v1/deployment", PRM, ASM]);
const VERIFIED_PATHS = Object.freeze([...PREFLIGHT_PATHS, "/v1/agent/workspace", "/v1/agent/capabilities"]);

const READY = Object.freeze({
  "customer-local": {
    released_signed_bundle: "ready",
    registry_invitation: "ready",
    bundle_started_verified: "ready",
    local_admin_configured: "ready",
    metadata_agent_credential: "ready",
  },
  byoc: {
    operator_provisioning: "ready",
    private_network_reachability: "ready",
    identity_membership_configured: "ready",
    metadata_agent_credential: "ready",
  },
  // Every OSS prerequisite reported ready, including the two discovery gates
  // no released open source server meets. Only source-only module contract
  // fixtures stand behind it.
  oss: {
    server_distribution_installed: "ready",
    deployment_discovery_supported: "ready",
    metadata_scope_supported: "ready",
    ingestion_tokens_configured: "ready",
    agent_read_tokens_configured: "ready",
    metadata_agent_credential: "ready",
  },
});

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(name, FIXTURES), "utf8"));
const body = (name) => fixture(name).body;

function workspaceDoc(profile, edit = () => {}) {
  const doc = body("agent-workspace.json");
  doc.provenance.deployment_profile = profile;
  edit(doc);
  return doc;
}

function capabilitiesDoc(profile, edit = () => {}) {
  const doc = body("agent-capabilities.json");
  doc.provenance.deployment_profile = profile;
  doc.deployment_profile = profile;
  edit(doc);
  return doc;
}

// One OAuth metadata document for the origin the request was sent to.
function oauthDoc(name, origin, edit = () => {}) {
  const text = JSON.stringify(fixture("oauth-metadata.json")[name]).replaceAll("{origin}", origin);
  const doc = JSON.parse(text);
  edit(doc, origin);
  return doc;
}

const oauth = (name, edit) => (request, response) =>
  json(200, oauthDoc(name, `http://${request.headers.host}`, edit))(request, response);

const metadataEntry = (schema) => ({
  available: true,
  content: false,
  mutates: false,
  external_calls: false,
  privacy_class: "metadata",
  required_scope: "agent:metadata",
  schema,
});

function routes(profile = "local", { deployment, resource, server, workspace, capabilities, extra = {} } = {}) {
  const profileFixture = { local: "deployment-local.json", "byoc-core": "deployment-byoc-core.json" }[profile];
  return {
    "/v1/deployment": deployment ?? json(200, profileFixture ? body(profileFixture) : { deployment_profile: profile }),
    [PRM]: resource ?? oauth("protected_resource"),
    [ASM]: server ?? oauth("authorization_server"),
    "/v1/agent/workspace": workspace ?? json(200, workspaceDoc(profile)),
    "/v1/agent/capabilities": capabilities ?? json(200, capabilitiesDoc(profile)),
    ...extra,
  };
}

// The hypothetical open source server of the source-only module contract
// fixtures. No released open source server behaves like this.
const sourceOnlyOss = (overrides = {}) =>
  routes("oss", { deployment: json(200, body("deployment-oss.source-only.json")), ...overrides });

const delayed = (ms, handler) => (request, response) => setTimeout(() => handler(request, response), ms);
const never = () => () => {};

let root;
let counter = 0;
const servers = [];

async function serve(table) {
  const server = await startServer(table);
  servers.push(server);
  return server;
}

// A private credential file. The token is freshly generated unless a test
// needs it to coincide with a fixed value; no fixture holds a credential.
function credential(token = `mgtest_${randomBytes(24).toString("hex")}`) {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, "agent-token");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { token, file, dir };
}

// A path that is never created. A run that reaches the file read reports
// credential_missing, so any other outcome proves the file was not read.
function untouched() {
  counter += 1;
  return { token: "never-written", file: path.join(root, `absent-${counter}`, "agent-token"), dir: root };
}

function routeInput(server, cred, overrides = {}) {
  return {
    model: "customer-local",
    runtime: "local",
    origin: server.origin,
    workspaceId: WORKSPACE,
    prerequisites: READY["customer-local"],
    credentialFile: cred.file,
    timeoutMs: 5000,
    ...overrides,
  };
}

const ossInput = (server, cred, overrides = {}) =>
  routeInput(server, cred, { model: "oss", prerequisites: READY.oss, ...overrides });

const paths = (server) => server.requests.map((entry) => entry.path);

// Nothing secret, local or server-provided may appear in a printable result,
// and every outcome has an exit code.
function assertSafe(result, cred) {
  for (const text of [JSON.stringify(result), inspect(result, { depth: null })]) {
    assert.ok(!text.includes(cred.token), "the credential appeared in a result");
    assert.ok(!text.includes(cred.dir) && !text.includes(cred.file), "a local path appeared in a result");
    for (const marker of MARKERS) assert.ok(!text.includes(marker), "server or planted text appeared in a result");
    assert.ok(!text.includes("SYNTHETIC_BODY_MARKER"));
    assert.ok(!text.includes("knownCredentials") && !text.includes("documents"));
  }
  assert.deepEqual(Object.keys(result).sort(), ["ok", "outcome", "plan", "reason", "receipt", "verification"]);
  assert.ok(Object.hasOwn(EXIT_CODES, result.outcome), "every outcome has an exit code");
  if (result.verification?.next_action !== null && result.verification?.next_action !== undefined) {
    assert.deepEqual(result.plan.next_action, result.verification.next_action, "the plan reports the actual next action");
  }
}

// A result produced after the credential was read carries it, non-enumerable,
// for the caller's output suppression. One produced before carries nothing.
function assertKnown(result, cred) {
  const descriptor = Object.getOwnPropertyDescriptor(result, "knownCredentials");
  assert.ok(descriptor !== undefined, "knownCredentials is attached");
  assert.equal(descriptor.enumerable, false);
  assert.deepEqual(result.knownCredentials, [cred.token]);
}
function assertNotRead(result) {
  assert.equal(Object.getOwnPropertyDescriptor(result, "knownCredentials"), undefined);
  if (result.verification !== null) assert.equal(result.verification.credential_file, "not_run");
}

// Only the two agent documents ever carry the credential, and only exactly.
function assertAuth(server, cred) {
  for (const entry of server.requests) {
    if (entry.path === "/v1/agent/workspace" || entry.path === "/v1/agent/capabilities") {
      assert.equal(entry.headers.authorization, `Bearer ${cred.token}`);
    } else {
      assert.equal(entry.headers.authorization, undefined, "a credential was sent outside verification");
    }
    assert.equal(entry.headers.cookie, undefined);
  }
  assert.ok(!paths(server).includes("/v1/oauth/register"), "nothing is registered");
}

before(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mg-deploy-route-"));
  fs.chmodSync(root, 0o700);
});
after(async () => {
  for (const server of servers) await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("planDeploymentRoute", () => {
  const base = { runtime: "local", workspaceId: WORKSPACE };

  test("each model has its own profile and exact prerequisites", () => {
    const expected = {
      "customer-local": ["local", "http://127.0.0.1:8080"],
      byoc: ["byoc-core", "https://metergraph.example.com"],
      oss: ["oss", "https://oss.example.com"],
    };
    for (const [model, [profile, origin]] of Object.entries(expected)) {
      const result = planDeploymentRoute({ ...base, model, origin, prerequisites: READY[model] });
      assert.equal(result.ok, true);
      assert.equal(result.outcome, "ok");
      assert.deepEqual(result.plan, {
        model,
        runtime: "local",
        origin,
        workspace_id: WORKSPACE,
        deployment_profile: profile,
        prerequisites: Object.keys(READY[model]).map((name) => ({ name, status: "ready" })),
        next_action: { kind: "verify_route", prerequisite: null, url: CONNECTION_GUIDE_URL },
        unsupported_reasons: [],
      });
      assert.deepEqual(result.receipt, {
        version: 1,
        model,
        runtime: "local",
        origin,
        workspace_id: WORKSPACE,
        deployment_profile: profile,
        phase: "prerequisites",
      });
      assert.equal(result.verification, null);
    }
    const names = (model) => Object.keys(READY[model]);
    assert.ok(names("customer-local").includes("registry_invitation"));
    assert.ok(names("byoc").includes("private_network_reachability"));
    // Open source has no hosted sign up, keys page or registry step. The
    // server distribution, its discovery support, ingestion tokens and agent
    // read tokens are separate prerequisites.
    assert.ok(!names("oss").some((name) => /signup|sign_up|key|registry|invitation/.test(name)));
    assert.deepEqual(names("oss"), [
      "server_distribution_installed",
      "deployment_discovery_supported",
      "metadata_scope_supported",
      "ingestion_tokens_configured",
      "agent_read_tokens_configured",
      "metadata_agent_credential",
    ]);
  });

  test("source-only OSS fixtures are labelled module contract fixtures with no parity claim", () => {
    const oss = fixture("deployment-oss.source-only.json");
    assert.equal(oss.source_only, true);
    assert.equal(oss.module_contract_fixture, true);
    assert.equal(oss.current_release_parity, false);
    assert.match(oss.fixture, /^source-only module contract fixture:/);
    assert.match(oss.fixture, /no parity claim/);
    assert.deepEqual(oss.body, { deployment_profile: "oss" });
    assert.match(fixture("oauth-metadata.json").fixture, /source-only module contract fixture/);
  });

  test("missing prerequisites hand off in order as unsupported and recover once reported ready", () => {
    const origin = "https://metergraph.example.com";
    const none = planDeploymentRoute({ ...base, model: "byoc", origin });
    assert.equal(none.ok, false);
    assert.equal(none.outcome, "unsupported");
    assert.equal(none.reason, "prerequisite_unknown");
    assert.ok(none.plan.prerequisites.every((entry) => entry.status === "unknown"));
    assert.deepEqual(none.plan.next_action, {
      kind: "complete_prerequisite",
      prerequisite: "operator_provisioning",
      url: CONNECTION_GUIDE_URL,
    });
    assert.equal(none.receipt, null);

    const partial = planDeploymentRoute({
      ...base,
      model: "byoc",
      origin,
      prerequisites: { ...READY.byoc, identity_membership_configured: "required" },
    });
    assert.equal(partial.outcome, "unsupported");
    assert.equal(partial.reason, "prerequisite_required");
    assert.equal(partial.plan.next_action.prerequisite, "identity_membership_configured");

    const local = planDeploymentRoute({
      ...base,
      model: "customer-local",
      origin: "http://localhost:8787",
      prerequisites: { ...READY["customer-local"], metadata_agent_credential: "required" },
    });
    assert.equal(local.plan.next_action.prerequisite, "metadata_agent_credential");

    const recovered = planDeploymentRoute({ ...base, model: "byoc", origin, prerequisites: READY.byoc });
    assert.equal(recovered.ok, true);
  });

  test("OSS discovery and Metadata scope gates hand off to the operator", () => {
    const origin = "https://oss.example.com";
    // How a released open source server is reported today.
    const current = planDeploymentRoute({
      ...base,
      model: "oss",
      origin,
      prerequisites: { ...READY.oss, deployment_discovery_supported: "required", metadata_scope_supported: "required" },
    });
    assert.equal(current.ok, false);
    assert.equal(current.outcome, "unsupported");
    assert.equal(current.reason, "prerequisite_required");
    assert.equal(current.plan.deployment_profile, "oss");
    assert.deepEqual(current.plan.next_action, {
      kind: "oss_operator_handoff",
      prerequisite: "deployment_discovery_supported",
      url: CONNECTION_GUIDE_URL,
    });
    assert.deepEqual(
      current.plan.prerequisites.filter((entry) => entry.status !== "ready"),
      [
        { name: "deployment_discovery_supported", status: "required" },
        { name: "metadata_scope_supported", status: "required" },
      ],
    );
    assert.equal(current.receipt, null);

    const scope = planDeploymentRoute({ ...base, model: "oss", origin, prerequisites: { ...READY.oss, metadata_scope_supported: "unknown" } });
    assert.equal(scope.reason, "prerequisite_unknown");
    assert.deepEqual(scope.plan.next_action, {
      kind: "oss_operator_handoff",
      prerequisite: "metadata_scope_supported",
      url: CONNECTION_GUIDE_URL,
    });

    // Agent token configuration is its own step, not an operator gate.
    const tokens = planDeploymentRoute({ ...base, model: "oss", origin, prerequisites: { ...READY.oss, agent_read_tokens_configured: "required" } });
    assert.equal(tokens.plan.next_action.kind, "complete_prerequisite");
    assert.equal(tokens.plan.next_action.prerequisite, "agent_read_tokens_configured");

    // An OSS plan with nothing reported defaults every gate to unknown.
    const none = planDeploymentRoute({ ...base, model: "oss", origin });
    assert.ok(none.plan.prerequisites.every((entry) => entry.status === "unknown"));
    assert.equal(none.plan.next_action.prerequisite, "server_distribution_installed");
  });

  test("cloud, cloud-no-shell and remote-ssh runtimes get a fixed handoff", () => {
    for (const runtime of ["cloud", "cloud-no-shell", "remote-ssh"]) {
      for (const [model, origin] of [["customer-local", "http://127.0.0.1:8787"], ["oss", "https://oss.example.com"]]) {
        const result = planDeploymentRoute({ ...base, runtime, model, origin, prerequisites: READY[model] });
        assert.equal(result.ok, false);
        assert.equal(result.outcome, "unsupported");
        assert.equal(result.reason, "runtime_not_customer_machine");
        assert.deepEqual(result.plan.unsupported_reasons, ["runtime_not_customer_machine"]);
        assert.equal(result.plan.next_action.kind, "run_on_customer_machine");
        assert.equal(result.receipt, null);
      }
    }
  });

  test("BYOC requires HTTPS, while customer-local may use exact loopback HTTP", () => {
    for (const origin of ["http://127.0.0.1:8787", "http://localhost", "http://[::1]:9000"]) {
      const byoc = planDeploymentRoute({ ...base, model: "byoc", origin, prerequisites: READY.byoc });
      assert.equal(byoc.outcome, "unsupported");
      assert.equal(byoc.reason, "byoc_requires_https");
      assert.equal(byoc.plan.next_action.kind, "use_https_origin");
      const local = planDeploymentRoute({ ...base, model: "customer-local", origin, prerequisites: READY["customer-local"] });
      assert.equal(local.ok, true);
    }
  });

  test("invalid input is refused without echoing it", () => {
    const good = { ...base, model: "oss", origin: "https://oss.example.com" };
    const cases = [
      [null, "input_invalid"],
      [{ ...good, model: "managed" }, "model_invalid"],
      [{ ...good, model: "local" }, "model_invalid"],
      [{ ...good, model: "SYNTHETIC_BODY_MARKER" }, "model_invalid"],
      [{ ...good, model: "toString" }, "model_invalid"],
      [{ ...good, runtime: "hunter2" }, "runtime_invalid"],
      [{ ...good, origin: "http://metergraph.example.com" }, "origin_invalid"],
      [{ ...good, origin: "https://hunter2@evil.example.com" }, "origin_invalid"],
      [{ ...good, origin: "https://evil.example.com/path" }, "origin_invalid"],
      [{ ...good, origin: "http://127.1:8787" }, "origin_invalid"],
      [{ ...good, origin: 42 }, "origin_invalid"],
      [{ ...good, workspaceId: "hunter2" }, "workspace_id_invalid"],
      [{ ...good, prerequisites: { registry_invitation: "ready" } }, "prerequisites_invalid"],
      [{ ...good, prerequisites: { operator_managed_installation: "ready" } }, "prerequisites_invalid"],
      [{ ...good, prerequisites: { server_distribution_installed: "hunter2" } }, "prerequisites_invalid"],
      [{ ...good, prerequisites: { metadata_scope_supported: true } }, "prerequisites_invalid"],
      [{ ...good, prerequisites: [] }, "prerequisites_invalid"],
    ];
    for (const [input, reason] of cases) {
      const result = planDeploymentRoute(input);
      assert.deepEqual(result, {
        ok: false,
        outcome: "invalid_input",
        reason,
        plan: null,
        verification: null,
        receipt: null,
      });
    }
  });

  test("receipts must match the route exactly and carry no extra fields", () => {
    const input = { ...base, model: "oss", origin: "https://oss.example.com", prerequisites: READY.oss };
    const { receipt } = planDeploymentRoute(input);
    for (const phase of ["prerequisites", "preflight", "verified"]) {
      assert.equal(planDeploymentRoute({ ...input, receipt: { ...receipt, phase } }).ok, true);
    }
    const invalid = [
      "hunter2",
      [],
      { ...receipt, version: 2 },
      { ...receipt, version: "1" },
      { ...receipt, phase: "connected" },
      { ...receipt, credential: "hunter2" },
      { ...receipt, credential_file: "/home/example/token" },
      { ...receipt, token: "hunter2" },
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "phase")),
    ];
    for (const value of invalid) {
      const result = planDeploymentRoute({ ...input, receipt: value });
      assert.equal(result.reason, "receipt_invalid");
      assert.equal(result.plan, null);
    }
    const mismatched = [
      { ...receipt, workspace_id: OTHER_WORKSPACE },
      { ...receipt, origin: "https://other.example.com" },
      { ...receipt, model: "byoc" },
      { ...receipt, runtime: "cloud" },
      { ...receipt, deployment_profile: "local" },
    ];
    for (const value of mismatched) {
      assert.equal(planDeploymentRoute({ ...input, receipt: value }).reason, "receipt_context_mismatch");
    }
    // A verified receipt does not make missing prerequisites ready.
    const stale = planDeploymentRoute({ ...input, prerequisites: {}, receipt: { ...receipt, phase: "verified" } });
    assert.equal(stale.outcome, "unsupported");
    assert.equal(stale.reason, "prerequisite_unknown");
    assert.equal(stale.receipt, null);
  });
});

describe("verifyDeploymentRoute", { skip: isWindows }, () => {
  test("verifies a Metadata-only credential afresh and reports only fixed facts", async () => {
    const server = await serve(routes("local"));
    const cred = credential();
    const prerequisites = { ...READY["customer-local"] };
    const result = await verifyDeploymentRoute(routeInput(server, cred, { prerequisites }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.outcome, "ok");
    assert.equal(result.reason, "metadata_access_verified");
    assert.deepEqual(result.verification, {
      deployment_discovery: "passed",
      metadata_discovery: "passed",
      credential_file: "passed",
      agent_metadata_access: "passed",
      contract: "metergraph.agent-access/v1",
      access_scope: "agent:metadata",
      content_included: false,
      capabilities: { workspace_context: true, capability_discovery: true },
      not_checked: ["ingest", "provider", "sdk", "registration", "bundle"],
      next_action: null,
    });
    assert.equal(result.receipt.phase, "verified");
    assert.deepEqual(paths(server), VERIFIED_PATHS);
    assertAuth(server, cred);
    assertSafe(result, cred);
    assertKnown(result, cred);
    // Agent verification never upgrades bundle, registration or other facts.
    assert.deepEqual(result.plan.prerequisites, Object.keys(prerequisites).map((name) => ({ name, status: "ready" })));
    // Nothing was written next to the credential.
    assert.deepEqual(fs.readdirSync(cred.dir), ["agent-token"]);
  });

  test("discovery uses only the fixed metadata paths, with the bare forms as the contract's only fallback", async () => {
    // Only the bare forms are served: the path-suffixed forms answer 404.
    const table = routes("local", {
      extra: { [PRM_BARE]: oauth("protected_resource"), [ASM_BARE]: oauth("authorization_server") },
    });
    delete table[PRM];
    delete table[ASM];
    const bare = await serve(table);
    const cred = credential();
    const result = await verifyDeploymentRoute(routeInput(bare, cred));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(paths(bare), [
      "/v1/deployment",
      PRM,
      PRM_BARE,
      ASM,
      ASM_BARE,
      "/v1/agent/workspace",
      "/v1/agent/capabilities",
    ]);
    assertAuth(bare, cred);
    assertSafe(result, cred);
  });

  test("discovery that is missing, elsewhere or without the Metadata scope stops before the credential", async () => {
    const elsewhere = "https://evil.example.com";
    const cases = [
      // [label, overrides, outcome, reason, paths]
      ["no metadata", { resource: json(404, {}), server: json(404, {}) }, "unsupported", "oauth_metadata_missing", ["/v1/deployment", PRM, PRM_BARE]],
      ["resource elsewhere", { resource: oauth("protected_resource", (doc) => (doc.resource = `${elsewhere}/v1/agent/mcp`)) }, "unsupported", "resource_mismatch", ["/v1/deployment", PRM]],
      ["issuer elsewhere", { resource: oauth("protected_resource", (doc) => (doc.authorization_servers = [`${elsewhere}/v1/oauth`])) }, "unsupported", "issuer_mismatch", ["/v1/deployment", PRM]],
      ["resource scopes broad only", { resource: oauth("protected_resource", (doc) => (doc.scopes_supported = ["agent:read", "agent:replay"])) }, "unsupported", "metadata_scope_unsupported", ["/v1/deployment", PRM]],
      ["server scopes broad only", { server: oauth("authorization_server", (doc) => (doc.scopes_supported = ["agent:read", "agent:replay"])) }, "unsupported", "metadata_scope_unsupported", PREFLIGHT_PATHS],
      ["server scopes missing", { server: oauth("authorization_server", (doc) => delete doc.scopes_supported) }, "unsupported", "metadata_scope_unsupported", PREFLIGHT_PATHS],
      ["registration elsewhere", { server: oauth("authorization_server", (doc) => (doc.registration_endpoint = `${elsewhere}/v1/oauth/register`)) }, "unsupported", "endpoint_not_allowed", PREFLIGHT_PATHS],
      ["issuer document elsewhere", { server: oauth("authorization_server", (doc) => (doc.issuer = `${elsewhere}/v1/oauth`)) }, "unsupported", "issuer_mismatch", PREFLIGHT_PATHS],
      ["not JSON", { server: json(200, "SYNTHETIC_BODY_MARKER") }, "unsupported", "invalid_response", PREFLIGHT_PATHS],
      ["unavailable", { resource: json(503, { error: "SYNTHETIC_BODY_MARKER" }) }, "unhealthy", "service_unavailable", ["/v1/deployment", PRM]],
    ];
    for (const [label, overrides, outcome, reason, expected] of cases) {
      const server = await serve(routes("local", overrides));
      const cred = untouched();
      const result = await verifyDeploymentRoute(routeInput(server, cred));
      assert.equal(result.outcome, outcome, label);
      assert.equal(result.reason, reason, label);
      assert.equal(result.verification.deployment_discovery, "passed", label);
      assert.equal(result.verification.metadata_discovery, "failed", label);
      assert.equal(result.verification.next_action.kind, "connection_guide", label);
      assert.equal(result.receipt.phase, "prerequisites", label);
      assert.deepEqual(paths(server), expected, label);
      assertNotRead(result);
      assertAuth(server, cred);
      assertSafe(result, cred);
    }
  });

  test("redirects are not followed and nothing is forwarded, in preflight or discovery", async () => {
    const target = await serve(routes("local"));
    const redirect = (to) => (request, response) => {
      response.writeHead(302, { location: `${target.origin}${to}` });
      response.end();
    };
    for (const [overrides, expected] of [
      [{ deployment: redirect("/v1/deployment") }, ["/v1/deployment"]],
      [{ resource: redirect(PRM) }, ["/v1/deployment", PRM]],
      [{ server: redirect(ASM) }, PREFLIGHT_PATHS],
    ]) {
      const server = await serve(routes("local", overrides));
      const cred = untouched();
      const result = await verifyDeploymentRoute(routeInput(server, cred));
      assert.equal(result.outcome, "redirect_rejected");
      assert.equal(result.reason, "redirect");
      assert.deepEqual(paths(server), expected);
      assertNotRead(result);
      assertAuth(server, cred);
      assertSafe(result, cred);
    }
    assert.deepEqual(target.requests, []);
  });

  test("a previous receipt never skips a check, and the phase reflects only this run", async () => {
    const working = await serve(routes("local"));
    const first = await verifyDeploymentRoute(routeInput(working, credential()));
    assert.equal(first.receipt.phase, "verified");

    // Preflight fails: phase prerequisites, no credential read.
    const broken = await serve(routes("local", { deployment: json(503, { error: "SYNTHETIC_BODY_MARKER" }) }));
    const receipt = { ...first.receipt, origin: broken.origin };
    const cred = untouched();
    const rerun = await verifyDeploymentRoute(routeInput(broken, cred, { receipt }));
    assert.equal(rerun.ok, false);
    assert.equal(rerun.outcome, "unhealthy");
    assert.equal(rerun.receipt.phase, "prerequisites", "the phase reflects this run, not the receipt");
    assertNotRead(rerun);
    assertSafe(rerun, cred);

    // Discovery now fails: still phase prerequisites, no credential read.
    const noScope = await serve(
      routes("local", { server: oauth("authorization_server", (doc) => (doc.scopes_supported = ["agent:read"])) }),
    );
    const scoped = await verifyDeploymentRoute(routeInput(noScope, cred, { receipt: { ...receipt, origin: noScope.origin } }));
    assert.equal(scoped.reason, "metadata_scope_unsupported");
    assert.equal(scoped.receipt.phase, "prerequisites");
    assertNotRead(scoped);

    // The credential file now fails: phase preflight, nothing sent.
    const fileGone = await verifyDeploymentRoute(routeInput(working, untouched(), { receipt: { ...first.receipt } }));
    assert.equal(fileGone.reason, "credential_missing");
    assert.equal(fileGone.receipt.phase, "preflight");

    // A preflight receipt still reads and verifies the credential again.
    const rejecting = await serve(routes("local", { workspace: json(401, { error: "SYNTHETIC_BODY_MARKER" }) }));
    const again = await verifyDeploymentRoute(
      routeInput(rejecting, credential(), { receipt: { ...receipt, origin: rejecting.origin, phase: "preflight" } }),
    );
    assert.equal(again.reason, "access_rejected");
    assert.equal(again.receipt.phase, "preflight");
    assert.deepEqual(paths(rejecting), [...PREFLIGHT_PATHS, "/v1/agent/workspace"]);
  });

  test("a plan that is not ready makes no request", async () => {
    const server = await serve(routes("local"));
    const cred = untouched();
    for (const overrides of [
      { prerequisites: {} },
      { runtime: "cloud" },
      { runtime: "remote-ssh" },
      { model: "byoc", prerequisites: READY.byoc },
      { model: "oss", prerequisites: { ...READY.oss, deployment_discovery_supported: "required" } },
      { model: "oss", prerequisites: { ...READY.oss, metadata_scope_supported: "unknown" } },
      { timeoutMs: 0 },
      { cancel: "hunter2" },
      { credentialFile: "agent-token" },
    ]) {
      const result = await verifyDeploymentRoute(routeInput(server, cred, overrides));
      assert.equal(result.ok, false);
      assert.equal(result.verification, null);
      assertNotRead(result);
      assertSafe(result, cred);
    }
    assert.deepEqual(server.requests, []);
  });

  test("a released OSS server without deployment discovery is handed to its operator with no credential read", async () => {
    // A released open source server answers 404 for /v1/deployment.
    const server = await serve({});
    const cred = untouched();
    const local = await verifyDeploymentRoute(routeInput(server, cred));
    assert.equal(local.outcome, "unsupported");
    assert.equal(local.reason, "deployment_endpoint_missing");
    assert.equal(local.verification.next_action.kind, "connection_guide");

    const oss = await verifyDeploymentRoute(ossInput(server, cred));
    assert.equal(oss.ok, false);
    assert.equal(oss.outcome, "unsupported");
    assert.equal(oss.reason, "oss_deployment_discovery_unavailable");
    assert.equal(oss.verification.deployment_discovery, "failed");
    assert.equal(oss.verification.metadata_discovery, "not_run");
    assert.equal(oss.verification.next_action.kind, "oss_operator_handoff");
    assert.equal(oss.receipt.phase, "prerequisites");
    assert.deepEqual(paths(server), ["/v1/deployment", "/v1/deployment"], "no fallback discovery");
    assertNotRead(oss);
    assertAuth(server, cred);
    assertSafe(oss, cred);
  });

  test("an OSS server whose OAuth metadata offers only broad access is handed off with no credential read", async () => {
    const broad = ["agent:read", "agent:replay"];
    const cases = [
      [{ server: oauth("authorization_server", (doc) => (doc.scopes_supported = broad)) }, "metadata_scope_unsupported", PREFLIGHT_PATHS],
      [{ resource: oauth("protected_resource", (doc) => (doc.scopes_supported = broad)) }, "metadata_scope_unsupported", ["/v1/deployment", PRM]],
      [{ resource: json(404, {}), server: json(404, {}) }, "oauth_metadata_missing", ["/v1/deployment", PRM, PRM_BARE]],
    ];
    for (const [overrides, reason, expected] of cases) {
      const server = await serve(sourceOnlyOss(overrides));
      const cred = untouched();
      const result = await verifyDeploymentRoute(ossInput(server, cred));
      assert.equal(result.outcome, "unsupported");
      assert.equal(result.reason, reason);
      assert.equal(result.verification.next_action.kind, "oss_operator_handoff");
      assert.equal(result.receipt.phase, "prerequisites");
      assert.deepEqual(paths(server), expected);
      assertNotRead(result);
      assertAuth(server, cred);
      assertSafe(result, cred);
    }
  });

  test("an oss route is never treated as local, and a local route never as oss", async () => {
    const local = await serve(routes("local"));
    const cred = untouched();
    const asOss = await verifyDeploymentRoute(ossInput(local, cred));
    assert.equal(asOss.outcome, "unsupported");
    assert.equal(asOss.reason, "deployment_profile_mismatch");
    assert.equal(asOss.verification.next_action.kind, "oss_operator_handoff");
    assert.deepEqual(paths(local), ["/v1/deployment"]);
    assertNotRead(asOss);

    const oss = await serve(sourceOnlyOss());
    const asLocal = await verifyDeploymentRoute(routeInput(oss, cred));
    assert.equal(asLocal.reason, "deployment_profile_mismatch");
    assert.deepEqual(paths(oss), ["/v1/deployment"]);
    assertNotRead(asLocal);
  });

  test("source-only module contract: hypothetical OSS discovery verifies only a Metadata-only token", async () => {
    const server = await serve(sourceOnlyOss());
    const cred = credential();
    const result = await verifyDeploymentRoute(ossInput(server, cred));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.plan.deployment_profile, "oss");
    assert.deepEqual(paths(server), VERIFIED_PATHS);
    assertAuth(server, cred);
    assertSafe(result, cred);

    // A broader static token is still refused after discovery passes.
    const broader = (doc) => (doc.access.scopes = ["agent:metadata", "agent:read", "agent:replay"]);
    const broad = await serve(sourceOnlyOss({ workspace: json(200, workspaceDoc("oss", broader)) }));
    const other = credential();
    const refused = await verifyDeploymentRoute(ossInput(broad, other));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "scope_mismatch");
    assert.equal(refused.verification.next_action.kind, "use_metadata_only_credential");
    assert.deepEqual(paths(broad), [...PREFLIGHT_PATHS, "/v1/agent/workspace"]);
    assertSafe(refused, other);
    assertKnown(refused, other);
  });

  test("an unexpected or mismatched profile stops before discovery and the credential", async () => {
    const cases = [
      [{ deployment_profile: "managed" }, "deployment_profile_mismatch"],
      [{ deployment_profile: "byoc-core" }, "deployment_profile_mismatch"],
      [{ deployment_profile: "oss" }, "deployment_profile_mismatch"],
      [{ deployment_profile: "SYNTHETIC_BODY_MARKER" }, "unrecognized_profile"],
      [{ deployment_profile: 1 }, "invalid_response"],
      [{ deployment_profile: true }, "invalid_response"],
    ];
    for (const [deployment, reason] of cases) {
      const server = await serve(routes("local", { deployment: json(200, deployment) }));
      const cred = untouched();
      const result = await verifyDeploymentRoute(routeInput(server, cred));
      assert.equal(result.outcome, "unsupported");
      assert.equal(result.reason, reason);
      assert.deepEqual(paths(server), ["/v1/deployment"]);
      assertNotRead(result);
      assertSafe(result, cred);
    }
  });

  test("an unreachable or unavailable service stops before the credential", async () => {
    const closed = await serve({});
    await closed.close();
    const cred = untouched();
    const refused = await verifyDeploymentRoute(routeInput(closed, cred));
    assert.equal(refused.outcome, "connection_failed");
    assert.equal(refused.reason, "connection_refused");

    // A private BYOC origin that cannot be reached points at network setup.
    const byoc = await verifyDeploymentRoute(
      routeInput(closed, cred, { model: "byoc", prerequisites: READY.byoc, origin: `https://127.0.0.1:${closed.port}` }),
    );
    assert.equal(byoc.outcome, "connection_failed");
    assert.equal(byoc.verification.next_action.kind, "check_private_network");
    assertNotRead(byoc);
    assertSafe(byoc, cred);

    const unavailable = await serve(routes("local", { deployment: json(503, {}) }));
    const down = await verifyDeploymentRoute(routeInput(unavailable, cred));
    assert.equal(down.outcome, "unhealthy");
    assert.equal(down.reason, "service_unavailable");
    assertNotRead(down);
  });

  test("workspace, profile, scope, role and content mismatches fail closed", async () => {
    const cases = [
      [(doc) => { doc.workspace.id = OTHER_WORKSPACE; doc.provenance.workspace_id = OTHER_WORKSPACE; }, "workspace_context_mismatch"],
      [(doc) => (doc.provenance.deployment_profile = "managed"), "profile_mismatch"],
      [(doc) => (doc.provenance.deployment_profile = "oss"), "profile_mismatch"],
      [(doc) => (doc.access.scopes = ["agent:metadata", "agent:read"]), "scope_mismatch"],
      [(doc) => (doc.access.scopes = ["agent:read"]), "scope_mismatch"],
      [(doc) => (doc.access.scopes = ["metadata"]), "scope_mismatch"],
      [(doc) => (doc.access.scopes = "agent:metadata"), "scope_mismatch"],
      // No access grant at all.
      [(doc) => delete doc.access, "scope_mismatch"],
      [(doc) => (doc.access.scopes = []), "scope_mismatch"],
      [(doc) => (doc.content.included = true), "content_access_granted"],
      [(doc) => (doc.content.included = "false"), "content_access_granted"],
      [(doc) => (doc.content.included = 0), "content_access_granted"],
      [(doc) => delete doc.content, "content_access_granted"],
      [(doc) => (doc.schema_version = 1), "workspace_response_invalid"],
      [(doc) => delete doc.provenance, "workspace_response_invalid"],
    ];
    for (const [edit, reason] of cases) {
      const server = await serve(routes("local", { workspace: json(200, workspaceDoc("local", edit)) }));
      const cred = credential();
      const result = await verifyDeploymentRoute(routeInput(server, cred));
      assert.equal(result.ok, false);
      assert.equal(result.outcome, "verification_failed");
      assert.equal(result.reason, reason);
      assert.equal(result.receipt.phase, "preflight");
      assert.equal(result.verification.agent_metadata_access, "failed");
      assert.equal(result.verification.next_action.kind, "use_metadata_only_credential");
      // No Debug or Replay request, and no second try with other access.
      assert.deepEqual(paths(server), [...PREFLIGHT_PATHS, "/v1/agent/workspace"]);
      assertAuth(server, cred);
      assertSafe(result, cred);
      assertKnown(result, cred);
    }
  });

  test("the capabilities contract must be exact and expose nothing sensitive", async () => {
    const setAgent = (name, entry) => (doc) => (doc.agent[name] = entry);
    const cases = [
      [(doc) => (doc.schema_version = 1), "capabilities_response_invalid"],
      [(doc) => (doc.deployment_profile = "byoc-core"), "profile_mismatch"],
      [(doc) => (doc.provenance.workspace_id = OTHER_WORKSPACE), "workspace_context_mismatch"],
      [setAgent("usage", { ...metadataEntry("agent-access/usage"), mutates: "false" }), "capabilities_response_invalid"],
      [setAgent("usage", { ...metadataEntry("agent-access/usage"), external_calls: 0 }), "content_access_granted"],
      [setAgent("usage", { ...metadataEntry("agent-access/usage"), mutates: true }), "content_access_granted"],
      [(doc) => (doc.agent.trace_content.available = true), "content_access_granted"],
      [(doc) => (doc.agent.trace_replay.available = true), "content_access_granted"],
      [setAgent("future_writer", { ...metadataEntry("future/writer"), mutates: true }), "sensitive_capability_available"],
      [setAgent("future_provider", { ...metadataEntry("future/provider"), external_calls: true }), "content_access_granted"],
      [setAgent("future_content", { ...metadataEntry("future/content"), privacy_class: "content" }), "content_access_granted"],
      [setAgent("future_scope", { ...metadataEntry("future/scope"), required_scope: "agent:read" }), "sensitive_capability_available"],
      [setAgent("future_unclear", { available: "yes" }), "content_access_granted"],
      [setAgent("future_unclear", { ...metadataEntry("future/unclear"), available: "yes" }), "capabilities_response_invalid"],
      [setAgent("future_unclear", { ...metadataEntry("future/unclear"), available: "true" }), "capabilities_response_invalid"],
      // The capabilities verification relies on must be present and available.
      [(doc) => delete doc.agent.capability_discovery, "required_capability_unavailable"],
      [(doc) => delete doc.agent.workspace_context, "required_capability_unavailable"],
      [(doc) => (doc.agent.workspace_context.available = false), "required_capability_unavailable"],
      [(doc) => (doc.bounds.content_included_by_default = true), "content_access_granted"],
      [(doc) => (doc.bounds.content_included_by_default = "false"), "content_access_granted"],
    ];
    for (const [edit, reason] of cases) {
      const server = await serve(routes("local", { capabilities: json(200, capabilitiesDoc("local", edit)) }));
      const cred = credential();
      const result = await verifyDeploymentRoute(routeInput(server, cred));
      assert.equal(result.ok, false, reason);
      assert.equal(result.reason, reason);
      assert.equal(result.verification.agent_metadata_access, "failed");
      assert.equal(result.receipt.phase, "preflight");
      assert.deepEqual(paths(server), VERIFIED_PATHS);
      assertAuth(server, cred);
      assertSafe(result, cred);
    }

    // An unknown capability that is plainly metadata-only, or unavailable,
    // does not block verification.
    const fine = (doc) => {
      doc.agent.future_metadata = metadataEntry("future/metadata");
      doc.agent.future_replay = { ...metadataEntry("future/replay"), available: false, privacy_class: "replay" };
    };
    const server = await serve(routes("local", { capabilities: json(200, capabilitiesDoc("local", fine)) }));
    const result = await verifyDeploymentRoute(routeInput(server, credential()));
    assert.equal(result.ok, true, result.reason);
  });

  test("an unsafe credential file stops after preflight with no credential sent", async () => {
    const server = await serve(routes("local"));
    const cred = credential();
    fs.chmodSync(cred.file, 0o644);
    const result = await verifyDeploymentRoute(routeInput(server, cred));
    assert.equal(result.outcome, "filesystem_error");
    assert.equal(result.reason, "credential_permissions_unsafe");
    assert.equal(result.verification.credential_file, "failed");
    assert.equal(result.verification.next_action.kind, "fix_credential_file");
    assert.equal(result.receipt.phase, "preflight");
    assert.deepEqual(paths(server), PREFLIGHT_PATHS);
    assert.equal(Object.getOwnPropertyDescriptor(result, "knownCredentials"), undefined);
    assertAuth(server, cred);
    assertSafe(result, cred);

    const missing = untouched();
    const absent = await verifyDeploymentRoute(routeInput(server, missing));
    assert.equal(absent.reason, "credential_missing", "the probe in other tests relies on this reason");
  });

  test("no result holds the credential, even where it coincides with route values or fixed text", async () => {
    // The service echoes the bearer it received in fields this CLI does not
    // read. The documents are never returned, so verification succeeds and
    // nothing echoed is printed.
    const bearerOf = (request) => request.headers.authorization.slice("Bearer ".length);
    const echoing = await serve(
      routes("local", {
        workspace: (request, response) =>
          json(200, workspaceDoc("local", (doc) => {
            doc.unknown_field = bearerOf(request);
            doc.workspace.name = bearerOf(request);
          }))(request, response),
        capabilities: (request, response) =>
          json(200, capabilitiesDoc("local", (doc) => (doc.unknown_field = { echoed: bearerOf(request) })))(request, response),
      }),
    );
    const echoed = credential();
    const fine = await verifyDeploymentRoute(routeInput(echoing, echoed));
    assert.equal(fine.ok, true, fine.reason);
    assertSafe(fine, echoed);
    assertKnown(fine, echoed);

    const refusal = (result, cred, outcome, reason) => {
      assert.deepEqual(result, { ok: false, outcome, reason, plan: null, verification: null, receipt: null });
      assert.ok(!JSON.stringify(result).includes(cred.token));
      assertKnown(result, cred);
      assertSafe(result, cred);
    };

    // A UUID-shaped token equal to the bound workspace id.
    const server = await serve(routes("local"));
    const uuid = credential(WORKSPACE);
    refusal(await verifyDeploymentRoute(routeInput(server, uuid)), uuid, "verification_failed", "credential_in_metadata_response");

    // A token equal to the origin.
    const origin = credential(server.origin);
    refusal(await verifyDeploymentRoute(routeInput(server, origin)), origin, "verification_failed", "credential_in_metadata_response");

    // A token equal to fixed text in a failure after the read.
    const rejecting = await serve(routes("local", { workspace: json(401, {}) }));
    const kind = credential("use_metadata_only_credential");
    refusal(await verifyDeploymentRoute(routeInput(rejecting, kind)), kind, "verification_failed", "credential_in_metadata_response");

    // A token held by both a failure and the first refusal gets a fallback
    // whose every string is shorter than any token.
    for (const text of ["verification_failed", "verification_fail"]) {
      const collision = credential(text);
      const result = await verifyDeploymentRoute(routeInput(rejecting, collision));
      refusal(result, collision, "unsupported", "credential_echo");
      assert.notEqual(result.reason, collision.token);
    }
    // A token equal to the refusal text but held by nothing else is no echo.
    const unused = credential("credential_in_metadata_response");
    const plain = await verifyDeploymentRoute(routeInput(server, unused));
    assert.equal(plain.ok, true, plain.reason);
    assertSafe(plain, unused);
    assert.ok([...paths(server), ...paths(rejecting)].every((entry) => VERIFIED_PATHS.includes(entry)));
  });

  test("one deadline spans preflight, discovery and both verification requests", async () => {
    const server = await serve(
      routes("local", {
        resource: delayed(120, oauth("protected_resource")),
        server: delayed(120, oauth("authorization_server")),
        workspace: delayed(120, json(200, workspaceDoc("local"))),
        capabilities: delayed(120, json(200, capabilitiesDoc("local"))),
      }),
    );
    const cred = credential();
    const result = await verifyDeploymentRoute(routeInput(server, cred, { timeoutMs: 400 }));
    assert.equal(result.outcome, "connection_failed");
    assert.equal(result.reason, "timeout");
    assert.equal(result.verification.agent_metadata_access, "interrupted");
    assert.equal(result.receipt.phase, "preflight");
    // Each request alone fits the deadline; together they do not.
    assert.deepEqual(paths(server), VERIFIED_PATHS);
    assertSafe(result, cred);
    assertKnown(result, cred);

    // The deadline expiring during discovery stops before the credential.
    const slow = await serve(routes("local", { server: delayed(300, oauth("authorization_server")) }));
    const unread = untouched();
    const early = await verifyDeploymentRoute(routeInput(slow, unread, { timeoutMs: 150 }));
    assert.equal(early.reason, "timeout");
    assert.equal(early.verification.metadata_discovery, "interrupted");
    assert.equal(early.receipt.phase, "prerequisites");
    assertNotRead(early);
  });

  test("cancellation stops every later step and is never reported as success", async () => {
    const server = await serve(routes("local"));
    const cred = untouched();
    const early = await verifyDeploymentRoute(routeInput(server, cred, { cancel: AbortSignal.abort() }));
    assert.equal(early.outcome, "cancelled");
    assert.equal(early.verification.next_action.kind, "retry");
    assert.deepEqual(server.requests, []);

    // Cancelled during the preflight: discovery and the file never run.
    const preflight = new AbortController();
    const slow = await serve(
      routes("local", {
        deployment: (request, response) => {
          preflight.abort();
          setTimeout(() => json(200, body("deployment-local.json"))(request, response), 50);
        },
      }),
    );
    const during = await verifyDeploymentRoute(routeInput(slow, cred, { cancel: preflight.signal }));
    assert.equal(during.outcome, "cancelled");
    assert.equal(during.verification.deployment_discovery, "interrupted");
    assertNotRead(during);
    assert.deepEqual(paths(slow), ["/v1/deployment"]);

    // Cancelled once a complete discovery response has been sent: the
    // response is not acted on and the file is never read.
    const discovering = new AbortController();
    const answered = await serve(
      routes("local", {
        server: (request, response) => {
          oauth("authorization_server")(request, response);
          discovering.abort();
        },
      }),
    );
    const unread = await verifyDeploymentRoute(routeInput(answered, cred, { cancel: discovering.signal }));
    assert.equal(unread.outcome, "cancelled");
    assert.equal(unread.verification.metadata_discovery, "interrupted");
    assert.equal(unread.receipt.phase, "prerequisites");
    assertNotRead(unread);
    assert.deepEqual(paths(answered), PREFLIGHT_PATHS);

    // Cancelled during the workspace check: capabilities is never requested.
    const between = new AbortController();
    const held = await serve(routes("local", { workspace: () => between.abort() }));
    const real = credential();
    const stopped = await verifyDeploymentRoute(routeInput(held, real, { cancel: between.signal }));
    assert.equal(stopped.outcome, "cancelled");
    assert.equal(stopped.receipt.phase, "preflight");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(paths(held), [...PREFLIGHT_PATHS, "/v1/agent/workspace"]);
    assertSafe(stopped, real);
    assertKnown(stopped, real);

    // Cancelled just after a complete, valid capabilities response: never ok.
    const last = new AbortController();
    const done = await serve(
      routes("local", {
        capabilities: (request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(capabilitiesDoc("local")), () => last.abort());
        },
      }),
    );
    const late = credential();
    const result = await verifyDeploymentRoute(routeInput(done, late, { cancel: last.signal }));
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.verification.agent_metadata_access, "interrupted");
    assert.equal(result.verification.contract, null);
    assert.equal(result.receipt.phase, "preflight");
    assert.deepEqual(paths(done), VERIFIED_PATHS);
    assertSafe(result, late);
    assertKnown(result, late);
  });

  test("a subprocess run prints nothing secret", async () => {
    const server = await serve(routes("local", { capabilities: never() }));
    const cred = credential();
    const moduleUrl = new URL("../src/deployment-route.js", import.meta.url).href;
    const script = `
      const { verifyDeploymentRoute } = await import(${JSON.stringify(moduleUrl)});
      const input = JSON.parse(process.argv[1]);
      process.stdout.write(JSON.stringify(await verifyDeploymentRoute(input)) + "\\n");
    `;
    const input = routeInput(server, cred, { timeoutMs: 300 });
    const { code, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (exit) => resolve({ code: exit, stdout: out, stderr: err }));
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.reason, "timeout");
    assert.ok(!Object.hasOwn(result, "knownCredentials"));
    for (const text of [stdout, stderr]) {
      assert.ok(!text.includes(cred.token));
      assert.ok(!text.includes(cred.dir));
    }
    assertAuth(server, cred);
  });
});
