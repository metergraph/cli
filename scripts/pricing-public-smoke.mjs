// Opt-in, unauthenticated live checks. No CI network dependency, credentials or provider calls.
// Set PRICING_PUBLIC_ORIGIN explicitly; PRICING_BIN may select the packed CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOrigin } from "../src/origin.js";
const origin = parseOrigin(process.env.PRICING_PUBLIC_ORIGIN);
if (!origin) throw new Error("Set PRICING_PUBLIC_ORIGIN to the public Pricing API origin.");
const bin = process.env.PRICING_BIN ?? fileURLToPath(new URL("../bin/metergraph.js", import.meta.url));
async function cli(args, expected = 0) {
  const got = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, "pricing", ...args, "--url", origin, "--json"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("Live pricing command exceeded deadline."));
    }, 30000);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
  assert.equal(got.code, expected, got.out);
  assert.equal(got.err, "");
  return JSON.parse(got.out);
}
const date = ["--at", "2026-10-21"];
const models = await cli(["models", "--limit", "2"]);
assert.ok(models.data.result.total_models > 0);
assert.equal(models.data.result.models.length, 2);
const lookup = await cli(["lookup", "--model", "gpt-5", "--provider", "openai", "--region", "global", ...date]);
assert.equal(lookup.data.result.price.input_per_mtok, "1.25");
assert.equal(lookup.data.result.cost, undefined);
const anth = ["--model", "claude-sonnet-5", "--provider", "anthropic", "--region", "global", ...date];
const native = await cli([
  "calculate",
  ...anth,
  "--input-tokens",
  "1000",
  "--cache-read-tokens",
  "800",
  "--output-tokens",
  "200",
]);
assert.equal(native.data.result.cost, "0.00416000");
for (const format of ["openai.responses", "openai.chat_completions"]) {
  const c = await cli([
    "cost",
    "--model",
    "gpt-5",
    "--provider",
    "openai",
    "--region",
    "global",
    "--trace-format",
    format,
    "--input-tokens",
    "1000",
    "--cache-read-tokens",
    "800",
    "--output-tokens",
    "200",
    ...date,
  ]);
  assert.equal(c.data.result.cost, "0.00235000");
}
const batch = await cli(["calculate", ...anth, "--input-tokens", "1000", "--output-tokens", "200", "--batch"]);
assert.equal(batch.data.result.cost, "0.00200000");
const partial = await cli(["calculate", ...anth]);
assert.equal(partial.data.result.status, "partial");
assert.equal(partial.data.result.cost, "0.00000000");
assert.deepEqual(partial.data.result.missing_dimensions, ["input_tokens", "output_tokens"]);
const missing = await cli(["lookup", "--model", "gpt-5", ...date]);
assert.equal(missing.data.result.status, "unpriced");
assert.deepEqual(missing.data.result.missing_dimensions, ["channel"]);
const unknown = await cli(["lookup", "--model", "example/nonexistent", "--provider", "openai", ...date]);
assert.equal(unknown.data.result.status, "unpriced");
assert.equal(unknown.data.result.price, null);
const region = await cli(["lookup", "--model", "gpt-5", "--provider", "openai", "--region", "not-real", ...date]);
assert.equal(region.data.result.price.region, "global");
const market = await cli(["market", "--channel", "openai-api", "--limit", "2"]);
assert.equal(market.data.result.items.length, 2);
assert.equal(market.data.result.history_available, false);
const history = await cli(["history", "--model", "openai/gpt-5", "--channel", "openai-api"], 6);
assert.equal(history.error.reason, "pricing_history_unavailable");
const invalid = await cli(
  ["calculate", "--model", "gpt-5", "--provider", "openai", "--input-tokens", "100", "--cache-read-tokens", "800"],
  2,
);
assert.equal(invalid.error.reason, "invalid_cached_input");
console.log(
  `13 public API checks passed; discovery reported ${models.data.result.total_models} canonical models. This is preview validation, not supplier pricing or storage verification.`,
);
