import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { runVerify } from "../src/verify.js";
import { openTrace } from "../src/trace-open.js";
import { traceReceipt } from "../src/trace-contract.js";
import { send as realSend } from "../src/transport.js";
import { context, selection, startTraceServer, traceDocument, capabilities, REQUEST_ID } from "./fixtures/trace-server.js";

function options(extra = {}) {
  const now = Date.now();
  return { traceId: "example-sdk-trace", since: new Date(now - 20000).toISOString(), until: new Date(now - 10000).toISOString(), days: 1, source: "synthetic", timeoutMs: 1000, maxAttempts: 2, pollIntervalMs: 100, ...extra };
}
function documentFor(origin, opts, config = {}) {
  const doc = traceDocument(origin, config);
  const started = new Date(Date.parse(opts.since) + 1000).toISOString();
  doc.window = { days: 1, since: opts.since, until: opts.until };
  doc.provenance.generated_at = new Date().toISOString();
  if (doc.traces.length) {
    doc.traces[0].started_at = started;
    doc.traces[0].last_span_at = new Date(Date.parse(started) + 1000).toISOString();
    if (config.link) doc.traces[0].metergraph_links.trace = origin + "/#traces?" + new URLSearchParams({ from: started, to: new Date(Date.parse(started) + 1).toISOString(), q: "example-sdk-trace", trace: "example-sdk-trace",
      ...(config.workspace ? { workspace: doc.provenance.workspace_id } : {}) });
  }
  return doc;
}
async function withServer(handler, work) {
  const service = await startTraceServer(handler);
  try { await work(service); } finally { await service.close(); }
}

test("polls pending Metadata until the exact processed trace is visible", async () => {
  const opts = options({ traceId: null, requestId: REQUEST_ID });
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { found: n > 1, request: true, link: true }) }), async (server) => {
    const result = await runVerify(opts, { session: server.session });
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.attempts, 2);
    assert.equal(result.data.application_traffic_verified, false);
    assert.equal(result.data.readiness.metadata_available, true);
    for (const r of server.requests) {
      assert.equal(r.method, "POST"); assert.equal(r.path, "/v1/agent/mcp");
      assert.equal(r.message.params.name, "metergraph_query_traces");
      assert.deepEqual(r.message.params.arguments, { days: 1, limit: 2, request_id: REQUEST_ID });
    }
    assert.equal(JSON.stringify(result).includes("example-access-secret"), false);
    assert.equal(JSON.stringify(result).includes("example-refresh-secret"), false);
  });
});

test("attempt exhaustion preserves pending receipt without initial ingestion success", async () => {
  const opts = options();
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { found: false }) }), async (server) => {
    const result = await runVerify(opts, { session: server.session });
    assert.equal(result.reason, "trace_not_found_within_bounds");
    assert.equal(result.data.attempts, 2);
    assert.equal(result.data.readiness.processed, false);
    assert.equal(server.requests.length, 2);
  });
});

test("one total deadline bounds a hanging response and releases signal listeners", async () => {
  const before = process.listenerCount("SIGINT");
  await withServer(() => ({ hang: true }), async (server) => {
    const start = Date.now();
    const result = await runVerify(options({ timeoutMs: 100 }), { session: server.session });
    assert.equal(result.outcome, "connection_failed"); assert.equal(result.reason, "verification_timeout");
    assert.ok(Date.now() - start < 1000);
  });
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("a deadline after the origin answered pending matches attempt exhaustion", async () => {
  const opts = options({ timeoutMs: 300, pollIntervalMs: 1000, maxAttempts: 5 });
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { found: false }) }), async (server) => {
    const result = await runVerify(opts, { session: server.session });
    assert.equal(result.outcome, "verification_failed"); assert.equal(result.reason, "trace_not_found_within_bounds");
    assert.equal(result.data.attempts, 1); assert.equal(result.data.readiness.processed, false);
    assert.equal(server.requests.length, 1);
  });
});

test("a deadline during a later poll that hangs still reports the trace as not yet visible", async () => {
  const opts = options({ timeoutMs: 400, pollIntervalMs: 100, maxAttempts: 5 });
  await withServer((r, n, origin) => n === 1 ? { document: documentFor(origin, opts, { found: false }) } : { hang: true }, async (server) => {
    const result = await runVerify(opts, { session: server.session });
    assert.equal(result.outcome, "verification_failed"); assert.equal(result.reason, "trace_not_found_within_bounds");
    assert.equal(result.data.attempts, 2); assert.equal(server.requests.length, 2);
  });
});

test("a transport failure after a pending answer is still a connection failure", async () => {
  const opts = options({ timeoutMs: 5000, pollIntervalMs: 100, maxAttempts: 5 });
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { found: false }) }), async (server) => {
    let calls = 0;
    const send = async (...args) => {
      calls += 1;
      if (calls === 1) return realSend(...args);
      return { kind: "error", reason: "network_error" };
    };
    const result = await runVerify(opts, { session: server.session, send });
    assert.equal(result.outcome, "connection_failed"); assert.equal(result.reason, "network_error");
    assert.equal(result.data.attempts, 2); assert.equal(server.requests.length, 1);
  });
});

test("deadline covers session and credential lock waits before any read", async () => {
  let read = false;
  const result = await runVerify(options({ timeoutMs: 100 }), {
    session: async ({ cancel }) => {
      // Simulate the real lock's referenced timer. AbortSignal.timeout alone
      // does not keep Node's event loop alive while a fake session waits.
      try { await wait(10000, null, { signal: cancel }); }
      catch (error) {
        assert.equal(error.name, "AbortError");
        return { ok: false, outcome: "authorization_failed", reason: "cancelled" };
      }
      assert.fail("the command deadline must interrupt the lock wait");
    },
    send: async () => { read = true; },
  });
  assert.equal(result.reason, "verification_timeout"); assert.equal(read, false);
});

test("outer cancellation stops polling without another request", async () => {
  const opts = options({ pollIntervalMs: 1000 });
  const cancel = new AbortController();
  await withServer((r, n, origin) => { setTimeout(() => cancel.abort(), 10); return { document: documentFor(origin, opts, { found: false }) }; }, async (server) => {
    const result = await runVerify({ ...opts, cancel: cancel.signal }, { session: server.session });
    assert.equal(result.outcome, "cancelled"); assert.equal(server.requests.length, 1);
  });
});

for (const [status, outcome] of [[401, "login_required"], [403, "permission_denied"], [429, "rate_limited"], [404, "unsupported"], [503, "unhealthy"], [302, "redirect_rejected"]]) test(`HTTP ${status} stops without retry`, async () => {
  await withServer(() => ({ status, headers: { location: "https://example.com/" } }), async (server) => {
    const result = await runVerify(options(), { session: server.session });
    assert.equal(result.outcome, outcome); assert.equal(server.requests.length, 1);
  });
});

test("known credentials in a permitted warning code are refused before opening", async () => {
  const opts = options({ open: true });
  await withServer((r, n, origin) => { const document = documentFor(origin, opts, { link: true }); document.warnings = [{ code: "example-access-secret" }]; return { document }; }, async (server) => {
    let opened = false;
    const result = await runVerify(opts, { session: server.session, launch: async () => { opened = true; return true; } });
    assert.equal(result.reason, "credential_in_metadata_response"); assert.equal(result.data, null); assert.equal(opened, false);
  });
});

test("missing capability and caller input failures make no Metadata query", async () => {
  await withServer(null, async (server) => {
    let result = await runVerify(options({ traceId: null }), { session: server.session });
    assert.equal(result.outcome, "invalid_input");
    result = await runVerify(options(), { session: async () => { const s = await server.session(); s.documents.capabilities = capabilities(); s.documents.capabilities.agent.trace_metadata.available = false; return s; } });
    assert.equal(result.outcome, "capability_unavailable"); assert.equal(server.requests.length, 0);
  });
});

test("an installed service without exact identity support reports unsupported without fallback", async () => {
  await withServer((r) => ({ message: { jsonrpc: "2.0", id: r.message.id, error: { code: -32602, message: "not printed" } } }), async (server) => {
    const result = await runVerify(options(), { session: server.session });
    assert.equal(result.outcome, "unsupported"); assert.equal(result.reason, "identity_query_unavailable");
    assert.equal(server.requests.length, 1); assert.equal(JSON.stringify(result).includes("not printed"), false);
  });
});

test("JSON and no-browser modes return the server URL without a launcher", async () => {
  const doc = traceDocument("https://example.com", { link: true });
  doc.traces[0].metergraph_links.trace += "&workspace=" + doc.provenance.workspace_id;
  const receipt = traceReceipt(doc, context(), selection()).value;
  assert.equal(receipt.link_workspace_bound, true);
  for (const [extra, browser] of [[{ json: true }, "suppressed_by_json"], [{ json: true, noBrowser: true }, "suppressed_by_json"],
    [{ noBrowser: true }, "suppressed_by_no_browser"], [{ open: false }, "not_requested"]]) {
    const result = await openTrace(receipt, { open: true, ...extra }, async () => { assert.fail("launcher should not run"); });
    assert.equal(result.outcome, "ok"); assert.equal(result.data.app_url, receipt.app_url);
    assert.equal(result.data.browser, browser);
  }
  const opened = await openTrace(receipt, { open: true }, async (url) => { assert.equal(url, receipt.app_url); return true; });
  assert.equal(opened.data.browser, "launcher_started");
  const failed = await openTrace(receipt, { open: true }, async () => false);
  assert.equal(failed.data.browser, "launcher_unavailable");
});

test("open requires a verified receipt and reports absent canonical links as unsupported", async () => {
  const receipt = traceReceipt(traceDocument(), context(), selection()).value;
  assert.equal((await openTrace(receipt, { open: true })).reason, "server_link_unavailable");
  assert.equal((await openTrace({ ...receipt, readiness: {} }, { open: true })).reason, "verified_trace_required");
});

test("browser launch honors cancellation of a trusted workspace-bound receipt", async () => {
  const doc = traceDocument("https://example.com", { link: true });
  doc.traces[0].metergraph_links.trace += "&workspace=" + doc.provenance.workspace_id;
  const receipt = traceReceipt(doc, context(), selection()).value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    const result = await openTrace(receipt, { open: true, signal: controller.signal }, () => new Promise(() => {}));
    assert.equal(result.outcome, "cancelled");
  } finally { clearTimeout(timer); }
});

test("a deadline while launching a found trace is never reported as not found", async () => {
  const opts = options({ open: true, timeoutMs: 200 });
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { link: true, workspace: true }) }), async (server) => {
    const result = await runVerify(opts, { session: server.session, launch: () => new Promise(() => {}) });
    assert.equal(result.outcome, "verification_failed"); assert.equal(result.reason, "verification_timeout");
    assert.equal(result.data.readiness.processed, true);
  });
});

test("verified workspace-bound server link opens only the exact trace", async () => {
  const opts = options({ open: true });
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { link: true, workspace: true }) }), async (server) => {
    let launched = null;
    const result = await runVerify(opts, { session: server.session, launch: async (url) => { launched = url; return true; } });
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.link_workspace_bound, true);
    assert.equal(result.data.browser, "launcher_started");
    assert.equal(new URLSearchParams(new URL(launched).hash.slice(8)).get("workspace"), result.data.workspace.id);
  });
});

test("wrong workspace in a server link refuses output and browser launch", async () => {
  const opts = options({ open: true });
  await withServer((r, n, origin) => {
    const document = documentFor(origin, opts, { link: true, workspace: true });
    document.traces[0].metergraph_links.trace =
      document.traces[0].metergraph_links.trace.replace(document.provenance.workspace_id, "22222222-2222-4222-8222-222222222222");
    return { document };
  }, async (server) => {
    const result = await runVerify(opts, { session: server.session, launch: () => { assert.fail("mismatched workspace"); } });
    assert.equal(result.reason, "unsafe_trace_link");
    assert.equal(result.data, null);
  });
});

test("a canonical link without browser workspace selection is returned but never opened", async () => {
  const opts = options({ open: true, json: true });
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts, { link: true }) }), async (server) => {
    const result = await runVerify(opts, { session: server.session, launch: () => { assert.fail("unbound workspace link must not launch"); } });
    assert.equal(result.outcome, "unsupported"); assert.equal(result.reason, "link_workspace_binding_unavailable");
    assert.equal(result.data.link_workspace_bound, false); assert.equal(result.data.link_status, "workspace_binding_unavailable");
    assert.equal(typeof result.data.app_url, "string"); assert.equal(result.data.browser, "not_requested");
  });
});

test("URI-encoded known credentials in a server link never reach output or launcher", async () => {
  const opts = options({ open: true });
  await withServer((r, n, origin) => {
    const document = documentFor(origin, opts, { link: true });
    document.traces[0].metergraph_links.trace += "&env=" + encodeURIComponent("example+refresh/secret");
    return { document };
  }, async (server) => {
    const result = await runVerify(opts, {
      session: async () => ({ ...(await server.session()), knownCredentials: ["example+refresh/secret"] }),
      launch: async () => { assert.fail("credential-bearing URL should never launch"); },
    });
    assert.equal(result.reason, "credential_in_metadata_response"); assert.equal(result.data, null);
  });
});

test("malformed escapes cannot bypass suppression of an encoded link credential", async () => {
  const opts = options({ open: true });
  for (const suffix of ["%", "%FF"]) await withServer((r, n, origin) => {
    const document = documentFor(origin, opts, { link: true });
    document.traces[0].metergraph_links.trace += "&env=" + encodeURIComponent("example+refresh/secret") + suffix;
    return { document };
  }, async (server) => {
    const result = await runVerify(opts, {
      session: async () => ({ ...(await server.session()), knownCredentials: ["example+refresh/secret"] }),
      launch: async () => { assert.fail("credential-bearing URL should never launch"); },
    });
    assert.equal(result.reason, "unsafe_trace_link"); assert.equal(result.data, null);
  });
});

test("known credentials matching an allowed receipt field name suppress all output", async () => {
  const opts = options();
  await withServer((r, n, origin) => ({ document: documentFor(origin, opts) }), async (server) => {
    const result = await runVerify(opts, { session: async () => ({ ...(await server.session()), knownCredentials: ["provenance"] }) });
    assert.equal(result.reason, "credential_in_metadata_response"); assert.equal(result.data, null);
  });
});
