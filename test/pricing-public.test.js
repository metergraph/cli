import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";
import { pricingPayload, validateModels, validatePublicResult } from "../src/pricing.js";
import { parseJsonLine, runCli, startServer } from "./helpers.js";

const AT = "2026-10-20",
  TIME = `${AT}T00:00:00Z`;
const PRICE = {
  id: "example/model:example-api:global:2026-01-01",
  model_id: "example/model",
  channel: "example-api",
  region: "global",
  currency: "USD",
  effective_from: "2026-01-01",
  effective_to: null,
  source_url: "https://example.com/pricing",
  rules: {},
  input_per_mtok: "2.0",
  output_per_mtok: "10.0",
  cache_read_per_mtok: "0.2",
  cache_write_5m_per_mtok: "2.5",
  cache_write_1h_per_mtok: "4.0",
  batch_input_per_mtok: "1.0",
  batch_output_per_mtok: "5.0",
  request_fee_per_1k: null,
};
const RESULT = {
  status: "priced",
  model_id: PRICE.model_id,
  price: PRICE,
  effective_at: TIME,
  currency: "USD",
  missing_dimensions: [],
};
const MODEL = {
  model_id: "example/model",
  publisher: "example",
  aliases: [{ provider: "example", model: "model", channel: "example-api" }],
  prices: [
    {
      channel: "example-api",
      region: "global",
      currency: "USD",
      effective_from: "2026-01-01",
      dimensions: ["input", "output"],
      service_tiers: ["standard"],
    },
  ],
};
function discovery() {
  return {
    as_of: new Date().toISOString(),
    catalog: { version: AT, currency: "USD", pricing_verified_at: AT },
    formats: ["anthropic.messages", "openai.responses", "openai.chat_completions", "otel.gen_ai", "langfuse"],
    providers: ["example"],
    channels: ["example-api"],
    regions: ["global"],
    service_tiers: ["standard", "batch"],
    models: [structuredClone(MODEL)],
  };
}
function result() {
  return { results: [structuredClone(RESULT)] };
}
function cost(status = "priced") {
  const d = result();
  Object.assign(d.results[0], {
    status,
    contract_version: 2,
    fees: [],
    uncaptured_fees: false,
    cost: "0.00416000",
    components: {
      input: "0.00200000",
      output: "0.00200000",
      cache_read: "0.00016000",
      cache_write: "0.00000000",
      request: "0.00000000",
      search: "0.00000000",
    },
  });
  return d;
}
async function api(routes, body) {
  const server = await startServer(routes);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}
const respond = (d) => (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(typeof d === "function" ? d() : d));
};
const args = (action, origin) => [
  "pricing",
  action,
  "--model",
  "example/model",
  "--channel",
  "example-api",
  "--at",
  AT,
  "--url",
  origin,
];
async function readBody(req) {
  let text = "";
  for await (const part of req) text += part;
  return JSON.parse(text);
}

test("public lookup uses POST with nested context and preserves decimal rate strings", async () => {
  let payload;
  await api(
    {
      "/v1/pricing/lookup": async (req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers.cookie, undefined);
        payload = await readBody(req);
        respond(result())(req, res);
      },
    },
    async (s) => {
      const got = await runCli([...args("lookup", s.origin), "--region", "global", "--json"], {
        env: { METERGRAPH_AGENT_TOKEN: "synthetic-never-send" },
      });
      assert.equal(got.code, 0);
      assert.equal(got.stderr, "");
      const d = parseJsonLine(got.stdout).data;
      assert.equal(d.api, "public");
      assert.equal(d.catalog, null);
      assert.equal(d.result.price.input_per_mtok, "2.0");
      assert.deepEqual(payload, {
        model: "example/model",
        context: { channel: "example-api", region: "global", at: TIME },
      });
      assert.equal(s.requests.length, 1);
    },
  );
});

test("calculate and cost alias post provider-specific usage, cache and batch context", async () => {
  for (const action of ["calculate", "cost"]) {
    let payload;
    await api(
      {
        "/v1/pricing/calculate": async (req, res) => {
          assert.equal(req.method, "POST");
          payload = await readBody(req);
          respond(cost())(req, res);
        },
      },
      async (s) => {
        const got = await runCli([
          ...args(action, s.origin),
          "--trace-format",
          "anthropic.messages",
          "--input-tokens",
          "1000",
          "--cache-read-tokens",
          "800",
          "--output-tokens",
          "200",
          "--batch",
          "--json",
        ]);
        assert.equal(got.code, 0);
        const d = parseJsonLine(got.stdout).data;
        assert.equal(d.result.cost, "0.00416000");
        assert.equal(typeof d.result.cost, "string");
        assert.deepEqual(payload, {
          contract_version: 2,
          format: "anthropic.messages",
          trace: {
            model: "example/model",
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 },
          },
          context: { channel: "example-api", at: TIME, service_tier: "batch" },
        });
      },
    );
  }
});

test("OpenAI payloads keep cache as part of total input; Anthropic keeps additive cache counts", () => {
  for (const format of ["openai.responses", "openai.chat_completions", "anthropic.messages", "otel.gen_ai"]) {
    const parsed = parseArgs([
      "pricing",
      "calculate",
      "--model",
      "example/model",
      "--trace-format",
      format,
      "--input-tokens",
      "1000",
      "--cache-read-tokens",
      "800",
      "--output-tokens",
      "200",
    ]);
    assert.equal(parsed.ok, true);
    const p = pricingPayload(parsed);
    if (format === "openai.responses")
      assert.deepEqual(p.trace.usage, {
        input_tokens: 1000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 800 },
      });
    if (format === "openai.chat_completions")
      assert.deepEqual(p.trace.usage, {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
      });
    if (format === "anthropic.messages")
      assert.deepEqual(p.trace.usage, { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 });
    if (format === "otel.gen_ai") assert.equal(p.trace.attributes["gen_ai.usage.cache_read.input_tokens"], 800);
  }
});

test("malformed counts and OpenAI cache exceeding total are rejected before network", async () => {
  for (const extra of [
    ["--trace-format", "openai.responses", "--input-tokens", "100", "--cache-read-tokens", "800"],
    ["--trace-format", "openai.chat_completions", "--input-tokens", "100", "--cache-read-tokens", "800"],
    ["--provider", "openai", "--input-tokens", "100", "--cache-read-tokens", "800"],
    ["--trace-format", "openai.responses", "--cache-read-tokens", "1"],
    ["--input-tokens", "-1"],
    ["--output-tokens", "1.5"],
  ]) {
    const got = await runCli(["pricing", "calculate", "--model", "example/model", ...extra, "--json"], {
      offline: true,
    });
    assert.equal(got.code, 2);
    assert.equal(got.stderr, "");
  }
  assert.equal(
    parseArgs([
      "pricing",
      "calculate",
      "--model",
      "example/model",
      "--trace-format",
      "anthropic.messages",
      "--input-tokens",
      "100",
      "--cache-read-tokens",
      "800",
    ]).ok,
    true,
  );
  assert.equal(
    parseArgs(["pricing", "calculate", "--model", "example/model", "--cache-write-tokens", "1"]).outcome,
    "unsupported",
  );
});

test("partial zero cost remains partial with missing usage, never labelled free or complete", async () => {
  const d = cost("partial");
  Object.assign(d.results[0], {
    cost: "0.00000000",
    components: Object.fromEntries(Object.keys(d.results[0].components).map((k) => [k, "0.00000000"])),
    missing_dimensions: ["input_tokens", "output_tokens"],
  });
  await api({ "/v1/pricing/calculate": respond(d) }, async (s) => {
    const got = await runCli(args("calculate", s.origin));
    assert.equal(got.code, 0);
    assert.match(got.stdout, /Status: partial/);
    assert.match(got.stdout, /known subtotal/);
    assert.match(got.stdout, /input_tokens, output_tokens/);
    assert.doesNotMatch(got.stdout, /\b(free|complete)\b/);
    const json = await runCli([...args("calculate", s.origin), "--json"]);
    const r = parseJsonLine(json.stdout).data.result;
    assert.equal(r.cost, "0.00000000");
    assert.equal(r.status, "partial");
  });
});

test("200 unpriced results remain unpriced, including missing channel and null cost", async () => {
  for (const action of ["lookup", "calculate"]) {
    const d = result();
    Object.assign(d.results[0], {
      status: "unpriced",
      price: null,
      model_id: null,
      currency: null,
      missing_dimensions: ["channel"],
      ...(action === "calculate" ? { contract_version: 2, fees: [], uncaptured_fees: false, cost: null, components: null } : {}),
    });
    await api({ [`/v1/pricing/${action}`]: respond(d) }, async (s) => {
      const got = await runCli(args(action, s.origin));
      assert.equal(got.code, 0);
      assert.match(got.stdout, /Status: unpriced/);
      assert.match(got.stdout, /missing channel/);
      assert.doesNotMatch(got.stdout, /Cost: 0/);
    });
  }
});

test("models discovery counts canonical entries and filters metadata locally without rates", async () => {
  const d = discovery();
  assert.equal(validateModels(d), true);
  await api({ "/v1/pricing/models": respond(d) }, async (s) => {
    const got = await runCli([
      "pricing",
      "models",
      "--channel",
      "example-api",
      "--limit",
      "1",
      "--url",
      s.origin,
      "--json",
    ]);
    assert.equal(got.code, 0);
    const r = parseJsonLine(got.stdout).data.result;
    assert.equal(r.total_models, 1);
    assert.equal(r.matched, 1);
    assert.equal(r.models[0].prices[0].input_per_mtok, undefined);
    assert.equal(s.requests[0].path, "/v1/pricing/models");
    assert.equal(s.requests.length, 1);
    const text = await runCli(["pricing", "models", "--url", s.origin]);
    assert.match(text.stdout, /Canonical models: 1/);
    assert.match(text.stdout, /Numeric rates require pricing lookup/);
  });
});

test("region fallback and effective date are disclosed without invented provenance", async () => {
  await api({ "/v1/pricing/lookup": respond(result()) }, async (s) => {
    const got = await runCli([...args("lookup", s.origin), "--region", "not-real"]);
    assert.equal(got.code, 0);
    assert.match(got.stdout, /Requested region: not-real/);
    assert.match(got.stdout, /resolved price region: global \(fallback\)/);
    assert.match(got.stdout, /does not report catalog version/);
  });
});

test("public history is explicitly unsupported without making any request", async () => {
  const got = await runCli(["pricing", "history", "--model", "example/model", "--channel", "example-api", "--json"], {
    offline: true,
  });
  assert.equal(got.code, 6);
  assert.equal(parseJsonLine(got.stdout).error.reason, "pricing_history_unavailable");
  assert.equal(
    parseArgs([
      "pricing",
      "history",
      "--model",
      "example/model",
      "--channel",
      "example-api",
      "--api",
      "reference",
      "--url",
      "https://example.com",
    ]).ok,
    false,
  );
});

test("public market uses discovery plus bounded lookups and never fabricates historical returns", async () => {
  const d = discovery();
  let count = 0;
  await api(
    {
      "/v1/pricing/models": respond(d),
      "/v1/pricing/lookup": async (req, res) => {
        count++;
        const body = await readBody(req);
        assert.equal(body.context.channel, "example-api");
        const r = result();
        r.results[0].effective_at = new Date().toISOString();
        respond(r)(req, res);
      },
    },
    async (s) => {
      const got = await runCli(["pricing", "market", "--channel", "example-api", "--limit", "1", "--url", s.origin]);
      assert.equal(got.code, 0);
      assert.equal(count, 1);
      assert.match(got.stdout, /History, returns and sparklines are unavailable/);
      assert.doesNotMatch(got.stdout, /%|[▁▂▃▄▅▆▇█]/u);
      const dated = await runCli([
        "pricing",
        "market",
        "--channel",
        "example-api",
        "--at",
        AT,
        "--url",
        s.origin,
        "--json",
      ]);
      assert.equal(dated.code, 6);
      assert.equal(parseJsonLine(dated.stdout).error.reason, "market_date_unsupported");
      assert.equal(count, 1);
    },
  );
});

test("public result validation rejects incomplete, inconsistent and mismatched rate documents", () => {
  const q = { model: "example/model", channel: "example-api", at: AT, input_tokens: 1000, output_tokens: 200 };
  assert.equal(validatePublicResult(cost(), "calculate", q), true);
  for (const mutate of [
    (d) => d.results.push(d.results[0]),
    (d) => (d.results[0].price.channel = "wrong"),
    (d) => (d.results[0].price.currency = ["USD"]),
    (d) => (d.results[0].price.input_per_mtok = "-1"),
    (d) => (d.results[0].components.input = "0"),
    (d) => (d.results[0].missing_dimensions = ["output_tokens"]),
    (d) => (d.results[0].effective_at = "2026-10-19T00:00:00Z"),
  ]) {
    const d = cost();
    mutate(d);
    assert.equal(validatePublicResult(d, "calculate", q), false);
  }
});

test("public transport rejects redirects, throttling, oversized and malformed results", async () => {
  for (const [status, body, extra, code] of [
    [302, "", { location: "https://example.com" }, 7],
    [429, "", {}, 16],
    [503, "", {}, 5],
    [422, "{}", {}, 2],
    [200, "{}", {}, 11],
    [200, "x".repeat(1024 * 1024 + 1), {}, 6],
  ]) {
    await api(
      {
        "/v1/pricing/lookup": (req, res) => {
          res.writeHead(status, { "content-type": "application/json", ...extra });
          res.end(body);
        },
      },
      async (s) => {
        const got = await runCli([...args("lookup", s.origin), "--json"]);
        assert.equal(got.code, code);
        assert.equal(got.stderr, "");
        parseJsonLine(got.stdout);
      },
    );
  }
});

test("market concurrency is bounded and throttling never returns a partial board as complete", async () => {
  const d = discovery();
  d.models = Array.from({length: 5}, (_, i) => ({...structuredClone(MODEL), model_id: `example/model-${i}`}));
  let active = 0, maxActive = 0, count = 0;
  await api({
    "/v1/pricing/models": respond(d),
    "/v1/pricing/lookup": async (req, res) => {
      await readBody(req);
      count++; active++; maxActive = Math.max(maxActive, active);
      if (count === 1) {
        res.writeHead(429); res.end(); active--;
      } else {
        setTimeout(() => { active--; const r = result(); r.results[0].effective_at = new Date().toISOString(); respond(r)(req,res); }, 30);
      }
    },
  }, async s => {
    const got = await runCli(["pricing", "market", "--channel", "example-api", "--limit", "5", "--url", s.origin, "--json"]);
    assert.equal(got.code, 16);
    assert.equal(parseJsonLine(got.stdout).data, null);
    assert.ok(count <= 3); assert.ok(maxActive <= 3);
  });
});

function withSearch() {
  const d = cost();
  Object.assign(d.results[0], {
    cost: "0.05416000",
    components: { ...d.results[0].components, search: "0.05000000" },
    fees: [{ operation: "web_search", tool: "web_search", channel: "example-api", unit: "search", quantity: 5,
      rate_per_1k: "10", currency: "USD", cost: "0.05000000", price_id: "search-price", source_url: "https://example.com/search-pricing",
      effective_from: "2026-01-01", effective_to: null, region: "global", catalog_version: "2026-10-20", catalog_hash: "synthetic-hash" }],
  });
  return d;
}

test("v2 search fees reconcile exactly and preserve effective provenance", () => {
  const q = { at: AT, channel: "example-api", input_tokens: 1000, output_tokens: 200, contract_version: 2 };
  assert.equal(validatePublicResult(withSearch(), "calculate", q), true);
  for (const mutate of [
    d => d.results[0].fees[0].quantity = 1.5,
    d => d.results[0].fees[0].quantity = -1,
    d => d.results[0].fees[0].rate_per_1k = "11",
    d => d.results[0].fees[0].cost = "0.04",
    d => d.results[0].fees[0].source_url = "javascript:alert(1)",
    d => d.results[0].fees[0].channel = "wrong-api",
    d => d.results[0].fees[0].effective_to = "2026-01-02",
    d => d.results[0].fees[0].effective_from = "2027-01-01",
    d => d.results[0].uncaptured_fees = true,
    d => d.results[0].fees = [],
    d => delete d.results[0].contract_version,
  ]) {
    const d = withSearch(); mutate(d);
    assert.equal(validatePublicResult(d, "calculate", q), false);
  }
});

test("search counts and legacy mode remain explicit with no silent downgrade", async () => {
  const parsed = parseArgs(["pricing", "calculate", "--model", "example/model", "--provider", "anthropic", "--web-search-requests", "0"]);
  assert.equal(parsed.ok, true);
  assert.equal(pricingPayload(parsed).contract_version, 2);
  assert.equal(pricingPayload(parsed).trace.usage.server_tool_use.web_search_requests, 0);
  for (const value of ["-1", "1.5", "1e3", "true", "1000000000000"])
    assert.equal(parseArgs(["pricing", "cost", "--model", "example/model", "--provider", "anthropic", "--web-search-requests", value]).ok, false);
  assert.equal(parseArgs(["pricing", "cost", "--model", "example/model", "--provider", "openai", "--web-search-requests", "1"]).ok, false);
  const old = cost();
  delete old.results[0].contract_version;
  delete old.results[0].components.search;
  delete old.results[0].fees;
  delete old.results[0].uncaptured_fees;
  await api({ "/v1/pricing/calculate": respond(old) }, async s => {
    const base = [...args("calculate", s.origin), "--input-tokens", "1000", "--output-tokens", "200", "--json"];
    const rejected = await runCli(base);
    assert.equal(rejected.code, 11);
    const legacy = await runCli([...base, "--contract-version", "1"]);
    assert.equal(legacy.code, 0);
    assert.equal(parseJsonLine(legacy.stdout).data.result.cost, "0.00416000");
  });
});


test("malformed unpriced fees and legacy hidden search fees are refused", () => {
  const d = cost();
  Object.assign(d.results[0], { status: "unpriced", cost: null, components: null, price: null, model_id: null, currency: null,
    fees: [null], missing_dimensions: ["model"] });
  assert.equal(validatePublicResult(d, "calculate", { at: AT, contract_version: 2 }), false);
  const old = cost();
  delete old.results[0].contract_version;
  delete old.results[0].components.search;
  delete old.results[0].fees;
  delete old.results[0].uncaptured_fees;
  const q = { at: AT, contract_version: 1, input_tokens: 1000, output_tokens: 200, web_search_requests: 5 };
  assert.equal(validatePublicResult(old, "calculate", q), false);
  old.results[0].status = "partial";
  old.results[0].missing_dimensions = ["search.contract_version"];
  assert.equal(validatePublicResult(old, "calculate", q), true);
  old.results[0].fees = [null];
  assert.equal(validatePublicResult(old, "calculate", q), false);
});
