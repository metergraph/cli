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
  assert.equal(report.window.until, doc.window.until);
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
    assert.equal(comparison.totals.cost_change.delta, Math.round((current.totals.cost_usd - prior.totals.cost_usd) * 1e6) / 1e6);
    const support = comparison.items.find((item) => item.route === "support");
    assert.deepEqual([support.current.cost_usd, support.prior.cost_usd], [0.8, 0.35]);
    assert.equal(support.cost_change.percent, 128.6);

    const text = await usage(box, server, ["--group-by", "route", "--today", "--compare", "previous"], { json: false });
    assert.match(text.run.stdout, /Compared with the whole previous period: \S+ to \S+ UTC, 24 h/);
    assert.match(text.run.stdout, /Not like for like: [\d.]+ h now against 24 h before/);
    assert.match(text.run.stdout, /partial current UTC day is compared with a whole prior period/);
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
      const recordedDoc = aggregateFixture("provider-prod-key");
      return { ...recordedDoc, provenance: doc.provenance };
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
  const side = (items, truncated) => ({
    group_by: ["route"], truncated, complete: !truncated, items,
    window: { hours: 24, partial_days: [] },
    totals: { calls: 9, error_calls: 0, cost_usd: 1 },
  });
  const item = (route, cost) => ({ route, calls: 1, error_calls: 0, cost_usd: cost });
  const notices = new Set();
  const cut = compareReports(side([item("a", 1)], false), side([item("b", 2)], true), "previous", notices);
  const a = cut.items.find((row) => row.route === "a");
  const b = cut.items.find((row) => row.route === "b");
  assert.equal(a.prior, null);
  assert.deepEqual(a.cost_change, { delta: null, percent: null });
  assert.deepEqual(b.current, { calls: 0, error_calls: 0, cost_usd: 0 });
  assert.equal(cut.complete, false);
  assert.ok(notices.has("comparison_incomplete"));
});
