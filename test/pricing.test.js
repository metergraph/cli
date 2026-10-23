import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";
import { PRICING_SCHEMA, validatePricing } from "../src/pricing-reference.js";
import { pricingHtml } from "../src/pricing-output.js";
import { parseJsonLine, runCli, startServer as startSecureServer } from "./helpers.js";

// The reference service intentionally exercises credential-free HTTP loopback.
const startServer = routes => startSecureServer(routes, { tls: false });

const runReferenceCli = (args, options) => runCli([...args, "--api", "reference"], options);
const query = { model: "example/model", channel: "example-api", at: "2026-10-20" };
const row = {
  id: "example/model:example-api:global:2026-01-01",
  model_id: "example/model",
  channel: "example-api",
  region: "global",
  currency: "USD",
  input_per_mtok: "1",
  output_per_mtok: "2",
  cache_read_per_mtok: "0",
  cache_write_5m_per_mtok: null,
  cache_write_1h_per_mtok: null,
  batch_input_per_mtok: null,
  batch_output_per_mtok: null,
  request_fee_per_1k: null,
  rules: {},
  effective_from: "2026-01-01T00:00:00Z",
  effective_to: null,
  source_url: "https://example.com/pricing",
};
function document(action = "lookup", q = query) {
  return {
    schema_version: PRICING_SCHEMA,
    action,
    request: structuredClone(q),
    catalog: {
      version: "2026-10-20",
      content_hash: "a".repeat(64),
      pricing_verified_at: "2026-10-20",
      served_at: "2026-10-20T12:00:00Z",
      core_version: "0.5.0",
    },
    result: {
      status: "priced",
      model_id: row.model_id,
      price: structuredClone(row),
      effective_at: "2026-10-20T00:00:00Z",
      missing_dimensions: [],
    },
  };
}
function history() {
  const q = { ...query, region: "global" };
  const d = document("history", q);
  const old = { ...row, effective_to: "2026-02-01T00:00:00Z", input_per_mtok: "2" };
  const current = { ...row, id: "example/model:example-api:global:2026-02-01", effective_from: "2026-02-01T00:00:00Z" };
  d.result = {
    series: [
      { model_id: row.model_id, channel: row.channel, region: "global", currency: "USD", points: [old, current] },
    ],
    matched: 1,
    truncated: false,
  };
  return d;
}

test("pricing validates selectors, usage and mutually exclusive output before network", () => {
  const good = parseArgs([
    "pricing",
    "cost",
    "--model",
    "example/model",
    "--provider",
    "openai",
    "--input-tokens",
    "0",
    "--batch",
    "--at",
    "2026-10-20",
    "--json",
  ]);
  assert.equal(good.ok, true);
  assert.equal(good.query.input_tokens, 0);
  assert.equal(good.query.batch, true);
  for (const args of [
    [],
    ["oops"],
    ["lookup"],
    ["lookup", "--model", "example/model", "--at", "2026-02-30"],
    ["lookup", "--model", "example/model", "--provider", "openai", "--channel", "openai-api"],
    ["lookup", "--model", "example/model", "--input-tokens", "1"],
    ["cost", "--model", "example/model", "--input-tokens", "-1"],
    ["cost", "--model", "example/model", "--cache-write-tokens", "1", "--cache-write-5m-tokens", "1"],
    ["history", "--model", "example/model"],
    ["market"],
    ["market", "--channel", "example-api", "--limit", "101"],
    ["market", "--channel", "example-api", "--format", "html"],
    ["history", "--model", "example/model", "--channel", "example-api", "--json", "--format", "html"],
    ["lookup", "--model", "\u001b[31m"],
    ["lookup", "--model", "example/model", "--url", "https://user:pass@example.com"],
  ]) {
    assert.equal(parseArgs(["pricing", ...args]).ok, false, JSON.stringify(args));
  }
});

test("pricing rejects a mismatched request, route, date, rates, status or provenance", () => {
  assert.equal(validatePricing(document(), "lookup", query), true);
  const mutations = [
    (d) => (d.request.model = "another/model"),
    (d) => (d.schema_version = "next"),
    (d) => (d.catalog.content_hash = "x"),
    (d) => (d.result.price.channel = "another-api"),
    (d) => (d.result.price.input_per_mtok = "NaN"),
    (d) => (d.result.price.input_per_mtok = "-1"),
    (d) => (d.result.price.effective_to = "2026-10-01T00:00:00Z"),
    (d) => (d.result.price.source_url = "javascript:alert(1)"),
    (d) => (d.result.price.model_id = "evil\u001b[31m"),
    (d) => (d.result.missing_dimensions = ["region"]),
    (d) => (d.result.effective_at = "2026-10-19T00:00:00Z"),
    (d) => (d.catalog.served_at = "2026-02-30T00:00:00Z"),
  ];
  for (const mutate of mutations) {
    const d = document();
    mutate(d);
    assert.equal(validatePricing(d, "lookup", query), false);
  }
});

test("cost keeps decimal strings and verifies that components sum exactly", () => {
  const q = { ...query, input_tokens: 1000, output_tokens: 1000 };
  const d = document("cost", q);
  Object.assign(d.result, {
    cost: "0.00300000",
    currency: "USD",
    reasons: [],
    components: { input: "0.00100000", output: "0.00200000", cache_read: "0", cache_write: "0", request: "0" },
  });
  assert.equal(validatePricing(d, "cost", q), true);
  d.result.components.input = "0.00200000";
  assert.equal(validatePricing(d, "cost", q), false);
  d.result.components.input = null;
  assert.equal(validatePricing(d, "cost", q), false);
});

test("history rejects crossed channels, overlapping windows, duplicate series and truncated history", () => {
  const d = history();
  assert.equal(validatePricing(d, "history", d.request), true);
  for (const change of [
    (d) => (d.result.series[0].points[1].channel = "wrong"),
    (d) => (d.result.series[0].points[0].effective_to = null),
    (d) => d.result.series[0].points.reverse(),
    (d) => (d.result.truncated = true),
    (d) => d.result.series.push(d.result.series[0]),
  ]) {
    const d = history();
    change(d);
    assert.equal(validatePricing(d, "history", d.request), false);
  }
});

test("HTML escapes dynamic labels and sources and contains an accessible data table", () => {
  const d = history();
  d.result.series[0].model_id = '<script>alert("x")</script>';
  const html = pricingHtml(d);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.match(html, /role="img"/);
  assert.match(html, /<caption>/);
  assert.match(html, /Provider source/);
});

test("lookup runs without login and sends no credentials even if an agent token exists", async () => {
  const d = document();
  const server = await startServer({
    "/v1/pricing/lookup?model=example%2Fmodel&channel=example-api&at=2026-10-20": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(d));
    },
  });
  try {
    const got = await runReferenceCli(
      [
        "pricing",
        "lookup",
        "--model",
        "example/model",
        "--channel",
        "example-api",
        "--at",
        "2026-10-20",
        "--url",
        server.origin,
        "--json",
      ],
      { env: { METERGRAPH_AGENT_TOKEN: "synthetic-never-send" } },
    );
    assert.equal(got.code, 0);
    assert.equal(got.stderr, "");
    assert.equal(parseJsonLine(got.stdout).data.result.price.input_per_mtok, "1");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.equal(server.requests[0].headers.cookie, undefined);
  } finally {
    await server.close();
  }
});

test("history chart and HTML run through the CLI and retain provenance", async () => {
  const d = history();
  const server = await startServer({
    "/v1/pricing/history?model=example%2Fmodel&channel=example-api&at=2026-10-20&region=global": (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(d));
    },
  });
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:/, 'reference pricing retains HTTP loopback support');
    const args = [
      "pricing",
      "history",
      "--model",
      "example/model",
      "--channel",
      "example-api",
      "--at",
      "2026-10-20",
      "--url",
      server.origin,
    ];
    const chart = await runReferenceCli(args);
    assert.equal(chart.code, 0);
    assert.match(chart.stdout, /linear UTC time/);
    assert.match(chart.stdout, /-50.0%/);
    const html = await runReferenceCli([...args, "--format", "html"]);
    assert.equal(html.code, 0);
    assert.match(html.stdout, /<!doctype html>/);
    assert.match(html.stdout, /Catalog 2026-10-20/);
  } finally {
    await server.close();
  }
});

test("public pricing reports redirects, unavailable endpoints, throttling, malformed and oversized bodies", async () => {
  for (const [status, body, extra, code, reason] of [
    [302, "", { location: "https://example.com" }, 7, "pricing_redirect_rejected"],
    [403, "", {}, 6, "public_pricing_unavailable"],
    [404, "", {}, 6, "public_pricing_unavailable"],
    [429, "", {}, 16, "pricing_rate_limited"],
    [503, "", {}, 5, "pricing_service_unhealthy"],
    [200, "{}", {}, 11, "pricing_contract_mismatch"],
    [200, "x".repeat(1024 * 1024 + 1), {}, 6, "pricing_response_too_large"],
    [200, JSON.stringify(document()), { "content-type": "text/html" }, 11, "pricing_contract_mismatch"],
  ]) {
    const server = await startServer({
      "/v1/pricing/lookup?model=example%2Fmodel&channel=example-api&at=2026-10-20": (req, res) => {
        res.writeHead(status, { "content-type": "application/json", ...extra });
        res.end(body);
      },
    });
    try {
      const got = await runReferenceCli([
        "pricing",
        "lookup",
        "--model",
        "example/model",
        "--channel",
        "example-api",
        "--at",
        "2026-10-20",
        "--url",
        server.origin,
        "--json",
      ]);
      assert.equal(got.code, code);
      assert.equal(parseJsonLine(got.stdout).error.reason, reason);
      assert.equal(got.stderr, "");
    } finally {
      await server.close();
    }
  }
});

test("a stalled pricing response times out with one JSON failure", async () => {
  const server = await startServer({
    "/v1/pricing/lookup?model=example%2Fmodel&channel=example-api&at=2026-10-20": () => {},
  });
  try {
    const got = await runReferenceCli(["pricing", "lookup", "--model", "example/model", "--channel", "example-api",
      "--at", "2026-10-20", "--url", server.origin, "--timeout-ms", "100", "--json"]);
    assert.equal(got.code, 4);
    assert.equal(parseJsonLine(got.stdout).error.reason, "timeout");
    assert.equal(got.stderr, "");
  } finally { await server.close(); }
});
