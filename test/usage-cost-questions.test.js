// Grouped usage: the cost questions "usage" answers, run as subprocesses
// against the synthetic loopback service after a real "metergraph login".
// The grouped documents it serves (test/fixtures/usage-aggregates) were
// returned by the service's GET /v1/agent/usage/aggregates for one synthetic
// dataset in a real PostgreSQL database, and its MCP tool returned the same
// document for each (parity.json records both requests). The workspace ID is
// replaced by a synthetic one. This proves the CLI reads that contract and
// renders it; it does not prove a deployed service or a published package.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { LOCAL_ENV, checked, login, sandboxes } from "./auth-helpers.js";
import { parseJsonLine, runCli } from "./helpers.js";
import { aggregateFixture, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph usage questions "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);
const AGGREGATES = "/v1/agent/usage/aggregates";
const PARITY = aggregateFixture("parity");
const recorded = (name) => PARITY.find((entry) => entry.fixture === name);

async function withSignedIn(work, initial = {}) {
  const server = await startOAuthServer(initial);
  try {
    const box = sandbox();
    const { run } = await login(assert, box, server);
    assert.equal(run.code, 0, run.stdout);
    return await work(server, box);
  } finally {
    await server.close();
  }
}

async function usage(box, server, args, { json = true } = {}) {
  const full = ["usage", ...args, "--project", box.project, "--config-dir", box.config];
  const run = await runCli(json ? ["--json", ...full] : full, { env: LOCAL_ENV });
  return checked(assert, run, { box, server, json });
}

const queries = (server) => server.requestsTo(AGGREGATES).map((request) => request.query);

// Every grouped answer must carry the same envelope, window semantics and
// coverage evidence, in both output modes.
function assertEnvelope(result, fixtureName) {
  const doc = aggregateFixture(fixtureName);
  assert.deepEqual(Object.keys(result), ["schema_version", "command", "ok", "outcome", "exit_code", "data", "error"]);
  assert.equal(result.command, "usage");
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  const report = result.data.result;
  assert.equal(report.source, "usage_aggregates");
  assert.equal(report.window.timezone, "UTC");
  assert.equal(report.window.since, doc.window.since);
  if (doc.window.until_is_request_time) {
    // The replay ends a "now" window at the replay's request time.
    assert.ok(Math.abs(Date.parse(report.window.until) - Date.now()) < 5 * 60 * 1000);
  } else {
    assert.equal(report.window.until, doc.window.until);
  }
  // Parity with the service's own read: same totals, groups and window.
  assert.equal(report.totals.calls, doc.totals.calls);
  assert.equal(report.totals.error_calls, doc.totals.error_calls);
  assert.equal(report.totals.cost_usd, doc.totals.cost_usd);
  assert.equal(report.rows, doc.items.length);
  assert.equal(report.matched_groups, doc.coverage.rows.matched);
  assert.equal(report.coverage.completeness === "complete" || report.coverage.completeness === "partial" ||
    report.coverage.completeness === "unknown", true);
  assert.equal(report.pricing.cost, doc.pricing.cost === "exact" && doc.pricing.unknown_calls === 0 ? "exact" : "lower_bound");
  assert.equal(report.attribution.level, "call");
  assert.equal(report.attribution.per_provider_exact, true);
  assert.equal(recorded(fixtureName).http_equals_mcp_excluding_request_time, true);
  return report;
}

test("most expensive route today: routes ranked by cost over today's UTC window so far", async () => {
  await withSignedIn(async (server, box) => {
    const { run, result } = await usage(box, server, ["--group-by", "route", "--today"]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(queries(server), [{ group_by: "route", days: "1", limit: "50" }]);
    const report = assertEnvelope(result, "route-today");
    assert.equal(report.window.preset, "utc_days");
    assert.equal(report.window.days, 1);
    assert.ok(report.window.since.startsWith(report.window.until.slice(0, 10)));
    assert.match(report.window.since, /T00:00:00/);
    assert.deepEqual(report.window.partial_days, [report.window.until.slice(0, 10)]);
    assert.deepEqual(report.items.map((item) => [item.rank, item.route]), [[1, "support"], [2, "research"], [3, "classifier"]]);
    assert.deepEqual(report.sort, { by: "cost", meaning: "cost, highest first", complete: true });
    assert.equal(report.items[0].cost_per_call_usd, 0.4);
    assert.equal(report.items[0].error_rate, 0.5);
    assert.equal(report.items[0].latency.p95_method, "histogram_estimate");
    assert.equal(report.complete, true);
    assert.ok(result.data.notices.includes("current_day_partial"));
    assert.equal(result.data.next_action, null);

    const text = await usage(box, server, ["--group-by", "route", "--today"], { json: false });
    assert.equal(text.run.code, 0);
    assert.match(text.run.stdout, /Window +\S+T00:00:00\S* to \S+ UTC, [\d.]+ h \(today so far; partial UTC day/);
    assert.match(text.run.stdout, /#\s+ROUTE\s+COST\s+CALLS\s+COST\/CALL\s+ERRORS\s+AVG_MS\s+P95_MS_EST/);
    assert.match(text.run.stdout, /1\s+support\s+\$0\.8000/);
    assert.match(text.run.stdout, /Coverage: complete; 3 of 3 rows returned/);
    assert.match(text.run.stdout, /Pricing: exact/);
    assert.match(text.run.stdout, /Attribution: per call/);
    assert.match(text.run.stdout, /P95_MS_EST is estimated from a fixed latency histogram/);
  });
});

test("spend with one provider: an exact provider filter the service must echo", async () => {
  await withSignedIn(async (server, box) => {
    const { result } = await usage(box, server, ["--group-by", "provider", "--provider", "provider-a", "--days", "7"]);
    assert.deepEqual(queries(server), [{ group_by: "provider", days: "7", limit: "50", provider: "provider-a" }]);
    const report = assertEnvelope(result, "provider-spend");
    assert.deepEqual(report.items.map((item) => item.provider), ["provider-a"]);
    assert.equal(report.filters.provider, 1);
    assert.equal(report.coverage.filters_applied.provider, true);
    assert.equal(report.window.preset, "utc_days");
    // The provider name is not echoed back from the argument, only counted.
    assert.ok(!JSON.stringify(report.filters).includes("provider-a"));

    // A service that applied another filter is refused.
    server.behavior.usage = (doc) => ({
      ...doc,
      coverage: { ...doc.coverage, filters: { ...doc.coverage.filters, provider: ["provider-b"] } },
    });
    const mismatch = await usage(box, server, ["--group-by", "provider", "--provider", "provider-a", "--days", "7"]);
    assert.equal(mismatch.run.code, 11);
    assert.equal(mismatch.result.error.reason, "filter_mismatch");
    assert.equal(mismatch.result.data.result, null);
  });
});

test("spend by model: grouped by model with all-calls totals", async () => {
  await withSignedIn(async (server, box) => {
    const { result } = await usage(box, server, ["--group-by", "model"]);
    assert.deepEqual(queries(server), [{ group_by: "model", days: "7", limit: "50" }]);
    const report = assertEnvelope(result, "model-spend");
    assert.deepEqual(report.items.map((item) => item.model), ["model-large", "model-medium", "model-small"]);
    // One call has no price: the totals are a lower bound and say so.
    assert.equal(report.pricing.cost, "lower_bound");
    assert.ok(result.data.notices.includes("pricing_lower_bound"));

    const byCalls = await usage(box, server, ["--group-by", "model", "--sort", "calls"]);
    assert.deepEqual(byCalls.result.data.result.items.map((item) => item.model), ["model-large", "model-small", "model-medium"]);
    assert.equal(byCalls.result.data.result.sort.complete, true);
    const byP95 = await usage(box, server, ["--group-by", "model", "--sort", "p95-latency"]);
    const p95 = byP95.result.data.result.items.map((item) => item.latency.p95_ms);
    assert.deepEqual(p95, [...p95].sort((a, b) => b - a));
  });
});

test("one route's daily trend: grouped by UTC day, oldest first, today marked partial", async () => {
  await withSignedIn(async (server, box) => {
    const { result } = await usage(box, server, ["--route", "support", "--group-by", "day", "--days", "7"]);
    assert.deepEqual(queries(server), [{ group_by: "day", days: "7", limit: "50", route: "support" }]);
    const report = assertEnvelope(result, "route-daily");
    const days = report.items.map((item) => item.day);
    assert.deepEqual(days, [...days].sort());
    assert.equal(report.sort.by, "day");
    assert.equal(report.items.at(-1).partial_day, true);
    assert.ok(report.items.slice(0, -1).every((item) => item.partial_day === false));
    const text = await usage(box, server, ["--route", "support", "--group-by", "day"], { json: false });
    assert.match(text.run.stdout, /DAY_UTC/);
    assert.match(text.run.stdout, /\d{4}-\d{2}-\d{2} \(partial\)/);
    assert.match(text.run.stdout, /Filters +exact match on route \(1 value\)/);
  });
});

test("cost ranked by a prompt metadata key stays distinct from route", async () => {
  await withSignedIn(async (server, box) => {
    const { run, result } = await usage(box, server, ["--group-by", "metadata.prompt_id", "--days", "7"]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(server.requestsTo(AGGREGATES)[0].query, { group_by: "metadata.prompt_id", days: "7", limit: "50" });
    const report = assertEnvelope(result, "prompt-cost");
    assert.deepEqual(report.group_by, ["metadata.prompt_id"]);
    assert.deepEqual(
      report.items.map((item) => [item.rank, item.metadata_key, item.metadata_value, item.has_value]),
      [
        [1, "prompt_id", "research-v1", true],
        [2, "prompt_id", "reply-v3", true],
        [3, "prompt_id", "reply-v2", true],
        [4, "prompt_id", null, false],
      ],
    );
    // Calls without the key (or with a non-string value) are one counted
    // group, so the groups add up to the totals and coverage stays complete.
    assert.equal(report.items.reduce((sum, item) => sum + item.calls, 0), report.totals.calls);
    assert.ok(report.coverage.reasons.includes("metadata_key_missing"));
    assert.ok(report.coverage.reasons.includes("metadata_value_ineligible"));
    assert.equal(report.coverage.completeness, "complete");
    assert.ok(result.data.notices.includes("metadata_values_missing"));
    // Spend no prompt_id value accounts for is reported, split by why.
    assert.deepEqual(report.metadata_groups, {
      key: "prompt_id",
      listed_with_value: { calls: 9, cost_usd: 3.6 },
      unlisted: {
        other_values: { groups: 0, calls: 0, cost_usd: 0 },
        missing_key: { calls: 4, cost_usd: 0.05 },
        ineligible_value: { calls: 1, cost_usd: 0.02 },
      },
      unattributed: { calls: 5, cost_usd: 0.07 },
    });

    // Cut by --limit: the values past it are totalled, never dropped.
    const cut = await usage(box, server, ["--group-by", "metadata.prompt_id", "--limit", "2"]);
    const cutReport = assertEnvelope(cut.result, "prompt-cost-truncated");
    assert.equal(cutReport.truncated, true);
    assert.deepEqual(cutReport.metadata_groups.unlisted.other_values, { groups: 1, calls: 2, cost_usd: 0.7 });
    const cutText = await usage(box, server, ["--group-by", "metadata.prompt_id", "--limit", "2"], { json: false });
    assert.match(cutText.run.stdout, /1 more values past --limit: 2 calls \(\$0\.7000\)/);
    assert.match(cutText.run.stdout, /Not attributed to any prompt_id value: 5 calls \(\$0\.0700\): without the key 4/);

    // Buckets that do not add up to the totals are refused.
    server.behavior.usage = (doc) => ({
      ...doc,
      metadata_groups: {
        ...doc.metadata_groups,
        unlisted: { ...doc.metadata_groups.unlisted, missing_key: { calls: 99, cost_usd: 0 } },
      },
    });
    const broken = await usage(box, server, ["--group-by", "metadata.prompt_id"]);
    assert.equal(broken.run.code, 11);
    assert.equal(broken.result.error.reason, "usage_response_invalid");
    server.behavior.usage = (doc) => doc;

    // --group-by-metadata is the same dimension, and one route carries
    // several prompt IDs.
    const same = await usage(box, server, ["--group-by-metadata", "prompt_id"]);
    assert.deepEqual(same.result.data.result.items, report.items);
    const byRoute = await usage(box, server, ["--group-by", "route", "--group-by-metadata", "prompt_id"]);
    assert.equal(byRoute.run.code, 0, byRoute.run.stdout);
    assert.deepEqual(server.requestsTo(AGGREGATES).at(-1).query.group_by, "metadata.prompt_id");
    const routeReport = assertEnvelope(byRoute.result, "route-prompt");
    const support = routeReport.items.filter((item) => item.route === "support").map((item) => item.metadata_value);
    assert.deepEqual(support, ["reply-v3", "reply-v2"]);

    const text = await usage(box, server, ["--group-by", "metadata.prompt_id"], { json: false });
    assert.match(text.run.stdout, /METADATA_VALUE/);
    assert.match(text.run.stdout, /\(no value\)/);
    assert.match(text.run.stdout, /Metadata key +prompt_id/);

    // An exact metadata filter is echoed by the service and confirmed.
    const filtered = await usage(box, server, ["--group-by", "route", "--metadata", "prompt_id=reply-v3"]);
    assert.equal(filtered.run.code, 0, filtered.run.stdout);
    const filteredReport = assertEnvelope(filtered.result, "prompt-filter");
    assert.deepEqual(filteredReport.filters.metadata, { count: 1, keys: ["prompt_id"] });
    assert.ok(!filtered.run.stdout.includes("reply-v3"), "a filter value was printed back");
  });
});

test("comparison with the prior period warns when a partial UTC day meets a whole one", async () => {
  await withSignedIn(async (server, box) => {
    const { run, result } = await usage(box, server, ["--group-by", "route", "--today", "--compare", "previous"]);
    assert.equal(run.code, 0, run.stdout);
    const current = aggregateFixture("route-today");
    const prior = aggregateFixture("compare-prior");
    const sent = queries(server);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], { group_by: "route", days: "1", limit: "50" });
    assert.equal(Date.parse(sent[1].since), Date.parse(prior.window.since));
    assert.equal(Date.parse(sent[1].until), Date.parse(current.window.since));
    const report = assertEnvelope(result, "route-today");
    const comparison = report.comparison;
    assert.equal(comparison.mode, "previous");
    assert.equal(comparison.prior.window.hours, 24);
    assert.ok(comparison.hours.current < 24);
    assert.equal(comparison.partial_day_compared_with_full, true);
    assert.ok(result.data.notices.includes("partial_day_comparison"));
    assert.ok(result.data.notices.includes("prior_pricing_lower_bound"));
    assert.equal(result.data.next_action.kind, "compare_like_for_like");
    assert.match(result.data.next_action.message, /--compare previous-same-time/);
    assert.equal(comparison.totals.prior.cost_usd, prior.totals.cost_usd);
    // The prior day's cost is a lower bound, so the total change is unknown,
    // not a number that could have the wrong sign.
    assert.equal(prior.pricing.cost, "lower_bound");
    assert.deepEqual(comparison.totals.cost_change, { delta: null, percent: null });
    assert.equal(comparison.totals.cost_change_known, false);
    assert.deepEqual(comparison.totals.calls_change.delta, current.totals.calls - prior.totals.calls);
    // A group priced exactly in both windows has a known change; one with a
    // lower bound does not.
    const support = comparison.items.find((item) => item.route === "support");
    assert.deepEqual([support.current.cost_usd, support.prior.cost_usd], [0.8, 0.35]);
    assert.deepEqual(support.cost_change, { delta: 0.45, percent: 128.6 });
    const research = comparison.items.find((item) => item.route === "research");
    assert.deepEqual(research.cost_change, { delta: null, percent: null });

    const text = await usage(box, server, ["--group-by", "route", "--today", "--compare", "previous"], { json: false });
    assert.match(text.run.stdout, /Compared with the whole previous period: \S+ to \S+ UTC, 24 h/);
    assert.match(text.run.stdout, /Not like for like: [\d.]+ h now against 24 h before/);
    // The comparison lines say it once; the notice is not repeated in text.
    assert.ok(!text.run.stdout.includes("partial current UTC day is compared with a whole prior period"));
    assert.ok(!text.run.stdout.includes("ends now, part way through the current UTC day"));
    const bullets = text.run.stdout.split("\n").filter((line) => line.trimStart().startsWith("! "));
    assert.equal(new Set(bullets).size, bullets.length);
    assert.match(text.run.stdout, /--compare previous-same-time/);

    const same = await usage(box, server, ["--group-by", "route", "--today", "--compare", "previous-same-time"]);
    assert.equal(same.run.code, 0, same.run.stdout);
    const sameReport = same.result.data.result;
    assert.equal(sameReport.comparison.partial_day_compared_with_full, false);
    assert.equal(sameReport.comparison.hours.current, sameReport.comparison.hours.prior);
    assert.ok(!same.result.data.notices.includes("partial_day_comparison"));
    assert.equal(same.result.data.next_action, null);

    const week = await usage(box, server, ["--group-by", "provider", "--days", "7", "--compare", "previous"]);
    assert.equal(week.run.code, 0, week.run.stdout);
    assert.equal(week.result.data.result.comparison.prior.window.hours, 7 * 24);
    assert.equal(week.result.data.result.comparison.partial_day_compared_with_full, true);
  });
});

test("a ranking over a cut list says so and names the limit that ranks every group", async () => {
  await withSignedIn(async (server, box) => {
    const { result } = await usage(box, server, ["--group-by", "provider,model", "--limit", "2", "--sort", "calls"]);
    const report = assertEnvelope(result, "provider-model-truncated");
    assert.equal(report.truncated, true);
    assert.equal(report.complete, false);
    assert.equal(report.coverage.completeness, "partial");
    assert.ok(report.coverage.reasons.includes("row_limit"));
    assert.equal(report.sort.complete, false);
    assert.ok(result.data.notices.includes("ranking_partial"));
    assert.ok(result.data.notices.includes("groups_truncated"));
    assert.deepEqual(result.data.next_action.kind, "raise_limit");
    assert.match(result.data.next_action.message, /--limit 3/);
    // The all-calls totals still cover every matching call.
    assert.ok(report.totals.calls > report.items.reduce((sum, item) => sum + item.calls, 0));
  });
});

test("environment filters and an environment-restricted grant are reported, not hidden", async () => {
  await withSignedIn(async (server, box) => {
    const { result } = await usage(box, server, ["--group-by", "route", "--environment", "staging"]);
    assert.deepEqual(queries(server)[0], { group_by: "route", days: "7", limit: "50", environment: "staging" });
    const report = assertEnvelope(result, "environment-filter");
    assert.equal(report.filters.environment, 1);

    server.behavior.usage = () => aggregateFixture("provider-prod-key");
    const restricted = await usage(box, server, ["--group-by", "provider"]);
    assert.equal(restricted.run.code, 11, "a document for another workspace must be refused");
    server.behavior.usage = (doc) => {
      // The restricted key's recorded document, ending at this replay's
      // request time like the document it replaces.
      const recordedDoc = aggregateFixture("provider-prod-key");
      return {
        ...recordedDoc,
        provenance: doc.provenance,
        window: doc.window,
        completeness: doc.completeness,
        coverage: {
          ...recordedDoc.coverage,
          as_of: doc.coverage.as_of,
          requested_window: doc.coverage.requested_window,
          effective_window: doc.coverage.effective_window,
        },
      };
    };
    const own = await usage(box, server, ["--group-by", "provider"]);
    assert.equal(own.run.code, 0, own.run.stdout);
    assert.ok(own.result.data.notices.includes("environment_restricted_key"));
    assert.equal(own.result.data.result.coverage.completeness, "unknown");
    assert.equal(own.result.data.result.complete, false);
  });
});

test("no matching calls is an empty, complete answer", async () => {
  await withSignedIn(async (server, box) => {
    const { result } = await usage(box, server, ["--group-by", "model", "--provider", "provider-none"]);
    const report = assertEnvelope(result, "empty");
    assert.equal(report.empty, true);
    assert.equal(report.totals.cost_per_call_usd, null);
    const text = await usage(box, server, ["--group-by", "model", "--provider", "provider-none"], { json: false });
    assert.match(text.run.stdout, /No calls match this window and these filters/);
  });
});

test("a deployment without grouped usage gets exit 14 and a supported next step, with nothing read", async () => {
  await withSignedIn(async (server, box) => {
    server.behavior.capabilities = (doc) => {
      const agent = { ...doc.agent };
      delete agent.usage_aggregates;
      return { ...doc, agent };
    };
    const { run, result } = await usage(box, server, ["--group-by", "provider", "--today"]);
    assert.equal(run.code, 14);
    assert.equal(result.outcome, "capability_unavailable");
    assert.equal(result.error.reason, "usage_aggregates_unavailable");
    assert.equal(result.data.next_action.kind, "use_supported_read");
    assert.equal(result.data.next_action.command, "metergraph usage --days 7 --json");
    assert.equal(server.requestsTo(AGGREGATES).length, 0);
    // The route-by-day read still works on that deployment.
    const legacy = await usage(box, server, ["--days", "7"]);
    assert.equal(legacy.run.code, 0, legacy.run.stdout);
    const text = await usage(box, server, ["--group-by", "provider"], { json: false });
    assert.equal(text.run.code, 14);
    assert.match(text.run.stdout, /does not offer grouped usage/);
    assert.match(text.run.stdout, /metergraph usage --days N/);
  });
});

test("the service's time budget and size budget give distinct, actionable outcomes", async () => {
  await withSignedIn(async (server, box) => {
    const busy = aggregateFixture("error-busy");
    server.behavior.readRaw = (request, response, path) => {
      if (path !== AGGREGATES) return false;
      response.writeHead(busy.status, { "content-type": "application/json", "retry-after": busy.retry_after });
      response.end(JSON.stringify(busy.body));
      return true;
    };
    const slow = await usage(box, server, ["--group-by", "route", "--days", "30"]);
    assert.equal(slow.run.code, 5);
    assert.equal(slow.result.error.reason, "temporarily_unavailable");
    assert.equal(slow.result.data.retry_after_seconds, 5);
    assert.equal(slow.result.data.next_action.kind, "retry_later");
    assert.match(slow.result.data.next_action.message, /Narrow the read/);
    assert.equal(server.requestsTo(AGGREGATES).length, 1, "a budget refusal was retried");

    const large = aggregateFixture("error-too-large");
    server.behavior.readRaw = (request, response, path) => {
      if (path !== AGGREGATES) return false;
      response.writeHead(large.status, { "content-type": "application/json" });
      response.end(JSON.stringify(large.body));
      return true;
    };
    const tooLarge = await usage(box, server, ["--group-by", "route"]);
    assert.equal(tooLarge.run.code, 6);
    assert.equal(tooLarge.result.error.reason, "response_too_large");
    assert.equal(tooLarge.result.data.next_action.kind, "narrow_read");
    // Server message text is never printed.
    assert.ok(!tooLarge.run.stdout.includes(large.body.error.message));
  });
});

test("a document for another grouping, window or unconfirmed metadata filter is refused", async () => {
  await withSignedIn(async (server, box) => {
    server.behavior.usage = (doc) => ({ ...doc, group_by: ["model"] });
    const grouping = await usage(box, server, ["--group-by", "route", "--today"]);
    assert.equal(grouping.run.code, 11);
    assert.equal(grouping.result.error.reason, "group_by_mismatch");

    server.behavior.usage = (doc) => ({ ...doc, window: { ...doc.window, days: 2 } });
    const window = await usage(box, server, ["--group-by", "route", "--today"]);
    assert.equal(window.run.code, 11);
    assert.equal(window.result.error.reason, "window_mismatch");

    // A service that does not echo the metadata filter cannot show it applied.
    server.behavior.usage = (doc) => ({
      ...doc,
      coverage: { ...doc.coverage, filters: { ...doc.coverage.filters, metadata: undefined } },
    });
    const metadata = await usage(box, server, ["--group-by", "route", "--metadata", "prompt_id=reply-v3"]);
    assert.equal(metadata.run.code, 6);
    assert.equal(metadata.result.error.reason, "metadata_filter_unsupported");
    assert.equal(metadata.result.data.result, null);
  });
});

test("grouped usage arguments are checked before any request", async () => {
  const box = sandbox();
  const cases = [
    [["--group-by", "prompt"], "invalid_group_by"],
    [["--group-by", "metadata.a", "--group-by-metadata", "b"], "too_many_metadata_dimensions"],
    [["--group-by", "route,metadata.api_key"], "metadata_key_ineligible"],
    [["--group-by", "route,route"], "invalid_group_by"],
    [["--group-by", "day", "--compare", "previous"], "compare_with_day_grouping"],
    [["--group-by", "route", "--sort", "day"], "invalid_sort"],
    [["--group-by", "route", "--sort", "latency"], "invalid_sort"],
    [["--today", "--days", "3"], "window_conflict"],
    [["--since", "2026-01-01", "--days", "3"], "window_conflict"],
    [["--until", "2026-01-02"], "invalid_window"],
    [["--since", "2026-01-01T00:00:00"], "invalid_window"],
    [["--since", "2026-02-30"], "invalid_window"],
    [["--since", "2026-01-02", "--until", "2026-01-01"], "invalid_window"],
    [["--since", "2025-01-01", "--until", "2026-01-01"], "invalid_window"],
    [["--compare", "yesterday"], "invalid_compare"],
    [["--provider", "\u001b[31mx"], "invalid_provider"],
  ];
  for (const [args, reason] of cases) {
    const run = await runCli(["--json", "usage", ...args, "--project", box.project], { offline: true, env: LOCAL_ENV });
    assert.equal(run.code, 2, `${args.join(" ")}: ${run.stdout}`);
    const result = parseJsonLine(run.stdout);
    assert.equal(result.error.reason, reason, args.join(" "));
  }
  // traces still has no time range or environment selector.
  const traces = await runCli(["--json", "traces", "--since", "2026-01-01"], { offline: true, env: LOCAL_ENV });
  assert.equal(traces.code, 6);
  assert.equal(parseJsonLine(traces.stdout).error.reason, "time_range_unsupported");
});

test("an explicit UTC window is sent as given and echoed back", async () => {
  await withSignedIn(async (server, box) => {
    const prior = aggregateFixture("compare-prior");
    const since = prior.window.since.slice(0, 10);
    const until = prior.window.until.slice(0, 10);
    const { run, result } = await usage(box, server, ["--group-by", "route", "--since", since, "--until", until]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(queries(server)[0], {
      group_by: "route",
      since: `${since}T00:00:00.000Z`,
      until: `${until}T00:00:00.000Z`,
      limit: "50",
    });
    const report = result.data.result;
    assert.equal(report.window.preset, null);
    assert.equal(report.window.until_is_request_time, false);
    assert.deepEqual(report.window.partial_days, []);
    assert.equal(report.totals.cost_usd, prior.totals.cost_usd);
  });
});

test("every usage help example parses as grouped usage or a metadata grouping", async () => {
  const { READ_HELP } = await import("../src/output.js");
  const { parseArgs } = await import("../src/args.js");
  const examples = READ_HELP.find((entry) => entry.name === "usage").examples;
  assert.equal(examples.length, 6);
  for (const [question, command] of examples) {
    const argv = command.split(" ").slice(1).map((word) => (word === "NAME" ? "example" : word));
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, true, question);
    assert.ok(parsed.grouped !== undefined || parsed.groupByMetadata !== null, question);
  }
});

test("prior windows are whole periods or the same elapsed time, in UTC", async () => {
  const { priorWindow, compareReports } = await import("../src/usage-aggregates.js");
  const preset = {
    preset: "utc_days", days: 7, since: "2026-01-08T00:00:00+00:00", until: "2026-01-14T06:00:00+00:00",
    hours: 150, partial_days: ["2026-01-14"],
  };
  assert.deepEqual(priorWindow(preset, "previous"), { since: "2026-01-01T00:00:00.000Z", until: "2026-01-08T00:00:00.000Z" });
  assert.deepEqual(priorWindow(preset, "previous-same-time"), {
    since: "2026-01-01T00:00:00.000Z", until: "2026-01-07T06:00:00.000Z",
  });
  const explicit = { preset: null, days: null, since: "2026-01-10T00:00:00Z", until: "2026-01-12T00:00:00Z" };
  assert.deepEqual(priorWindow(explicit, "previous"), { since: "2026-01-08T00:00:00.000Z", until: "2026-01-10T00:00:00.000Z" });

  // A group missing from a cut prior window is unknown, never zero.
  const exactPricing = { priced_calls: 1, zero_cost_calls: 0, partial_calls: 0, unpriced_calls: 0, unknown_calls: 0, cost: "exact" };
  const side = (items, truncated) => ({
    group_by: ["route"], truncated, complete: !truncated, items,
    window: { hours: 24, partial_days: [] },
    totals: { calls: 9, error_calls: 0, cost_usd: 1 },
    pricing: exactPricing,
  });
  const item = (route, cost) => ({ route, calls: 1, error_calls: 0, cost_usd: cost, pricing: exactPricing });
  const notices = new Set();
  const cut = compareReports(side([item("a", 1)], false), side([item("b", 2)], true), "previous", notices);
  const a = cut.items.find((row) => row.route === "a");
  const b = cut.items.find((row) => row.route === "b");
  assert.equal(a.prior, null);
  assert.deepEqual(a.cost_change, { delta: null, percent: null });
  assert.equal(b.current.cost_usd, 0);
  assert.equal(b.current.pricing.cost, "exact");
  assert.equal(cut.complete, false);
  // Changes keep the service's 8-decimal precision.
  const tiny = compareReports(side([item("a", 0.0000014)], false), side([item("a", 0.000001)], false), "previous", new Set());
  assert.deepEqual(tiny.items[0].cost_change, { delta: 0.0000004, percent: 40 });
  // A lower-bound side makes the cost change unknown.
  const lower = { ...exactPricing, unknown_calls: 1, cost: "lower_bound" };
  const unknown = compareReports(
    side([{ ...item("a", 10), pricing: lower }], false), side([item("a", 20)], false), "previous", new Set(),
  );
  assert.deepEqual(unknown.items[0].cost_change, { delta: null, percent: null });
  assert.ok(notices.has("comparison_incomplete"));
});

test("plain and grouped windows are labelled: rolling hours against whole UTC days", async () => {
  await withSignedIn(async (server, box) => {
    const plain = await usage(box, server, ["--days", "7"]);
    assert.equal(plain.run.code, 0, plain.run.stdout);
    assert.deepEqual(
      [plain.result.data.result.window.kind, plain.result.data.result.window.hours, plain.result.data.result.window.aligned_to_utc_days],
      ["rolling", 168, false],
    );
    const plainText = await usage(box, server, ["--days", "7"], { json: false });
    assert.match(plainText.run.stdout, /Window +rolling 168 h ending now, .* UTC \(not aligned to UTC days/);
    const grouped = await usage(box, server, ["--group-by", "model", "--days", "7"]);
    assert.equal(grouped.result.data.result.window.kind, "utc_days");
    assert.match(grouped.result.data.result.window.since, /T00:00:00/);
    const explicit = aggregateFixture("workflow-past-week").window;
    const past = await usage(box, server, [
      "--group-by", "metadata.workflow_name", "--since", explicit.since.slice(0, 10), "--until", explicit.until.slice(0, 10),
    ]);
    assert.equal(past.result.data.result.window.kind, "explicit");
  });
});

test("metadata.KEY combines with a past week, week over week, day, route and provider grouping", async () => {
  await withSignedIn(async (server, box) => {
    // A specific past week by workflow_name.
    const week = aggregateFixture("workflow-past-week");
    const past = await usage(box, server, [
      "--group-by", "metadata.workflow_name", "--since", week.window.since.slice(0, 10), "--until", week.window.until.slice(0, 10),
    ]);
    assert.equal(past.run.code, 0, past.run.stdout);
    const pastReport = assertEnvelope(past.result, "workflow-past-week");
    assert.equal(pastReport.window.hours, 7 * 24);
    assert.deepEqual(pastReport.items.map((item) => item.metadata_value).sort(), ["nightly-triage", "ticket-reply"]);
    assert.equal(pastReport.metadata_groups.unattributed.calls, 0);

    // Week over week by workflow: this UTC-day week against the 7 whole UTC
    // days before it, with the partial-day warning.
    const wow = await usage(box, server, ["--group-by", "metadata.workflow_name", "--days", "7", "--compare", "previous"]);
    assert.equal(wow.run.code, 0, wow.run.stdout);
    const wowReport = assertEnvelope(wow.result, "workflow-week");
    const sent = server.requestsTo(AGGREGATES).slice(-2).map((request) => request.query);
    assert.equal(sent[0].group_by, "metadata.workflow_name");
    assert.equal(Date.parse(sent[1].since), Date.parse(week.window.since));
    assert.equal(Date.parse(sent[1].until), Date.parse(week.window.until));
    const ticket = wowReport.comparison.items.find((item) => item.metadata_value === "ticket-reply");
    assert.deepEqual([ticket.current.calls, ticket.prior.calls], [6, 1]);
    assert.equal(ticket.has_value, true);
    // The group without a value this week has no counterpart in a complete prior week: zero there.
    const none = wowReport.comparison.items.find((item) => item.has_value === false);
    assert.deepEqual([none.prior.calls, none.prior.error_calls, none.prior.cost_usd], [0, 0, 0]);
    assert.equal(wowReport.comparison.partial_day_compared_with_full, true);
    assert.ok(wow.result.data.notices.includes("partial_day_comparison"));
    const wowText = await usage(box, server, ["--group-by", "metadata.workflow_name", "--days", "7", "--compare", "previous"], { json: false });
    assert.match(wowText.run.stdout, /METADATA_VALUE +COST +PRIOR_COST/);
    assert.match(wowText.run.stdout, /ticket-reply/);

    // Day by workflow.
    const daily = await usage(box, server, ["--group-by", "day,metadata.workflow_name", "--sort", "day"]);
    assert.equal(daily.run.code, 0, daily.run.stdout);
    assert.deepEqual(server.requestsTo(AGGREGATES).at(-1).query.group_by, "metadata.workflow_name");
    const dailyReport = assertEnvelope(daily.result, "day-workflow");
    const days = dailyReport.items.map((item) => item.day);
    assert.deepEqual(days, [...days].sort());
    assert.ok(dailyReport.items.every((item) => typeof item.day === "string" && item.metadata_key === "workflow_name"));
    assert.ok(dailyReport.items.some((item) => item.partial_day));
    const dailyText = await usage(box, server, ["--group-by", "day,metadata.workflow_name"], { json: false });
    assert.match(dailyText.run.stdout, /DAY_UTC +METADATA_VALUE/);

    // One route, by provider and model and workflow.
    const routed = await usage(box, server, [
      "--route", "support", "--group-by", "provider,model,metadata.workflow_name",
    ]);
    assert.equal(routed.run.code, 0, routed.run.stdout);
    const routedReport = assertEnvelope(routed.result, "route-provider-workflow");
    assert.deepEqual(routedReport.items.map((item) => [item.provider, item.model, item.metadata_value]), [
      ["provider-a", "model-large", "ticket-reply"],
    ]);
    assert.equal(routedReport.filters.route, 1);
  });
});

test("a key no call carries is said once, with the unattributed spend and no repeated notices", async () => {
  await withSignedIn(async (server, box) => {
    const json = await usage(box, server, ["--group-by", "metadata.activity_name"]);
    assert.equal(json.run.code, 0, json.run.stdout);
    const report = assertEnvelope(json.result, "absent-key");
    assert.deepEqual(report.items.map((item) => item.has_value), [false]);
    assert.equal(report.metadata_groups.unattributed.calls, report.totals.calls);
    assert.ok(report.warnings.some((entry) => entry.code === "metadata_key_mostly_missing"));
    // JSON keeps every notice token.
    for (const token of ["metadata_key_mostly_missing", "metadata_values_missing", "current_day_partial"]) {
      assert.ok(json.result.data.notices.includes(token), token);
    }
    const text = await usage(box, server, ["--group-by", "metadata.activity_name"], { json: false });
    assert.equal(text.run.code, 0, text.run.stdout);
    const out = text.run.stdout;
    assert.equal(out.match(/No call in this window has a value for activity_name\./g).length, 1);
    assert.equal(out.split("\n").filter((line) => line.includes("Service warnings")).length, 1);
    assert.match(out, /Not attributed to any activity_name value: \d+ calls/);
    for (const repeated of [
      "Most of this window", "Some calls have no usable value", "Service warning messages are not printed",
      "ends now, part way through", "cost is a lower bound.",
    ]) {
      assert.ok(!out.includes(repeated), repeated);
    }
    const bullets = out.split("\n").filter((line) => line.trimStart().startsWith("! "));
    assert.equal(new Set(bullets).size, bullets.length);
  });
});

test("grouped documents that do not reconcile, order or label as stated are refused", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite) => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.equal(result.error.reason, "usage_response_invalid");
      assert.equal(result.data.result, null);
    };
    const item0 = (doc, change) => ({ ...doc, items: [{ ...doc.items[0], ...change(doc.items[0]) }, ...doc.items.slice(1)] });
    // cost_per_call_usd that is not cost_usd / calls.
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({ cost_per_call_usd: item.cost_per_call_usd * 3 })));
    // A p95 the output would mislabel as a histogram estimate.
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({ latency: { ...item.latency, p95_method: "exact" } })));
    // Complete group sets whose errors, tokens or cost disagree with the totals.
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({ error_calls: item.error_calls + 1 })));
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({ input_tokens: item.input_tokens + 5 })));
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({
      cost_usd: item.cost_usd + 1, cost_per_call_usd: (item.cost_usd + 1) / item.calls,
    })));
    // Groups not in cost order, and a cut list in another stated order.
    await refused(["--group-by", "model"], (doc) => ({ ...doc, items: [...doc.items].reverse() }));
    await refused(["--group-by", "provider,model", "--limit", "2"], (doc) => ({
      ...doc, coverage: { ...doc.coverage, rows: { ...doc.coverage.rows, ordering: "calls desc" } },
    }));
    // A day group outside the verified window.
    await refused(["--route", "support", "--group-by", "day"], (doc) => item0(doc, () => ({ day: "2020-01-01" })));
  });
});

test("an explicit window over the service's max_days is refused before any read", async () => {
  await withSignedIn(async (server, box) => {
    server.behavior.capabilities = (doc) => ({ ...doc, bounds: { ...doc.bounds, max_days: 30 } });
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { run, result } = await usage(box, server, ["--group-by", "route", "--since", since]);
    assert.equal(run.code, 6, run.stdout);
    assert.equal(result.error.reason, "exceeds_service_bounds");
    assert.equal(server.requestsTo(AGGREGATES).length, 0);
  });
});

test("without the route-by-day read either, no supported read is offered", async () => {
  await withSignedIn(async (server, box) => {
    server.behavior.capabilities = (doc) => {
      const agent = { ...doc.agent };
      delete agent.usage_aggregates;
      delete agent.usage;
      return { ...doc, agent };
    };
    const { run, result } = await usage(box, server, ["--group-by", "provider"]);
    assert.equal(run.code, 14);
    assert.equal(result.error.reason, "usage_aggregates_unavailable");
    assert.equal(result.data.next_action, null);
  });
});

test("rolled-over timestamps and queries too long to send are refused as input", async () => {
  const box = sandbox();
  const long = "r".repeat(200);
  const cases = [
    [["--since", "2026-09-31T12:00:00Z"], "invalid_window"],
    [["--since", "2026-01-01T24:00:00Z"], "invalid_window"],
    [["--since", "2026-01-01T10:00:00+25:00"], "invalid_window"],
    [Array.from({ length: 20 }, (_, index) => ["--route", `${long}${index}`]).flat(), "query_too_long"],
  ];
  for (const [args, reason] of cases) {
    const run = await runCli(["--json", "usage", ...args, "--project", box.project], { offline: true, env: LOCAL_ENV });
    assert.equal(run.code, 2, run.stdout);
    assert.equal(parseJsonLine(run.stdout).error.reason, reason);
  }
});

test("comparison joins groups by their real values, not by display values", async () => {
  const { GROUP_KEY } = await import("../src/read-contract.js");
  const { compareReports } = await import("../src/usage-aggregates.js");
  // Two routes whose names were unsafe to print both display as null.
  const item = (raw, cost) => {
    const value = { route: null, calls: 1, error_calls: 0, cost_usd: cost };
    Object.defineProperty(value, GROUP_KEY, { value: JSON.stringify([raw]), enumerable: true });
    return value;
  };
  const side = (items) => ({
    group_by: ["route"], truncated: false, complete: true, items,
    window: { hours: 24, partial_days: [] }, totals: { calls: 2, error_calls: 0, cost_usd: 3 },
  });
  const comparison = compareReports(
    side([item("a\u0007", 1), item("b\u0007", 2)]),
    side([item("b\u0007", 5)]),
    "previous",
    new Set(),
  );
  const rows = comparison.items.map((row) => [row.current?.cost_usd ?? null, row.prior?.cost_usd ?? null]);
  assert.deepEqual(rows, [[1, 0], [2, 5]]);
});

test("filter echoes, buckets, pricing, attribution and coverage windows must match exactly", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite, reason = "usage_response_invalid") => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.equal(result.error.reason, reason);
    };
    const coverage = (doc, change) => ({ ...doc, coverage: { ...doc.coverage, ...change(doc.coverage) } });
    // An echo that repeats a value is not the requested set.
    server.behavior.usage = (doc) => coverage(doc, (value) => ({ filters: { ...value.filters, provider: ["provider-a", "provider-a"] } }));
    const dup = await usage(box, server, ["--group-by", "provider", "--provider", "provider-a", "--days", "7"]);
    assert.equal(dup.run.code, 11);
    assert.equal(dup.result.error.reason, "filter_mismatch");
    server.behavior.usage = (doc) => doc;
    // Metadata buckets whose cost exceeds the population.
    await refused(["--group-by", "metadata.prompt_id"], (doc) => ({
      ...doc,
      metadata_groups: {
        ...doc.metadata_groups,
        unlisted: { ...doc.metadata_groups.unlisted, missing_key: { ...doc.metadata_groups.unlisted.missing_key, cost_usd: 50 } },
      },
    }));
    // Pricing that accounts for fewer calls than the population or a group.
    await refused(["--group-by", "model"], (doc) => ({ ...doc, pricing: { ...doc.pricing, priced_calls: 1 } }));
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, items: [{ ...doc.items[0], pricing: { ...doc.items[0].pricing, priced_calls: 0 } }, ...doc.items.slice(1)],
    }));
    // Whole-trace attribution is not the per-call split grouped usage promises.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, attribution: { ...doc.attribution, level: "trace", cost_basis: "trace_total", per_provider_exact: false },
    }));
    // Coverage that describes another window than the one validated.
    await refused(["--group-by", "model"], (doc) => coverage(doc, (value) => ({
      requested_window: { ...value.requested_window, since: "2020-01-01T00:00:00+00:00" },
    })), "window_mismatch");
    await refused(["--group-by", "model"], (doc) => coverage(doc, (value) => ({
      effective_window: { ...value.effective_window, since: new Date(Date.parse(value.effective_window.since) + 3600000).toISOString() },
    })), "window_mismatch");
  });
});

test("the suggested --limit never exceeds the deployment's max_rows", async () => {
  await withSignedIn(async (server, box) => {
    server.behavior.capabilities = (doc) => ({ ...doc, bounds: { ...doc.bounds, max_rows: 2 } });
    const { run, result } = await usage(box, server, ["--group-by", "provider,model", "--limit", "2", "--sort", "calls"]);
    assert.equal(run.code, 0, run.stdout);
    assert.equal(result.data.next_action.kind, "narrow_read");
  });
});

test("prior-window notices the comparison does not state are still shown", async () => {
  const { readText } = await import("../src/read-output.js");
  const report = {
    source: "usage_aggregates", group_by: ["route"], filters: { route: 0, provider: 0, model: 0, environment: 0, metadata: { count: 0, keys: [] } },
    window: { preset: "utc_days", days: 1, since: "2026-01-02T00:00:00Z", until: "2026-01-02T06:00:00Z", hours: 6, partial_days: ["2026-01-02"] },
    sort: { by: "cost", meaning: "cost, highest first", complete: true }, items: [], empty: true, rows: 0, matched_groups: 0,
    totals: { calls: 0, error_calls: 0, cost_usd: 0, cost_per_call_usd: null, input_tokens: 0, output_tokens: 0 },
    coverage: null, pricing: null, attribution: null, complete: true, metadata_groups: null,
    comparison: {
      mode: "previous", hours: { current: 6, prior: 24 }, partial_day_compared_with_full: true, complete: true, items: [],
      prior: { window: { preset: null, days: null, since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z", hours: 24, partial_days: [] }, coverage: null, pricing: null },
      totals: {
        current: { calls: 0, cost_usd: 0 }, prior: { calls: 0, cost_usd: 0 }, cost_change_known: true,
        cost_change: { delta: 0, percent: null }, calls_change: { delta: 0, percent: null },
      },
    },
  };
  const text = readText({ command: "usage", ok: true, outcome: "ok", data: {
    origin: "http://127.0.0.1:9", workspace: { id: "x" }, result: report,
    notices: ["prior_pricing_lower_bound", "prior_unsafe_text_omitted"], next_action: null,
  } }, null);
  assert.match(text, /Prior window: Some names contained control or formatting characters/);
  assert.ok(!text.includes("Prior window: Some calls have missing"));
});

test("a stale 'today so far' window, impossible dates, sampleless latency and broken call order are refused", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite, reason) => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.equal(result.error.reason, reason);
    };
    // A response kept from two days ago: internally aligned, but not today.
    const back = (stamp) => new Date(Date.parse(stamp) - 2 * 24 * 60 * 60 * 1000).toISOString();
    await refused(["--group-by", "route", "--today"], (doc) => ({
      ...doc,
      window: { ...doc.window, since: back(doc.window.since), until: back(doc.window.until) },
      coverage: {
        ...doc.coverage,
        requested_window: { ...doc.coverage.requested_window, since: back(doc.window.since), until: back(doc.window.until) },
        effective_window: { ...doc.coverage.effective_window, since: back(doc.window.since), until: back(doc.window.until) },
      },
    }), "window_mismatch");
    const item0 = (doc, change) => ({ ...doc, items: [{ ...doc.items[0], ...change(doc.items[0]) }, ...doc.items.slice(1)] });
    // A calendar date that does not exist.
    await refused(["--route", "support", "--group-by", "day"], (doc) => item0(doc, () => ({ day: "2026-02-30" })), "usage_response_invalid");
    // Latency from no samples.
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({ latency: { ...item.latency, samples: 0 } })), "usage_response_invalid");
    // Equal cost, fewer calls listed first.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc,
      items: [
        { ...doc.items[0], calls: doc.items[1].calls },
        { ...doc.items[1], cost_usd: doc.items[0].cost_usd, calls: doc.items[0].calls },
        ...doc.items.slice(2),
      ],
    }), "usage_response_invalid");
  });
});

test("absence proves zero only in a complete window, and tiny changes print at full precision", async () => {
  const { compareReports } = await import("../src/usage-aggregates.js");
  const { readText } = await import("../src/read-output.js");
  const pricing = { priced_calls: 1, zero_cost_calls: 0, partial_calls: 0, unpriced_calls: 0, unknown_calls: 0, cost: "exact" };
  const side = (items, complete) => ({
    group_by: ["route"], truncated: false, complete, items, pricing,
    window: { hours: 24, partial_days: [] }, totals: { calls: 1, error_calls: 0, cost_usd: 0.000001 },
  });
  const item = (route, cost) => ({ route, calls: 1, error_calls: 0, cost_usd: cost, pricing });
  // The prior window is not truncated but incomplete (for example ingestion pending).
  const pending = compareReports(side([item("a", 1)], true), side([], false), "previous", new Set());
  assert.equal(pending.items[0].prior, null);

  const tiny = compareReports(side([item("a", 0.0000014)], true), side([item("a", 0.000001)], true), "previous", new Set());
  const window = { preset: null, days: null, since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z", hours: 24, partial_days: [] };
  const report = {
    source: "usage_aggregates", group_by: ["route"], filters: { route: 0, provider: 0, model: 0, environment: 0, metadata: { count: 0, keys: [] } },
    window, sort: { by: "cost", meaning: "cost, highest first", complete: true }, items: [], empty: true, rows: 0, matched_groups: 0,
    totals: { calls: 1, error_calls: 0, cost_usd: 0.0000014, cost_per_call_usd: 0.0000014, input_tokens: 0, output_tokens: 0 },
    coverage: null, pricing: null, attribution: null, complete: true, metadata_groups: null,
    comparison: {
      ...tiny,
      totals: { ...tiny.totals, current: { calls: 1, cost_usd: 0.0000014 }, prior: { calls: 1, cost_usd: 0.000001 } },
      prior: { ...tiny.prior, window, warnings: [{ code: "coverage_incomplete" }], coverage: null, pricing: null },
    },
  };
  const text = readText({ command: "usage", ok: true, outcome: "ok", data: {
    origin: "http://127.0.0.1:9", workspace: { id: "x" }, result: report, notices: [], next_action: null,
  } }, null);
  assert.match(text, /a +\$0\.00000140 +\$0\.00000100 +\+\$0\.00000040 +\+40%/);
  assert.match(text, /Prior service warnings: coverage_incomplete/);
});

test("metadata buckets, window timestamps, emptiness and the completeness summary must agree", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite) => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.ok(["usage_response_invalid", "window_mismatch"].includes(result.error.reason), result.error.reason);
    };
    const others = (doc, change) => ({
      ...doc,
      metadata_groups: {
        ...doc.metadata_groups,
        unlisted: { ...doc.metadata_groups.unlisted, other_values: { ...doc.metadata_groups.unlisted.other_values, ...change } },
      },
    });
    // Unlisted values claimed for a complete grouping.
    await refused(["--group-by", "metadata.prompt_id"], (doc) => others(doc, { groups: 999 }));
    // An impossible calendar date in the window.
    await refused(["--group-by", "model"], (doc) => ({ ...doc, window: { ...doc.window, since: "2026-02-29T00:00:00+00:00" } }));
    // No rows although calls matched, and a group with no calls.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, items: [], coverage: { ...doc.coverage, rows: { ...doc.coverage.rows, returned: 0, matched: null, truncated: true } },
    }));
    // A completeness summary that contradicts the rows.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, completeness: { mode: "bogus", complete: false, returned: 0, limit: 1 },
    }));
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, completeness: { ...doc.completeness, complete: false },
    }));
  });
});

test("unattributed metadata spend keeps eight decimals", async () => {
  await withSignedIn(async (server, box) => {
    server.behavior.usage = (doc) => {
      // Move a tiny amount between the population and the missing-key bucket.
      const tiny = 0.00000004;
      const missing = doc.metadata_groups.unlisted.missing_key;
      const items = doc.items.map((item) =>
        item.has_value === false || item["metadata.prompt_id"] === null
          ? { ...item, cost_usd: item.cost_usd + tiny, cost_per_call_usd: (item.cost_usd + tiny) / item.calls }
          : item);
      return {
        ...doc,
        items,
        totals: { ...doc.totals, cost_usd: doc.totals.cost_usd + tiny, cost_per_call_usd: (doc.totals.cost_usd + tiny) / doc.totals.calls },
        metadata_groups: {
          ...doc.metadata_groups,
          unlisted: { ...doc.metadata_groups.unlisted, missing_key: { ...missing, cost_usd: missing.cost_usd + tiny } },
        },
      };
    };
    const { run, result } = await usage(box, server, ["--group-by", "metadata.prompt_id"]);
    assert.equal(run.code, 0, run.stdout);
    const recorded = aggregateFixture("prompt-cost").metadata_groups.unlisted;
    const expected = Math.round((recorded.missing_key.cost_usd + recorded.ineligible_value.cost_usd + 0.00000004) * 1e8) / 1e8;
    assert.equal(result.data.result.metadata_groups.unattributed.cost_usd, expected);
  });
});

test("stale explicit windows, contradictory truncation, empty evidence, uncovered changes and mixed environments are refused", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite, reason) => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.equal(result.error.reason, reason);
    };
    // --since without --until: a window that claims to end "now" must end
    // today. A recorded week that ended six days ago is refused.
    const { usageAggregatesReport } = await import("../src/read-contract.js");
    const week = aggregateFixture("compare-week-prior");
    const stale = usageAggregatesReport(
      { ...week, window: { ...week.window, until_is_request_time: true } },
      { workspaceId: "00000000-0000-4000-8000-00000000c0de", profile: "local", origin: "http://127.0.0.1:9" },
      {
        days: null, since: week.window.since, until: null, limit: 50, groupBy: ["provider"], metadata: null,
        filters: { route: null, provider: null, model: null, environment: null }, requestedAt: Date.now(),
      },
      new Set(),
    );
    assert.deepEqual([stale.ok, stale.reason], [false, "window_mismatch"]);
    // Truncated although every matched group was returned.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, coverage: { ...doc.coverage, rows: { ...doc.coverage.rows, truncated: true } },
    }), "usage_response_invalid");
    // Evidence that covers no returned rows.
    await refused(["--group-by", "model"], (doc) => ({ ...doc, evidence: { ...doc.evidence, rows: 0 } }), "usage_response_invalid");
    // The prior read covered different environments than the current one.
    let calls = 0;
    server.behavior.usage = (doc) => {
      calls += 1;
      if (calls === 1) return doc;
      return { ...doc, coverage: { ...doc.coverage, filters: { ...doc.coverage.filters, environments: ["staging"] } } };
    };
    const mixed = await usage(box, server, ["--group-by", "route", "--today", "--compare", "previous"]);
    server.behavior.usage = (doc) => doc;
    assert.equal(mixed.run.code, 11, mixed.run.stdout);
    assert.equal(mixed.result.error.reason, "filter_mismatch");
  });
});

test("a change is unknown when either window's coverage is incomplete", async () => {
  const { compareReports } = await import("../src/usage-aggregates.js");
  const pricing = { priced_calls: 1, zero_cost_calls: 0, partial_calls: 0, unpriced_calls: 0, unknown_calls: 0, cost: "exact" };
  const side = (cost, completeness) => ({
    group_by: ["route"], truncated: false, complete: completeness === "complete", pricing,
    evidence: { complete: true, rows: 1, sources: [] }, coverage: { completeness, reasons: [] },
    items: [{ route: "a", calls: 1, error_calls: 0, cost_usd: cost, pricing }],
    window: { hours: 24, partial_days: [] }, totals: { calls: 1, error_calls: 0, cost_usd: cost },
  });
  const pending = compareReports(side(10, "partial"), side(20, "complete"), "previous", new Set());
  assert.deepEqual(pending.totals.cost_change, { delta: null, percent: null });
  assert.deepEqual(pending.totals.calls_change, { delta: null, percent: null });
  assert.equal(pending.totals.cost_change_known, false);
  assert.deepEqual(pending.items[0].cost_change, { delta: null, percent: null });
  const both = compareReports(side(10, "complete"), side(20, "complete"), "previous", new Set());
  assert.deepEqual(both.totals.cost_change, { delta: -10, percent: -50 });
});

test("unrequested filters, inverted coverage, unreconciled pricing, samples and no-value rows are refused", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite, reason = "usage_response_invalid") => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.equal(result.error.reason, reason);
    };
    const coverage = (doc, change) => ({ ...doc, coverage: { ...doc.coverage, ...change(doc.coverage) } });
    // A status filter the CLI never sent.
    await refused(["--group-by", "model"], (doc) => coverage(doc, (value) => ({ filters: { ...value.filters, status: "error" } })), "filter_mismatch");
    // An effective window that starts after it ends.
    await refused(["--group-by", "model"], (doc) => coverage(doc, (value) => ({
      reasons: [...value.reasons, "retention_clipped"],
      effective_window: { ...value.effective_window, since: new Date(Date.parse(value.effective_window.until) + 86400000).toISOString() },
    })), "window_mismatch");
    // Row pricing classes that do not add up to the population's.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc,
      pricing: { ...doc.pricing, priced_calls: doc.pricing.priced_calls - 1, unpriced_calls: doc.pricing.unpriced_calls + 1, cost: "lower_bound" },
    }));
    // Row latency samples that do not add up to the population's.
    await refused(["--group-by", "model"], (doc) => ({
      ...doc, totals: { ...doc.totals, latency: { ...doc.totals.latency, samples: doc.totals.latency.samples - 1 } },
    }));
    // A no-value row that disagrees with the missing and ineligible buckets.
    await refused(["--group-by", "metadata.prompt_id"], (doc) => ({
      ...doc,
      metadata_groups: {
        ...doc.metadata_groups,
        unlisted: {
          ...doc.metadata_groups.unlisted,
          missing_key: { calls: doc.metadata_groups.unlisted.missing_key.calls + 1, cost_usd: doc.metadata_groups.unlisted.missing_key.cost_usd },
          other_values: doc.metadata_groups.unlisted.other_values,
        },
      },
      totals: { ...doc.totals },
    }));
  });
});

test("a window ending now must end within the clock-skew bound of the request", async () => {
  const { usageAggregatesReport } = await import("../src/read-contract.js");
  const doc = aggregateFixture("route-today");
  const ctx = { workspaceId: "00000000-0000-4000-8000-00000000c0de", profile: "local", origin: "http://127.0.0.1:9" };
  const request = (requestedAt) => ({
    days: 1, since: null, until: null, limit: 50, groupBy: ["route"], metadata: null,
    filters: { route: null, provider: null, model: null, environment: null }, requestedAt,
  });
  const until = Date.parse(doc.window.until);
  const nextMidnight = Math.floor(until / 86400000) * 86400000 + 86400000;
  // 30 minutes after midnight: a window ending 23 hours earlier is stale.
  const stale = usageAggregatesReport(doc, ctx, request(nextMidnight + 30 * 60000), new Set());
  assert.deepEqual([stale.ok, stale.reason], [false, "window_mismatch"]);
  // Hours later on the same UTC day: also stale.
  const sameDay = usageAggregatesReport(doc, ctx, request(Math.min(until + 3 * 3600000, nextMidnight - 1000)), new Set());
  assert.deepEqual([sameDay.ok, sameDay.reason], [false, "window_mismatch"]);
  // Within the bound: accepted.
  const fresh = usageAggregatesReport(doc, ctx, request(until + 1000), new Set());
  assert.equal(fresh.ok, true, fresh.reason);
});

test("latency needs samples both ways, zero-cost pricing costs nothing, top-N has no cursor, comparisons follow --sort", async () => {
  await withSignedIn(async (server, box) => {
    const refused = async (args, rewrite) => {
      server.behavior.usage = rewrite;
      const { run, result } = await usage(box, server, args);
      server.behavior.usage = (doc) => doc;
      assert.equal(run.code, 11, run.stdout);
      assert.equal(result.error.reason, "usage_response_invalid");
    };
    const item0 = (doc, change) => ({ ...doc, items: [{ ...doc.items[0], ...change(doc.items[0]) }, ...doc.items.slice(1)] });
    await refused(["--group-by", "model"], (doc) => item0(doc, (item) => ({ latency: { ...item.latency, avg_ms: null } })));
    await refused(["--group-by", "route", "--today"], (doc) => item0(doc, (item) => ({
      pricing: { ...item.pricing, zero_cost_calls: item.pricing.priced_calls },
    })));
    await refused(["--group-by", "model"], (doc) => ({ ...doc, coverage: { ...doc.coverage, next_cursor: "abc" } }));

    const { run, result } = await usage(box, server, ["--group-by", "route", "--today", "--compare", "previous", "--sort", "p95-latency"]);
    assert.equal(run.code, 0, run.stdout);
    const ranked = result.data.result.items.map((item) => item.route);
    const compared = result.data.result.comparison.items.slice(0, ranked.length).map((item) => item.route);
    assert.deepEqual(compared, ranked);
    // p95 order differs from the service's cost order here, so this proves the sort applied.
    assert.notDeepEqual(ranked, ["support", "research", "classifier"]);
  });
});
