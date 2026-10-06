// Runs the read commands (status, context, capabilities, usage, routes and
// traces) as subprocesses against the synthetic loopback service in
// test/fixtures/oauth-server.js, after a real "metergraph login" against the
// same service. Every value is synthetic. This is protocol and output proof
// only; it does not prove the real service, real tenant isolation or real
// operational data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { openStore, readCredential, writeCredential } from "../src/auth-store.js";
import {
  LOCAL_ENV,
  browserLog,
  checked,
  isWindows,
  login,
  readBindingFile,
  sandboxes,
  startCli,
} from "./auth-helpers.js";
import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";
import { TRACE_ROWS, WORKSPACE_A, WORKSPACE_B, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph read test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const READ_PATHS = ["/v1/agent/usage", "/v1/agent/routes", "/v1/agent/traces"];
// The fixture plants markers in the workspace name and slug to prove login
// never prints them. context prints both, so read tests use plain synthetic
// values instead.
const PLAIN_WORKSPACE = (doc) => ({
  ...doc,
  workspace: { ...doc.workspace, slug: "example-workspace", name: "Example Workspace" },
});

async function withServer(work) {
  const server = await startOAuthServer({ workspace: PLAIN_WORKSPACE });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

// Signs a fresh project in and returns its sandbox.
async function signedIn(server) {
  const box = sandbox();
  const { run } = await login(assert, box, server);
  assert.equal(run.code, 0, run.stdout);
  return box;
}

async function read(box, server, args, { json = true, timeoutMs } = {}) {
  const full = [...args, "--project", box.project, "--config-dir", box.config];
  if (timeoutMs !== undefined) full.push("--timeout-ms", String(timeoutMs));
  const run = await runCli(json ? ["--json", ...full] : full, { env: LOCAL_ENV });
  return checked(assert, run, { box, server, json });
}

function since(server, before) {
  return server.requests.slice(before).map((request) => `${request.method} ${request.path}`);
}

function changeGrant(box, fields) {
  const slot = readBindingFile(box).credential_slot;
  const store = openStore(box.config, { create: false });
  writeCredential(store, slot, { ...readCredential(store, slot), ...fields });
}

const refreshes = (server) =>
  server
    .requestsTo("/v1/oauth/token")
    .filter((request) => new URLSearchParams(request.body).get("grant_type") === "refresh_token");

function assertFailure(result, outcome, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.outcome, outcome);
  assert.equal(result.error.code, outcome);
  assert.equal(result.error.reason, reason);
  assert.equal(typeof result.error.message, "string");
  assert.equal(result.data.result ?? null, null);
}

test("status keeps configured, reachable, authenticated and the verified workspace apart", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const binding = fs.readFileSync(path.join(box.project, ".metergraph", "project.json"));
    const before = server.requests.length;
    const { run, result } = await read(box, server, ["status"]);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.command, "status");
    assert.deepEqual(result.data, {
      origin: server.origin,
      configured: true,
      reachable: true,
      healthy: true,
      authenticated: true,
      deployment_profile: "local",
      deployment_profile_verified: true,
      workspace: { intended: WORKSPACE_A, actual: WORKSPACE_A, match: true },
      scopes: ["agent:metadata"],
      capabilities: {
        workspace_context: true,
        capability_discovery: true,
        routes: true,
        usage: true,
        ingestion_health: null,
        incidents: null,
        trace_metadata: true,
        reports: null,
        report_detail: null,
        report_evidence: false,
        trace_content: false,
        trace_replay: false,
      },
      content_access: false,
      application_traffic_verified: false,
      notices: ["application_traffic_not_verified"],
      next_action: null,
    });
    assert.deepEqual(since(server, before), [
      "GET /healthz",
      "GET /v1/deployment",
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
    ]);
    // Read only: no browser, no binding change, no request with a body.
    assert.equal(browserLog(box).filter((entry) => entry.url).length, 1);
    assert.deepEqual(fs.readFileSync(path.join(box.project, ".metergraph", "project.json")), binding);
    for (const path of ["/healthz", "/v1/deployment"]) {
      assert.equal(server.requests.slice(before).find((request) => request.path === path).headers.authorization, undefined);
    }

    const text = await read(box, server, ["status"], { json: false });
    assert.equal(text.run.code, 0);
    assert.match(text.run.stdout, /Configured: yes/);
    assert.match(text.run.stdout, /Deployment profile: bound local, reported by the service: same/);
    assert.match(text.run.stdout, /Authenticated: yes, verified by the service/);
    assert.match(text.run.stdout, /Application traffic verified: no/);
  });
});

test("status without a sign in is a truthful login_required and makes no request", async () => {
  const box = sandbox();
  const run = await runCli(["--json", "status", "--project", box.project, "--config-dir", box.config], {
    offline: true,
    env: LOCAL_ENV,
  });
  const { result } = checked(assert, run, { box });
  assert.equal(run.code, 12);
  assertFailure(result, "login_required", "not_signed_in");
  assert.equal(result.data.configured, false);
  assert.equal(result.data.reachable, null);
  assert.equal(result.data.authenticated, false);
  assert.deepEqual(result.data.workspace, { intended: null, actual: null, match: null });
  assert.equal(result.data.capabilities, null);
  assert.equal(result.data.next_action.kind, "login");
  assert.equal(fs.existsSync(box.config), false, "a read command created the config directory");

  for (const command of ["context", "capabilities", "usage", "routes", "traces"]) {
    const other = await runCli(["--json", command, "--project", box.project, "--config-dir", box.config], {
      offline: true,
      env: LOCAL_ENV,
    });
    assert.equal(other.code, 12);
    assertFailure(checked(assert, other, { box }).result, "login_required", "not_signed_in");
  }
});

test("status reports an unreachable service and a revoked or expired grant as different failures", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);

    for (const grant of server.state.access.values()) grant.revoked = true;
    const revoked = await read(box, server, ["status"]);
    assert.equal(revoked.run.code, 12);
    assertFailure(revoked.result, "login_required", "access_revoked");
    assert.equal(revoked.result.data.reachable, true);
    assert.equal(revoked.result.data.authenticated, false);
    assert.equal(revoked.result.data.workspace.actual, null);
    assert.equal(refreshes(server).length, 0, "a refused grant was refreshed");

    // An expired grant whose refresh is refused.
    changeGrant(box, { expires_at: Date.now() - 1000 });
    for (const grant of server.state.refresh.values()) grant.revoked = true;
    const expired = await read(box, server, ["status"]);
    assert.equal(expired.run.code, 12);
    assertFailure(expired.result, "login_required", "grant_rejected");

    await server.close();
    const down = await read(box, server, ["status"]);
    assert.equal(down.run.code, 4);
    assert.equal(down.result.outcome, "connection_failed");
    assert.equal(down.result.data.configured, true);
    assert.equal(down.result.data.reachable, false);
    assert.equal(down.result.data.authenticated, false);
  });
});

test("an expired grant is refreshed once inside the read, and an interrupted refresh is never retried", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    changeGrant(box, { expires_at: Date.now() - 1000 });
    const ok = await read(box, server, ["usage"]);
    assert.equal(ok.run.code, 0, ok.run.stdout);
    assert.equal(refreshes(server).length, 1);

    changeGrant(box, { expires_at: Date.now() - 1000 });
    server.behavior.refresh = "drop";
    const dropped = await read(box, server, ["usage"]);
    assert.equal(dropped.run.code, 12);
    assertFailure(dropped.result, "login_required", "refresh_interrupted");
    server.behavior.refresh = "rotate";
    const again = await read(box, server, ["usage"]);
    assertFailure(again.result, "login_required", "reconnect_required");
    assert.equal(refreshes(server).length, 2, "a possibly consumed refresh token was sent again");
    assert.equal(server.requestsTo("/v1/agent/usage").length, 1);
    assert.equal(browserLog(box).filter((entry) => entry.url).length, 1, "a read command opened a browser");
  });
});

test("context prints approved workspace fields only", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    server.behavior.workspace = (doc) => ({
      ...PLAIN_WORKSPACE(doc),
      owner_email: "person@example.com",
      prompt: "SYNTHETIC_BODY_MARKER",
      access: { ...doc.access, token: "hunter2" },
    });
    const { run, result } = await read(box, server, ["context"]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(result.data.result.workspace, {
      id: WORKSPACE_A,
      slug: "example-workspace",
      name: "Example Workspace",
      created_at: "2026-01-01T00:00:00Z",
    });
    assert.deepEqual(result.data.result.retention, { metadata_days: 90 });
    assert.deepEqual(result.data.result.content, { captured: true, included: false });
    assert.deepEqual(result.data.result.access, { scopes: ["agent:metadata"] });
    assert.equal(result.data.result.provenance.workspace_id, WORKSPACE_A);
    assert.equal(result.data.result.provenance.source, "synthetic-fixture");
    assert.ok(!run.stdout.includes("person@example.com"));

    const text = await read(box, server, ["context"], { json: false });
    assert.match(text.run.stdout, /Name: Example Workspace/);
    assert.ok(!text.run.stdout.includes("person@example.com"));
  });
});

test("capabilities shows known capabilities and bounds, and omits descriptions", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    server.behavior.capabilities = (doc) => ({
      ...doc,
      agent: { ...doc.agent, SYNTHETIC_BODY_MARKER: doc.agent.usage },
      privacy_classes: { metadata: { description: "SYNTHETIC_BODY_MARKER", fields: [] } },
    });
    const { run, result } = await read(box, server, ["capabilities"]);
    assert.equal(run.code, 0, run.stdout);
    const report = result.data.result;
    assert.equal(report.agent.usage.available, true);
    assert.equal(report.agent.trace_content.available, false);
    assert.equal(report.agent.trace_replay.external_calls, true);
    assert.equal(report.agent.incidents, null);
    assert.deepEqual(report.bounds, {
      max_days: 90,
      max_rows: 200,
      max_response_bytes: 5242880,
      content_included_by_default: false,
    });
    assert.deepEqual(result.data.notices, ["privacy_class_details_omitted", "unrecognized_capabilities_ignored"]);
  });
});

test("usage sends exactly the bounded query and reports complete, truncated and empty results truthfully", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const before = server.requests.length;
    const full = await read(box, server, ["usage"]);
    assert.equal(full.run.code, 0, full.run.stdout);
    assert.deepEqual(since(server, before), [
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
      "GET /v1/agent/usage",
    ]);
    const request = server.requestsTo("/v1/agent/usage")[0];
    assert.deepEqual(request.query, { days: "7", limit: "50" });
    assert.match(request.headers.authorization, /^Bearer /);
    const report = full.result.data.result;
    assert.equal(report.window.days, 7);
    assert.equal(report.rows, 3);
    assert.equal(report.complete, true);
    assert.equal(report.truncated, false);
    assert.equal(report.items[1].avg_latency_ms, null);
    assert.deepEqual(report.totals, {
      scope: "returned_rows",
      complete: true,
      calls: 77,
      error_calls: 3,
      cost_usd: 0.0246,
      input_tokens: 22600,
      output_tokens: 6400,
    });

    const cut = await read(box, server, ["usage", "--days", "30", "--limit=2"]);
    assert.equal(cut.run.code, 0);
    assert.deepEqual(server.requestsTo("/v1/agent/usage")[1].query, { days: "30", limit: "2" });
    assert.equal(cut.result.data.result.truncated, true);
    assert.equal(cut.result.data.result.complete, false);
    assert.equal(cut.result.data.result.totals.complete, false);
    assert.ok(cut.result.data.notices.includes("rows_truncated"));
    const cutText = await read(box, server, ["usage", "--limit", "2"], { json: false });
    assert.match(cutText.run.stdout, /incomplete, not workspace totals/);

    server.behavior.usage = (doc) => ({ ...doc, items: [], truncated: false, evidence: { ...doc.evidence, rows: 0 } });
    const empty = await read(box, server, ["usage"]);
    assert.equal(empty.run.code, 0);
    assert.equal(empty.result.data.result.empty, true);
    assert.equal(empty.result.data.result.totals.calls, 0);
    const emptyText = await read(box, server, ["usage"], { json: false });
    assert.match(emptyText.run.stdout, /No usage rows in this window/);
  });
});

test("routes are cut to --limit locally with truthful truncation and no route details", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const { run, result } = await read(box, server, ["routes", "--limit", "2"]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(server.requestsTo("/v1/agent/routes")[0].query, {}, "the routes endpoint was sent a query");
    const report = result.data.result;
    assert.equal(report.server_rows, 3);
    assert.equal(report.rows, 2);
    assert.equal(report.truncated, true);
    assert.equal(report.truncation, "local");
    assert.deepEqual(report.omitted_fields, ["description", "constraints", "evaluation_contract"]);
    assert.deepEqual(report.routes[0], {
      route: "checkout-summary",
      updated_at: "2026-01-01T00:00:00Z",
      calls: 65,
      replay_eligible_calls: 10,
      has_description: true,
      has_evaluation_contract: true,
      evaluation_contract_version: 3,
      evaluation_contract_hash: "sha256:0f1e2d3c4b5a",
    });
    assert.ok(result.data.notices.includes("routes_truncated_locally"));
    assert.ok(result.data.notices.includes("route_details_omitted"));

    const all = await read(box, server, ["routes"]);
    assert.equal(all.result.data.result.truncated, false);
    assert.equal(all.result.data.result.routes[2].evaluation_contract_version, "2");
    const text = await read(box, server, ["routes"], { json: false });
    assert.match(text.run.stdout, /Shown: 3 of 3 routes/);
  });
});

test("traces return one page with an opaque cursor, never follow it, and check filters", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const first = await read(box, server, ["traces", "--limit", "2"]);
    assert.equal(first.run.code, 0, first.run.stdout);
    assert.equal(server.requestsTo("/v1/agent/traces").length, 1, "a page was fetched automatically");
    const page = first.result.data.result;
    assert.deepEqual(page.page, { limit: 2, rows: 2, truncated: true, next_cursor: "page:2" });
    assert.equal(page.next_cursor, "page:2");
    assert.equal(page.complete, false);
    assert.equal(page.link_status, "server_link_unavailable");
    assert.equal(page.traces[0].link, null);
    assert.equal(page.traces[1].cost_usd, null);
    assert.deepEqual(page.traces[0].models, ["example-model-small"]);
    assert.ok(first.result.data.notices.includes("more_pages"));
    assert.ok(first.result.data.notices.includes("trace_links_unavailable"));

    const second = await read(box, server, ["traces", "--limit", "2", "--cursor", "page:2"]);
    assert.equal(second.run.code, 0);
    assert.deepEqual(server.requestsTo("/v1/agent/traces")[1].query, { days: "7", limit: "2", cursor: "page:2" });
    assert.equal(second.result.data.result.traces.length, 1);
    assert.equal(second.result.data.result.next_cursor, null);
    assert.equal(second.result.data.result.filters.cursor_supplied, true);

    const filtered = await read(box, server, [
      "traces",
      "--status",
      "error",
      "--route=support-triage",
      "--days",
      "14",
    ]);
    assert.equal(filtered.run.code, 0, filtered.run.stdout);
    assert.deepEqual(server.requestsTo("/v1/agent/traces")[2].query, {
      days: "14",
      limit: "20",
      route: "support-triage",
      status: "error",
    });
    assert.deepEqual(filtered.result.data.result.filters, {
      route_supplied: true,
      status: "error",
      cursor_supplied: false,
    });

    // A workload filter cannot be verified from the returned rows, so it is
    // refused before any request rather than sent and assumed to apply.
    const tracesBefore = server.requestsTo("/v1/agent/traces").length;
    const requestsBefore = server.requests.length;
    const workload = await read(box, server, ["traces", "--workload", "nightly-batch"]);
    assert.equal(workload.run.code, 6);
    assert.equal(workload.result.outcome, "unsupported");
    assert.equal(workload.result.error.reason, "workload_filter_unsupported");
    assert.match(workload.result.error.message, /No request was made/);
    assert.ok(!workload.run.stdout.includes("nightly-batch"));
    assert.equal(server.requests.length, requestsBefore, "a request was made for a refused workload filter");
    assert.equal(server.requestsTo("/v1/agent/traces").length, tracesBefore);

    const text = await read(box, server, ["traces", "--limit", "2"], { json: false });
    assert.match(text.run.stdout, /Next page: --cursor page:2/);
    assert.match(text.run.stdout, /Trace links: not available/);
  });
});

test("a filter or page the service did not honor fails closed", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const cases = [
      // Rows that ignore --status.
      [(doc) => ({ ...doc, traces: TRACE_ROWS.map((row) => ({ ...row })) }), ["--status", "error"], "filter_not_applied"],
      // An echoed filter that differs from the request.
      [(doc) => ({ ...doc, filters: { route: null, status: "success", workload: null } }), ["--status", "error"], "filter_mismatch"],
      // A page limit the service changed silently.
      [(doc) => ({ ...doc, page: { ...doc.page, limit: 200 } }), [], "traces_response_invalid"],
      // More rows than requested.
      [(doc) => ({ ...doc, traces: TRACE_ROWS.map((row) => ({ ...row })) }), ["--limit", "1"], "traces_response_invalid"],
      // A cursor that is not bounded printable text.
      [(doc) => ({ ...doc, page: { ...doc.page, next_cursor: "x".repeat(600) }, next_cursor: "x".repeat(600) }), [], "traces_response_invalid"],
    ];
    for (const [hook, args, reason] of cases) {
      server.behavior.traces = hook;
      const { run, result } = await read(box, server, ["traces", ...args]);
      assert.equal(run.code, 11, reason);
      assertFailure(result, "verification_failed", reason);
    }
  });
});

test("a read document for another workspace, profile or contract fails closed", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const cases = [
      [(doc) => ({ ...doc, provenance: { ...doc.provenance, workspace_id: WORKSPACE_B } }), 11, "workspace_context_mismatch"],
      [(doc) => ({ ...doc, provenance: { ...doc.provenance, deployment_profile: "managed" } }), 11, "profile_mismatch"],
      [(doc) => ({ ...doc, schema_version: 1 }), 6, "contract_version_unsupported"],
      [(doc) => ({ ...doc, content_included: true }), 11, "content_access_granted"],
      [(doc) => ({ ...doc, window: { ...doc.window, days: 90 } }), 11, "usage_response_invalid"],
      [(doc) => ({ ...doc, items: doc.items.map((item) => ({ ...item, calls: -1 })) }), 11, "usage_response_invalid"],
      [(doc) => ({ ...doc, items: doc.items.map((item) => ({ ...item, cost_usd: "0.01" })) }), 11, "usage_response_invalid"],
    ];
    for (const [hook, code, reason] of cases) {
      server.behavior.usage = hook;
      const { run, result } = await read(box, server, ["usage"]);
      assert.equal(run.code, code, reason);
      assert.equal(result.error.reason, reason);
      assert.equal(result.data.result, null);
      assert.equal(result.data.authenticated, true);
    }
  });
});

test("status checks /v1/deployment against the bound profile before the grant is used", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const bearerReads = () => server.requests.filter((request) => request.path.startsWith("/v1/agent/")).length;
    const cases = [
      [{ deploymentProfile: "managed" }, 11, "verification_failed", "profile_mismatch", false],
      [{ deploymentProfile: "SYNTHETIC_BODY_MARKER" }, 6, "unsupported", "unrecognized_profile", null],
      [{ deploymentStatus: 404 }, 6, "unsupported", "deployment_endpoint_missing", null],
      [{ deploymentStatus: 503 }, 5, "unhealthy", "service_unavailable", null],
    ];
    for (const [behavior, code, outcome, reason, verified] of cases) {
      Object.assign(server.behavior, { deploymentProfile: null, deploymentStatus: 200 }, behavior);
      const before = server.requests.length;
      const agentBefore = bearerReads();
      const { run, result } = await read(box, server, ["status"]);
      assert.equal(run.code, code, reason);
      assertFailure(result, outcome, reason);
      assert.equal(result.data.deployment_profile, "local");
      assert.equal(result.data.deployment_profile_verified, verified);
      assert.equal(result.data.reachable, true);
      assert.equal(result.data.authenticated, false);
      assert.deepEqual(since(server, before), ["GET /healthz", "GET /v1/deployment"]);
      assert.equal(bearerReads(), agentBefore, "the grant was used after a failed deployment check");
    }
    assert.equal(refreshes(server).length, 0);

    Object.assign(server.behavior, { deploymentProfile: "managed", deploymentStatus: 200 });
    const text = await read(box, server, ["status"], { json: false });
    assert.equal(text.run.code, 11);
    assert.match(text.run.stdout, /reported by the service: different/);
    assert.match(text.run.stdout, /Authenticated: no/);
  });
});

test("a credential the CLI holds is never printed, even inside a valid metadata string", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const slot = readBindingFile(box).credential_slot;
    const current = () => readCredential(openStore(box.config, { create: false }), slot);
    const { access_token: access, refresh_token: refresh } = current();
    const cases = [
      ["context", "workspace", (doc) => ({ ...PLAIN_WORKSPACE(doc), workspace: { ...PLAIN_WORKSPACE(doc).workspace, name: `Team ${refresh}` } })],
      ["context", "workspace", (doc) => ({ ...PLAIN_WORKSPACE(doc), workspace: { ...PLAIN_WORKSPACE(doc).workspace, slug: refresh } })],
      ["context", "workspace", (doc) => ({ ...PLAIN_WORKSPACE(doc), provenance: { ...doc.provenance, source: refresh } })],
      ["capabilities", "capabilities", (doc) => ({ ...doc, provenance: { ...doc.provenance, source: refresh } })],
      ["routes", "routes", (doc) => ({ ...doc, routes: [{ ...doc.routes[0], route: `route ${refresh}` }] })],
      ["usage", "usage", (doc) => ({ ...doc, items: [{ ...doc.items[0], route: refresh }] })],
      ["usage", "usage", (doc) => ({ ...doc, warnings: [{ code: refresh }] })],
      ["traces", "traces", (doc) => ({ ...doc, traces: [{ ...doc.traces[0], trace_name: `name ${refresh}` }] })],
      ["traces", "traces", (doc) => ({ ...doc, page: { ...doc.page, next_cursor: access }, next_cursor: access })],
    ];
    for (const [command, hook, rewrite] of cases) {
      server.behavior[hook] = rewrite;
      for (const json of [true, false]) {
        // checked() also proves no issued token appears anywhere in the output.
        const { run, result } = await read(box, server, [command], { json });
        assert.equal(run.code, 11, `${command} ${hook}`);
        assert.ok(!run.stdout.includes(refresh) && !run.stdout.includes(access));
        if (json) {
          assertFailure(result, "verification_failed", "credential_in_metadata_response");
          assert.deepEqual(result.data.notices, []);
          assert.ok(!JSON.stringify(result).includes("refresh_token"), "a credential key name was printed");
        }
      }
      server.behavior[hook] = hook === "workspace" ? PLAIN_WORKSPACE : (doc) => doc;
    }

    // A token a refresh just replaced is still known to this run.
    changeGrant(box, { expires_at: Date.now() - 1000 });
    const old = current().refresh_token;
    server.behavior.routes = (doc) => ({ ...doc, routes: [{ ...doc.routes[0], route: old }] });
    const rotated = await read(box, server, ["routes"]);
    assert.equal(refreshes(server).length, 1);
    assert.notEqual(current().refresh_token, old);
    assert.equal(rotated.run.code, 11);
    assertFailure(rotated.result, "verification_failed", "credential_in_metadata_response");
    assert.ok(!rotated.run.stdout.includes(old));
    server.behavior.routes = (doc) => doc;

    const fine = await read(box, server, ["context"]);
    assert.equal(fine.run.code, 0, fine.run.stdout);
  });
});

test("a deadline or Ctrl+C stops the wait for a held grant lock and leaves it untouched", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    changeGrant(box, { expires_at: Date.now() - 1000 });
    const slot = readBindingFile(box).credential_slot;
    const lock = path.join(box.config, "credentials", `${slot}.lock`);
    const record = path.join(box.config, "credentials", `${slot}.json`);
    fs.writeFileSync(lock, "held by another process", { mode: 0o600 });
    const lockBefore = fs.readFileSync(lock);
    const recordBefore = fs.readFileSync(record);
    const unchanged = () => {
      assert.deepEqual(fs.readFileSync(lock), lockBefore, "a held lock was changed or removed");
      assert.deepEqual(fs.readFileSync(record), recordBefore, "the saved grant was changed");
      assert.equal(refreshes(server).length, 0, "a refresh was sent without the lock");
    };

    const started = Date.now();
    const timed = await read(box, server, ["usage"], { timeoutMs: 1000 });
    assert.ok(Date.now() - started < 8000, "the deadline did not interrupt the lock wait");
    assert.equal(timed.run.code, 4);
    assertFailure(timed.result, "connection_failed", "timeout");
    assert.equal(timed.result.data.authenticated, false);
    assert.equal(server.requestsTo("/v1/agent/usage").length, 0);
    unchanged();

    if (isWindows) return;
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const seen = server.requestsTo("/v1/deployment").length;
      const cli = startCli(["--json", "status", "--project", box.project, "--config-dir", box.config]);
      for (let i = 0; i < 400 && server.requestsTo("/v1/deployment").length === seen; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(server.requestsTo("/v1/deployment").length, seen + 1);
      // Give the command time to reach the lock wait.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const sent = Date.now();
      cli.child.kill(signal);
      const run = await cli.done;
      assert.ok(Date.now() - sent < 5000, `${signal} did not interrupt the lock wait`);
      const { result } = checked(assert, run, { box, server });
      assert.equal(run.code, 17, signal);
      assertFailure(result, "cancelled", "cancelled");
      assert.equal(result.data.reachable, true);
      assert.equal(result.data.authenticated, false);
      unchanged();
    }
  });
});

test("captured content and secrets are never printed, and content-bearing rows fail closed", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    server.behavior.usage = (doc) => ({
      ...doc,
      prompt: "SYNTHETIC_BODY_MARKER prompt",
      debug: { access_token: "hunter2", output: "SYNTHETIC_BODY_MARKER" },
      warnings: [{ code: "partial_source", message: "SYNTHETIC_BODY_MARKER warning" }],
      items: doc.items.map((item, index) =>
        index === 0 ? { ...item, route: "\u001b[2Jcleared-screen", extra: "SYNTHETIC_BODY_MARKER" } : item,
      ),
    });
    for (const json of [true, false]) {
      const { run, result } = await read(box, server, ["usage"], { json });
      assert.equal(run.code, 0, run.stdout);
      assert.ok(!run.stdout.includes("\u001b"), "a terminal escape was printed");
      assert.ok(!run.stdout.includes("cleared-screen"));
      if (json) {
        assert.deepEqual(result.data.result.warnings, [{ code: "partial_source" }]);
        assert.equal(result.data.result.items[0].route, null);
        assert.ok(result.data.notices.includes("unsafe_text_omitted"));
        assert.ok(result.data.notices.includes("warning_messages_omitted"));
      }
    }

    const leaks = [
      ["usage", (doc) => ({ ...doc, items: [{ ...doc.items[0], prompt: "SYNTHETIC_BODY_MARKER" }] })],
      ["traces", (doc) => ({ ...doc, traces: [{ ...doc.traces[0], tool_calls: [{ arguments: "hunter2" }] }] })],
      ["routes", (doc) => ({ ...doc, routes: [{ ...doc.routes[0], api_key: "sk-fake-2222222222222222" }] })],
    ];
    for (const [command, hook] of leaks) {
      server.behavior[command] = hook;
      for (const json of [true, false]) {
        const { run, result } = await read(box, server, [command], { json });
        assert.equal(run.code, 11, command);
        if (json) assertFailure(result, "verification_failed", "content_in_metadata_response");
      }
    }
  });
});

test("an unavailable capability, a refusal, rate limiting and bad responses are distinct outcomes", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    const reads = () => READ_PATHS.reduce((count, route) => count + server.requestsTo(route).length, 0);

    server.behavior.capabilities = (doc) => ({
      ...doc,
      agent: { ...doc.agent, trace_metadata: { ...doc.agent.trace_metadata, available: false } },
    });
    const unavailable = await read(box, server, ["traces"]);
    assert.equal(unavailable.run.code, 14);
    assertFailure(unavailable.result, "capability_unavailable", "capability_unavailable");
    server.behavior.capabilities = (doc) => {
      const agent = { ...doc.agent };
      delete agent.usage;
      return { ...doc, agent };
    };
    const missing = await read(box, server, ["usage"]);
    assert.equal(missing.run.code, 14);
    server.behavior.capabilities = (doc) => ({ ...doc, bounds: { ...doc.bounds, max_rows: 10 } });
    const bounded = await read(box, server, ["usage", "--limit", "50"]);
    assert.equal(bounded.run.code, 6);
    assertFailure(bounded.result, "unsupported", "exceeds_service_bounds");
    assert.equal(reads(), 0, "a read was sent for an unavailable capability or out of bounds request");
    server.behavior.capabilities = (doc) => doc;

    const statuses = [
      [403, {}, 15, "permission_denied", "forbidden"],
      [403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="agent:read"' }, 15, "permission_denied", "insufficient_scope"],
      [429, { "retry-after": "30" }, 16, "rate_limited", "rate_limited"],
      [401, {}, 12, "login_required", "access_revoked"],
      [302, { location: "https://evil.example.com/steal" }, 7, "redirect_rejected", "redirect"],
      [404, {}, 6, "unsupported", "endpoint_unavailable"],
      [400, {}, 6, "unsupported", "request_rejected"],
      [500, {}, 5, "unhealthy", "server_error"],
    ];
    for (const [status, headers, code, outcome, reason] of statuses) {
      server.behavior.readStatus = status;
      server.behavior.readHeaders = headers;
      const before = reads();
      const { run, result } = await read(box, server, ["usage"]);
      assert.equal(run.code, code, `${status} ${reason}`);
      assertFailure(result, outcome, reason);
      assert.equal(reads(), before + 1, "a refused read was retried");
      if (status === 429) {
        assert.equal(result.data.retry_after_seconds, 30);
        assert.equal(result.data.next_action.kind, "retry_later");
      }
    }
    assert.equal(refreshes(server).length, 0, "a refused read triggered a refresh");
    server.behavior.readStatus = 200;
    server.behavior.readHeaders = {};

    server.behavior.readRaw = (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ padding: "a".repeat(1100 * 1024), note: "SYNTHETIC_BODY_MARKER" }));
      return true;
    };
    const large = await read(box, server, ["routes"]);
    assert.equal(large.run.code, 6);
    assertFailure(large.result, "unsupported", "response_too_large");

    server.behavior.readRaw = (request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>SYNTHETIC_BODY_MARKER</html>");
      return true;
    };
    const html = await read(box, server, ["routes"]);
    assert.equal(html.run.code, 11);
    assertFailure(html.result, "verification_failed", "read_response_invalid");
  });
});

test("one total deadline covers the whole read and is not reset per request", async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    // The read endpoint never answers.
    server.behavior.readRaw = () => true;
    const started = Date.now();
    const { run, result } = await read(box, server, ["usage"], { timeoutMs: 1000 });
    assert.equal(run.code, 4);
    assertFailure(result, "connection_failed", "timeout");
    assert.ok(Date.now() - started < 10000, "the deadline was not enforced");
  });
});

test("Ctrl+C during a read cancels cleanly with one JSON result", { skip: isWindows }, async () => {
  await withServer(async (server) => {
    const box = await signedIn(server);
    server.behavior.readRaw = () => true;
    const cli = startCli(["--json", "traces", "--project", box.project, "--config-dir", box.config]);
    for (let i = 0; i < 400 && server.requestsTo("/v1/agent/traces").length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(server.requestsTo("/v1/agent/traces").length, 1);
    cli.child.kill("SIGINT");
    const run = await cli.done;
    const { result } = checked(assert, run, { box, server });
    assert.equal(run.code, 17);
    assertFailure(result, "cancelled", "cancelled");
    assert.equal(result.data.authenticated, true);
  });
});

test("environment, time range, query and content requests are refused before any request", async () => {
  const box = sandbox();
  const cases = [
    [["usage", "--environment", "production"], "environment_selector_unsupported"],
    [["traces", "--environment=hunter2"], "environment_selector_unsupported"],
    [["traces", "--workload", "hunter2"], "workload_filter_unsupported"],
    [["status", "--environment", "staging"], "environment_selector_unsupported"],
    [["usage", "--since", "2026-01-01"], "time_range_unsupported"],
    [["traces", "--until=2026-02-01T00:00:00Z"], "time_range_unsupported"],
    [["usage", "--sql", "select * from hunter2"], "query_unsupported"],
    [["routes", "--query", "hunter2"], "query_unsupported"],
    [["traces", "--content"], "content_access_unsupported"],
    [["traces", "--include-content"], "content_access_unsupported"],
    [["traces", "--replay"], "content_access_unsupported"],
    [["context", "--debug"], "content_access_unsupported"],
  ];
  for (const [args, reason] of cases) {
    const json = await runCli(["--json", ...args, "--project", box.project], { offline: true, env: LOCAL_ENV });
    assert.equal(json.code, 6, reason);
    assert.equal(json.stderr, "");
    const result = parseJsonLine(json.stdout);
    assert.equal(result.outcome, "unsupported");
    assert.equal(result.error.reason, reason);
    assert.match(result.error.message, /No request was made/);
    assertNoLeak(assert, json.stdout, json.stderr);
    for (const value of ["production", "staging", "2026-01-01", "select * from hunter2", "hunter2"]) assert.ok(!json.stdout.includes(value));

    const text = await runCli(args, { offline: true, env: LOCAL_ENV });
    assert.equal(text.code, 6);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /^Error: /);
    assertNoLeak(assert, text.stdout, text.stderr);
  }
  assert.equal(fs.existsSync(path.join(box.project, ".metergraph")), false);
});

test("invalid read arguments and credential arguments exit 2 without echo or request", async () => {
  const cases = [
    [["usage", "--days", "0"], "invalid_days"],
    [["usage", "--days", "91"], "invalid_days"],
    [["traces", "--days", "1e1"], "invalid_days"],
    [["usage", "--limit", "201"], "invalid_limit"],
    [["routes", "--limit", "0"], "invalid_limit"],
    [["traces", "--status", "hunter2"], "invalid_status"],
    [["traces", "--cursor", "x".repeat(513)], "invalid_cursor"],
    [["traces", "--cursor", "has space hunter2"], "invalid_cursor"],
    [["traces", "--route", "\u001b[31mhunter2"], "invalid_route"],
    [["status", "--timeout-ms", "999"], "invalid_timeout"],
    [["status", "--timeout-ms", "60001"], "invalid_timeout"],
    [["status", "--limit", "5"], "unknown_argument"],
    [["routes", "--days", "5"], "unknown_argument"],
    [["status", "--url", "https://example.com"], "unknown_argument"],
    [["usage", "--token", "hunter2"], "unknown_argument"],
    [["traces", "--api-key=sk-fake-2222222222222222"], "unknown_argument"],
    [["context", "--access-token", "fake-token-1111111111111111"], "unknown_argument"],
    [["usage", "--days", "7", "--days", "8"], "duplicate_option"],
  ];
  for (const [args, reason] of cases) {
    const json = await runCli(["--json", ...args], { offline: true, env: LOCAL_ENV });
    assert.equal(json.code, 2, reason);
    assert.equal(json.stderr, "");
    const result = parseJsonLine(json.stdout);
    assert.equal(result.outcome, "invalid_input");
    assert.equal(result.error.reason, reason);
    assertNoLeak(assert, json.stdout, json.stderr);
    assert.ok(!json.stdout.includes("x".repeat(64)));
  }
});

test("read command help works offline and states what is not done", async () => {
  for (const command of ["status", "context", "capabilities", "usage", "routes", "traces"]) {
    for (const args of [["help", command], [command, "--help"]]) {
      const run = await runCli(args, { offline: true });
      assert.equal(run.code, 0);
      assert.equal(run.stderr, "");
      assert.match(run.stdout, new RegExp(`Usage: metergraph ${command}`));
      assert.match(run.stdout, /never opens a\s+browser|Never opens a\s+browser/);
      assert.match(run.stdout, /--environment/);
      assert.ok(!run.stdout.includes(String.fromCharCode(0x2014)), "help text contains an em dash");
    }
  }
  const json = parseJsonLine((await runCli(["help", "traces", "--json"], { offline: true })).stdout);
  assert.equal(json.data.topic, "traces");
});
