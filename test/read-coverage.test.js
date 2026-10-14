// Coverage, pricing and attribution evidence in the usage and traces
// projections. The documents under test/fixtures/agent-coverage were produced
// by the service's own real-database contract suite (the same documents its
// HTTP and MCP transports returned for one synthetic dataset), with the
// workspace ID, provider and model names replaced by synthetic values. This
// proves the CLI reads that contract the same way; it does not prove the
// service itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { combinePages, completenessOf, tracesReport, usageReport } from "../src/read-contract.js";
import { readText } from "../src/read-output.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "agent-coverage");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const textOf = (command, report, notices) =>
  readText({ command, ok: true, outcome: "ok", data: {
    origin: "http://127.0.0.1:9", workspace: { id: CTX.workspaceId }, result: report,
    notices: [...notices].sort(), retry_after_seconds: null, next_action: null,
  } }, null);
const CTX = { workspaceId: "00000000-0000-4000-8000-00000000c0de", profile: "local", origin: "http://127.0.0.1:9" };

function usage(body, request = { days: 7, limit: 2 }) {
  const notices = new Set();
  const result = usageReport(body, CTX, request, notices);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { report: result.value, notices };
}

function traces(body, request) {
  const notices = new Set();
  const result = tracesReport(body, CTX, { route: null, status: null, cursor: null, ...request }, notices);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { report: result.value, notices };
}

test("capped usage keeps returned-row totals apart from population totals and stays partial", () => {
  const { report, notices } = usage(fixture("usage-capped"));
  assert.equal(report.rows, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.complete, false);
  // The stable returned-rows totals are unchanged in shape and meaning.
  assert.equal(report.totals.scope, "returned_rows");
  assert.equal(report.totals.complete, false);
  // Population totals describe every matching call.
  assert.equal(report.population_totals.scope, "population");
  assert.equal(report.population_totals.calls, 6);
  assert.ok(report.population_totals.calls > report.totals.calls);
  assert.equal(report.coverage.completeness, "partial");
  assert.equal(report.coverage.rows.matched, 3);
  assert.ok(report.coverage.reasons.includes("row_limit"));
  assert.ok(report.coverage.reasons.includes("ingestion_pending"));
  assert.deepEqual(report.pricing, {
    priced_calls: 3, zero_cost_calls: 1, partial_calls: 1, unpriced_calls: 1, unknown_calls: 1, cost: "lower_bound",
  });
  assert.equal(report.attribution.level, "call");
  for (const token of ["coverage_partial", "pricing_lower_bound", "rows_truncated", "evidence_incomplete"]) {
    assert.ok(notices.has(token), token);
  }
  const text = textOf("usage", report, notices);
  assert.match(text, /All matching calls in the window: 6 calls/);
  assert.match(text, /Coverage: partial \(ingestion_pending, row_limit\); 2 of 3 rows returned/);
  assert.match(text, /Pricing: lower bound \(1 unpriced, 1 partially priced, 1 unknown, 3 priced of which 1 at zero\)/);
});

test("a full usage read is complete for rows while cost stays a lower bound", () => {
  const { report, notices } = usage(fixture("usage-complete"), { days: 7, limit: 3 });
  assert.equal(report.truncated, false);
  assert.equal(report.coverage.completeness, "complete");
  assert.equal(report.complete, true);
  assert.equal(report.pricing.cost, "lower_bound");
  assert.ok(!notices.has("coverage_partial"));
  assert.ok(notices.has("pricing_lower_bound"));
});

test("a restricted read that cannot verify ingestion is unknown, not complete", () => {
  const { report, notices } = usage(fixture("usage-restricted"), { days: 7, limit: 3 });
  assert.equal(report.coverage.completeness, "unknown");
  assert.equal(report.complete, false);
  assert.deepEqual(report.coverage.filters_applied, { environments: true });
  assert.ok(notices.has("coverage_unknown"));
});

test("mixed-provider traces are flagged and their totals are never per-provider", () => {
  const { report, notices } = traces(fixture("traces-mixed"), { days: 7, limit: 10 });
  const byId = Object.fromEntries(report.traces.map((trace) => [trace.trace_id, trace]));
  assert.equal(byId["trace-mixed"].mixed_providers, true);
  assert.deepEqual(byId["trace-mixed"].providers, ["example-provider-a", "example-provider-b"]);
  assert.equal(report.attribution.per_provider_exact, false);
  assert.equal(report.attribution.cost_basis, "trace_total");
  // A legitimately free trace is zero; an unpriced or unknown one is null.
  assert.equal(byId["trace-free"].cost_usd, 0);
  assert.equal(byId["trace-free"].pricing.zero_cost_calls, 1);
  assert.equal(byId["trace-unpriced"].cost_usd, null);
  assert.equal(byId["trace-legacy"].cost_usd, null);
  assert.equal(byId["trace-legacy"].pricing.unknown_calls, 1);
  assert.ok(notices.has("mixed_provider_traces"));
  assert.ok(notices.has("unpriced_traces"));
  // Pending ingestion makes even a cursor-free page partial.
  assert.equal(report.next_cursor, null);
  assert.equal(report.coverage.completeness, "partial");
  assert.equal(report.complete, false);
  const text = textOf("traces", report, notices);
  assert.match(text, /Costs: whole-trace totals; 1 trace used several providers, not split by provider/);
});

test("an interrupted page sequence is partial and a last page without a cursor is not proof of completeness", () => {
  const first = traces(fixture("traces-page-1"), { days: 7, limit: 2 }).report;
  assert.ok(first.next_cursor);
  assert.ok(first.coverage.reasons.includes("page_unread"));

  // Stopping after the first page leaves an unread cursor.
  const interrupted = combinePages([first]);
  assert.equal(interrupted.complete, false);
  assert.equal(interrupted.completeness, "partial");
  assert.ok(interrupted.reasons.includes("page_unread"));

  // The final page has no cursor, but the service says ingestion is still
  // pending, so the combined read stays partial.
  const last = { ...first, next_cursor: null, truncated: false, coverage: { ...first.coverage, next_cursor: null,
    reasons: first.coverage.reasons.filter((reason) => reason !== "page_unread") } };
  const combined = combinePages([first, last]);
  assert.equal(combined.next_cursor, null);
  assert.equal(combined.complete, false);
  assert.ok(combined.reasons.includes("ingestion_pending"));
  assert.ok(!combined.reasons.includes("page_unread"));

  // Only when no page carries any other reason is the sequence complete.
  const clean = (page, cursor) => ({ ...page, next_cursor: cursor, coverage: { ...page.coverage, next_cursor: cursor,
    reasons: cursor ? ["page_unread"] : ["pricing_missing"] } });
  assert.equal(combinePages([clean(first, "next"), clean(first, null)]).complete, true);

  // A page from a service that reports no coverage and no complete evidence
  // is unknown, never complete.
  const legacy = { ...first, coverage: null, next_cursor: null, truncated: false, evidence: { ...first.evidence, complete: false } };
  assert.equal(combinePages([legacy]).completeness, "unknown");
  assert.equal(combinePages([]).complete, false);
});

test("an older service without coverage keeps the stable result and says coverage is not reported", () => {
  const body = fixture("usage-complete");
  for (const key of ["coverage", "totals", "pricing", "attribution"]) delete body[key];
  for (const item of body.items) delete item.pricing;
  body.evidence.complete = true;
  const { report, notices } = usage(body, { days: 7, limit: 3 });
  assert.equal(report.coverage, null);
  assert.equal(report.population_totals, null);
  assert.equal(report.pricing, null);
  assert.equal(report.complete, true);
  assert.ok(notices.has("coverage_not_reported"));
});

test("a service claiming complete or exact against its own reasons and counts is not believed", () => {
  const body = fixture("usage-complete");
  body.coverage.reasons = [...body.coverage.reasons, "retention_clipped"];
  body.coverage.completeness = "complete";
  body.pricing = { ...body.pricing, cost: "exact" };
  const { report } = usage(body, { days: 7, limit: 3 });
  assert.equal(report.coverage.completeness, "partial");
  assert.equal(report.complete, false);
  assert.equal(report.pricing.cost, "lower_bound");

  assert.equal(completenessOf("complete", ["some_future_reason"]), "unknown");
  assert.equal(completenessOf("complete", ["pricing_missing"]), "complete");
  assert.equal(completenessOf("unknown", ["row_limit"]), "partial");
});

test("malformed coverage fails closed", () => {
  const body = fixture("usage-capped");
  body.coverage.completeness = "mostly";
  const result = usageReport(body, CTX, { days: 7, limit: 2 }, new Set());
  assert.deepEqual(result, { ok: false, outcome: "verification_failed", reason: "usage_response_invalid" });

  const page = fixture("traces-page-1");
  page.coverage.next_cursor = null;
  const mismatch = tracesReport(page, CTX, { days: 7, limit: 2, route: null, status: null, cursor: null }, new Set());
  assert.deepEqual(mismatch, { ok: false, outcome: "verification_failed", reason: "traces_response_invalid" });
});
