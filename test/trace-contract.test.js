import assert from "node:assert/strict";
import { test } from "node:test";
import { traceLink, traceReceipt, traceSelection } from "../src/trace-contract.js";
import { context, selection, traceDocument, TRACE_ID, REQUEST_ID, STARTED, SINCE, UNTIL } from "./fixtures/trace-server.js";

test("requires exactly one explicit identity and a bounded invocation window", () => {
  const now = Date.parse(UNTIL) + 1000;
  const options = selection();
  assert.equal(traceSelection(options, now).ok, true);
  for (const extra of [ { traceId: null }, { requestId: REQUEST_ID }, { traceId: "" }, { traceId: "a\n" }, { since: null }, { until: "2027-01-01T00:00:00Z" }, { since: UNTIL, until: SINCE }, { days: 0 }, { days: 91 }, { source: "latest" } ]) {
    assert.equal(traceSelection({ ...options, ...extra }, now).outcome, "invalid_input");
  }
  assert.equal(traceSelection(options, now + 2 * 86400000).reason, "invocation_window_outside_bounds");
  assert.equal(traceSelection({ ...options, source: undefined }, now).value.source, "unspecified");
});

test("metadata receipt keeps later readiness gates unknown and excludes unvalidated text", () => {
  const body = traceDocument();
  body.traces[0].trace_name = "not printed";
  body.warnings = [{ code: "example_warning", message: "not printed" }];
  body.unknown = "not printed";
  const result = traceReceipt(body, context(), selection());
  assert.equal(result.found, true);
  assert.deepEqual(result.value.readiness, { accepted: null, processed: true, metadata_available: true, capture_retained: null, classification_pending: null, analysis_ready: null });
  assert.equal(result.value.application_traffic_verified, false);
  assert.equal(result.value.link_status, "server_link_unavailable");
  assert.equal(JSON.stringify(result).includes("not printed"), false);
});

const mutations = [
  ["numeric schema", (b) => { b.schema_version = 1; }, "contract_version_unsupported"],
  ["wrong workspace", (b) => { b.provenance.workspace_id = "22222222-2222-4222-8222-222222222222"; }, "workspace_context_mismatch"],
  ["wrong profile", (b) => { b.provenance.deployment_profile = "managed"; }, "profile_mismatch"],
  ["wrong identity", (b) => { b.traces[0].trace_id = b.traces[0].id = "other-trace"; }, "trace_identity_mismatch"],
  ["stale trace", (b) => { b.traces[0].started_at = "2025-12-31T23:59:59Z"; }, "trace_outside_invocation_window"],
  ["later invocation", (b) => { b.traces[0].started_at = b.traces[0].last_span_at = "2026-01-01T00:00:10Z"; }, "trace_outside_invocation_window"],
  ["duplicate identities", (b) => { b.traces.push({ ...b.traces[0] }); b.evidence.rows = 2; }, "duplicate_trace_identity"],
  ["content", (b) => { b.traces[0].content = "not printed"; }, "content_in_metadata_response"],
  ["content envelope", (b) => { b.content_included = true; }, "content_in_metadata_response"],
  ["empty spans", (b) => { b.traces[0].span_count = 0; }, "trace_response_invalid"],
  ["incomplete evidence", (b) => { b.evidence.complete = false; }, "trace_evidence_incomplete"],
  ["no processed evidence", (b) => { b.evidence.sources = ["example-cache"]; }, "processed_trace_evidence_unavailable"],
];
for (const [name, mutate, reason] of mutations) test(`rejects ${name}`, () => {
  const body = traceDocument(); mutate(body);
  assert.equal(traceReceipt(body, context(), selection()).reason, reason);
});

test("request identity resolves exactly one multi-span SDK trace", () => {
  const selected = { ...selection(), traceId: null, requestId: REQUEST_ID };
  const body = traceDocument("https://example.com", { request: true });
  const result = traceReceipt(body, context(), selected);
  assert.equal(result.found, true);
  assert.equal(result.value.trace.trace_id, TRACE_ID);
  assert.equal(result.value.trace.span_count, 3);
  body.request_match.candidate_trace_count = 2;
  assert.equal(traceReceipt(body, context(), selected).reason, "ambiguous_trace_identity");
  delete body.request_match;
  assert.equal(traceReceipt(body, context(), selected).reason, "request_identity_unavailable");
});

test("zero request candidates remains pending and inconsistent mappings fail", () => {
  const selected = { ...selection(), traceId: null, requestId: REQUEST_ID };
  const body = traceDocument("https://example.com", { request: true, found: false });
  assert.equal(traceReceipt(body, context(), selected).found, false);
  body.request_match.candidate_trace_count = 1;
  assert.equal(traceReceipt(body, context(), selected).reason, "trace_response_invalid");
});

test("accepts the authoritative exact trace fragment, including server timestamps", () => {
  const body = traceDocument("https://example.com", { link: true });
  const result = traceReceipt(body, context(), selection());
  assert.equal(result.value.app_url, body.traces[0].metergraph_links.trace);
  assert.equal(result.value.link_status, "workspace_binding_unavailable");
  assert.equal(result.value.link_workspace_bound, false);
});

test("rejects unsafe, unrelated, credential-bearing and malformed trace destinations", () => {
  const trace = { trace_id: TRACE_ID, started_at: STARTED };
  const good = traceDocument("https://example.com", { link: true }).traces[0].metergraph_links.trace;
  const bad = [
    good.replace("example.com", "other.example.com"), good.replace("https://", "https://user:password@"),
    good.replace("/#traces?", "/redirect#traces?"), good.replace("/#traces?", "/?next=anything#traces?"),
    good + "&token=example-secret", good + "&trace=duplicate", good.replace("q=example-sdk-trace", "q=wrong-trace"),
    good.replace("01.001Z", "02.000Z"), good + "&env=%0A", good + "&env=%", good + "&env=%FF", "javascript:alert(1)", "//example.com/", "https://example.com/\\#traces?",
  ];
  for (const url of bad) assert.equal(traceLink(url, "https://example.com", trace).reason, "unsafe_trace_link", url);
});
